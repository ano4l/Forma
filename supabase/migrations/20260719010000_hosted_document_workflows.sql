-- Atomic hosted document workflows. All functions are security invoker and also
-- perform an explicit membership check; table RLS remains the final boundary.

create or replace function public.create_document_record(
  target_workspace uuid,
  target_id text,
  target_type text,
  target_year integer,
  requested_number text,
  target_customer_id text,
  target_source_document_id text,
  target_recurring_schedule_id text,
  target_data jsonb,
  target_totals jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  assigned_number text;
  created_document public.documents;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  assigned_number := nullif(trim(requested_number), '');
  if assigned_number is null then assigned_number := public.allocate_document_number(target_workspace, target_type, target_year); end if;
  target_data := jsonb_set(coalesce(target_data, '{}'::jsonb), '{number}', to_jsonb(assigned_number), true);
  insert into public.documents (
    workspace_id, id, document_type, number, number_year, status, customer_id,
    source_document_id, recurring_schedule_id, data_json, totals_json, snapshot_json,
    amount_paid_minor, balance_due_minor
  ) values (
    target_workspace, target_id, target_type, assigned_number, target_year, 'draft', target_customer_id,
    target_source_document_id, target_recurring_schedule_id, target_data, target_totals, null,
    0, coalesce((target_totals ->> 'total_minor')::integer, 0)
  ) returning * into created_document;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, target_id, 'created', jsonb_build_object('number', assigned_number, 'document_type', target_type));
  return to_jsonb(created_document);
end;
$$;

create or replace function public.finalize_document_record(
  target_workspace uuid,
  target_id text,
  target_status text,
  target_data jsonb,
  target_totals jsonb,
  target_snapshot jsonb,
  target_balance integer,
  sent_event boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_document public.documents;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  select * into current_document from public.documents where workspace_id = target_workspace and id = target_id for update;
  if current_document.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if current_document.status <> 'draft' then raise exception 'Only drafts can be finalized' using errcode = '23514'; end if;
  update public.documents set
    status = target_status, data_json = target_data, totals_json = target_totals,
    snapshot_json = target_snapshot, balance_due_minor = target_balance,
    issued_at = now(), finalized_at = case when document_type = 'invoice' then now() else null end,
    updated_at = now()
  where workspace_id = target_workspace and id = target_id
  returning * into current_document;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, target_id, case when current_document.document_type = 'receipt' then 'issued' else 'finalized' end, '{}'::jsonb);
  if sent_event then
    insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
    values (target_workspace, target_id, 'sent', jsonb_build_object('delivery', 'provider'));
  end if;
  return to_jsonb(current_document);
end;
$$;

create or replace function public.transition_document_record(
  target_workspace uuid,
  target_id text,
  expected_status text,
  target_status text,
  event_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_document public.documents;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  update public.documents set status = target_status, updated_at = now()
  where workspace_id = target_workspace and id = target_id and status = expected_status
  returning * into changed_document;
  if changed_document.id is null then raise exception 'Document changed before the transition completed' using errcode = '40001'; end if;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, target_id, event_type, '{}'::jsonb);
  return to_jsonb(changed_document);
end;
$$;

create or replace function public.convert_quote_record(
  target_workspace uuid,
  quote_id text,
  invoice_id text,
  invoice_year integer,
  invoice_data jsonb,
  invoice_totals jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  quote_document public.documents;
  invoice_document public.documents;
  assigned_number text;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  select * into quote_document from public.documents where workspace_id = target_workspace and id = quote_id for update;
  if quote_document.id is null or quote_document.document_type <> 'quote' then raise exception 'Quote not found' using errcode = 'P0002'; end if;
  if quote_document.status <> 'accepted' then raise exception 'Only accepted quotes can be converted' using errcode = '23514'; end if;
  if exists (select 1 from public.documents where workspace_id = target_workspace and source_document_id = quote_id) then raise exception 'Quote has already been converted' using errcode = '23505'; end if;
  assigned_number := public.allocate_document_number(target_workspace, 'invoice', invoice_year);
  invoice_data := jsonb_set(invoice_data, '{number}', to_jsonb(assigned_number), true);
  insert into public.documents (
    workspace_id, id, document_type, number, number_year, status, customer_id,
    source_document_id, data_json, totals_json, amount_paid_minor, balance_due_minor
  ) values (
    target_workspace, invoice_id, 'invoice', assigned_number, invoice_year, 'draft', quote_document.customer_id,
    quote_id, invoice_data, invoice_totals, 0, coalesce((invoice_totals ->> 'total_minor')::integer, 0)
  ) returning * into invoice_document;
  update public.documents set status = 'converted', updated_at = now() where workspace_id = target_workspace and id = quote_id;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json) values
    (target_workspace, quote_id, 'converted', jsonb_build_object('invoice_id', invoice_id)),
    (target_workspace, invoice_id, 'created', jsonb_build_object('number', assigned_number, 'document_type', 'invoice')),
    (target_workspace, invoice_id, 'created_from_quote', jsonb_build_object('quote_id', quote_id));
  return to_jsonb(invoice_document);
end;
$$;

create or replace function public.record_invoice_payment(
  target_workspace uuid,
  invoice_id text,
  payment_id text,
  payment_amount integer,
  payment_method text,
  payment_reference text,
  payment_received_date date,
  payment_notes text,
  receipt_id text default null,
  receipt_year integer default null,
  receipt_data jsonb default null,
  receipt_totals jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  invoice_document public.documents;
  receipt_document public.documents;
  payment_record public.payments;
  receipt_number text;
  new_paid integer;
  new_balance integer;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  select * into invoice_document from public.documents where workspace_id = target_workspace and id = invoice_id for update;
  if invoice_document.id is null or invoice_document.document_type <> 'invoice' then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  if invoice_document.status not in ('finalized', 'sent', 'partially_paid', 'overdue') then raise exception 'Payments require an issued invoice' using errcode = '23514'; end if;
  if payment_amount <= 0 or payment_amount > invoice_document.balance_due_minor then raise exception 'Payment amount is outside the outstanding balance' using errcode = '23514'; end if;

  if receipt_id is not null then
    receipt_number := public.allocate_document_number(target_workspace, 'receipt', receipt_year);
    receipt_data := jsonb_set(receipt_data, '{number}', to_jsonb(receipt_number), true);
    insert into public.documents (
      workspace_id, id, document_type, number, number_year, status, customer_id,
      data_json, totals_json, snapshot_json, amount_paid_minor, balance_due_minor, issued_at
    ) values (
      target_workspace, receipt_id, 'receipt', receipt_number, receipt_year, 'issued', invoice_document.customer_id,
      receipt_data, receipt_totals, receipt_data || jsonb_build_object('totals', receipt_totals, 'issued_at', now()),
      0, coalesce((receipt_totals ->> 'total_minor')::integer, 0), now()
    ) returning * into receipt_document;
    insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
    values (target_workspace, receipt_id, 'issued', jsonb_build_object('payment_for', invoice_id));
  end if;

  insert into public.payments (workspace_id, id, invoice_id, receipt_id, amount_minor, method, reference, received_date, notes)
  values (target_workspace, payment_id, invoice_id, receipt_id, payment_amount, payment_method, payment_reference, payment_received_date, payment_notes)
  returning * into payment_record;
  new_paid := invoice_document.amount_paid_minor + payment_amount;
  new_balance := coalesce((invoice_document.totals_json ->> 'total_minor')::integer, 0) - new_paid;
  update public.documents set amount_paid_minor = new_paid, balance_due_minor = new_balance,
    status = case when new_balance = 0 then 'paid' else 'partially_paid' end, updated_at = now()
  where workspace_id = target_workspace and id = invoice_id returning * into invoice_document;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, invoice_id, 'payment_recorded', jsonb_build_object('payment_id', payment_id, 'receipt_id', receipt_id, 'amount_minor', payment_amount, 'method', payment_method));
  return jsonb_build_object('payment', to_jsonb(payment_record), 'receipt', case when receipt_id is null then null else to_jsonb(receipt_document) end, 'invoice', to_jsonb(invoice_document));
end;
$$;

revoke all on function public.create_document_record(uuid, text, text, integer, text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.finalize_document_record(uuid, text, text, jsonb, jsonb, jsonb, integer, boolean) from public;
revoke all on function public.transition_document_record(uuid, text, text, text, text) from public;
revoke all on function public.convert_quote_record(uuid, text, text, integer, jsonb, jsonb) from public;
revoke all on function public.record_invoice_payment(uuid, text, text, integer, text, text, date, text, text, integer, jsonb, jsonb) from public;
grant execute on function public.create_document_record(uuid, text, text, integer, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.finalize_document_record(uuid, text, text, jsonb, jsonb, jsonb, integer, boolean) to service_role;
grant execute on function public.transition_document_record(uuid, text, text, text, text) to service_role;
grant execute on function public.convert_quote_record(uuid, text, text, integer, jsonb, jsonb) to service_role;
grant execute on function public.record_invoice_payment(uuid, text, text, integer, text, text, date, text, text, integer, jsonb, jsonb) to service_role;

create or replace function public.begin_email_delivery_record(
  target_workspace uuid, target_id text, target_document_id text, target_request_key text,
  target_recipients jsonb, target_template_purpose text, target_provider text, target_rendered jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery public.email_delivery_attempts;
  inserted boolean := false;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  insert into public.email_delivery_attempts (
    workspace_id, id, document_id, request_key, recipients_json, template_purpose,
    provider, provider_status, rendered_json
  ) values (
    target_workspace, target_id, target_document_id, target_request_key, target_recipients,
    target_template_purpose, target_provider, 'sending', target_rendered
  ) on conflict (document_id, request_key) do nothing returning * into delivery;
  if delivery.id is not null then
    inserted := true;
    insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
    values (target_workspace, target_document_id, 'email_send_started', jsonb_build_object('attempt_id', target_id, 'provider', target_provider, 'recipients', target_recipients));
  else
    select * into delivery from public.email_delivery_attempts
    where workspace_id = target_workspace and document_id = target_document_id and request_key = target_request_key;
  end if;
  return jsonb_build_object('attempt', to_jsonb(delivery), 'inserted', inserted);
end;
$$;

create or replace function public.complete_email_delivery_record(
  target_workspace uuid, target_document_id text, target_attempt_id text,
  delivery_accepted boolean, delivery_status text, delivery_message_id text, delivery_error text,
  finalize_status text default null, finalize_data jsonb default null,
  finalize_totals jsonb default null, finalize_snapshot jsonb default null,
  finalize_balance integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery public.email_delivery_attempts;
  current_document public.documents;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  select * into delivery from public.email_delivery_attempts
  where workspace_id = target_workspace and id = target_attempt_id and document_id = target_document_id for update;
  if delivery.id is null then raise exception 'Email attempt not found' using errcode = 'P0002'; end if;
  if delivery.provider_status <> 'sending' then return to_jsonb(delivery); end if;
  if delivery_accepted then
    select * into current_document from public.documents where workspace_id = target_workspace and id = target_document_id;
    if current_document.status = 'draft' then
      perform public.finalize_document_record(target_workspace, target_document_id, finalize_status, finalize_data, finalize_totals, finalize_snapshot, finalize_balance, true);
    end if;
    update public.email_delivery_attempts set provider_status = delivery_status,
      provider_message_id = delivery_message_id, provider_error = null
    where workspace_id = target_workspace and id = target_attempt_id returning * into delivery;
    insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
    values (target_workspace, target_document_id, 'email_send_accepted', jsonb_build_object('attempt_id', target_attempt_id, 'provider', delivery.provider, 'provider_message_id', delivery_message_id));
  else
    update public.email_delivery_attempts set provider_status = delivery_status, provider_error = delivery_error
    where workspace_id = target_workspace and id = target_attempt_id returning * into delivery;
    insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
    values (target_workspace, target_document_id, 'email_send_failed', jsonb_build_object('attempt_id', target_attempt_id, 'provider', delivery.provider));
  end if;
  return to_jsonb(delivery);
end;
$$;

create or replace function public.claim_reminder_delivery_record(
  target_workspace uuid, target_id text, target_document_id text, target_rule_id text,
  target_due_date date, target_scheduled_for date, skipped_deliveries jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  skipped jsonb;
  delivery public.document_reminder_deliveries;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  for skipped in select * from jsonb_array_elements(coalesce(skipped_deliveries, '[]'::jsonb)) loop
    insert into public.document_reminder_deliveries (
      workspace_id, id, document_id, rule_id, due_date, scheduled_for, status, provider_error
    ) values (
      target_workspace, coalesce(skipped ->> 'id', gen_random_uuid()::text), target_document_id,
      skipped ->> 'rule_id', target_due_date, (skipped ->> 'scheduled_for')::date,
      'skipped_catchup', 'A newer reminder was already due during catch-up.'
    ) on conflict (document_id, rule_id, due_date) do nothing;
  end loop;
  insert into public.document_reminder_deliveries (
    workspace_id, id, document_id, rule_id, due_date, scheduled_for, status
  ) values (
    target_workspace, target_id, target_document_id, target_rule_id, target_due_date, target_scheduled_for, 'sending'
  ) on conflict (document_id, rule_id, due_date) do nothing
  returning * into delivery;
  if delivery.id is null then
    select * into delivery from public.document_reminder_deliveries
    where workspace_id = target_workspace and document_id = target_document_id and rule_id = target_rule_id and due_date = target_due_date;
    return jsonb_build_object('claimed', false, 'delivery', to_jsonb(delivery));
  end if;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, target_document_id, 'reminder_send_started', jsonb_build_object('rule_id', target_rule_id, 'due_date', target_due_date, 'scheduled_for', target_scheduled_for));
  return jsonb_build_object('claimed', true, 'delivery', to_jsonb(delivery));
end;
$$;

create or replace function public.complete_reminder_delivery_record(
  target_workspace uuid, target_delivery_id text, target_attempt_id text,
  target_status text, target_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery public.document_reminder_deliveries;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  update public.document_reminder_deliveries set attempt_id = target_attempt_id,
    status = target_status, provider_error = target_error, updated_at = now()
  where workspace_id = target_workspace and id = target_delivery_id returning * into delivery;
  if delivery.id is null then raise exception 'Reminder delivery not found' using errcode = 'P0002'; end if;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, delivery.document_id,
    case when target_status like 'accepted%' then 'reminder_send_accepted' else 'reminder_send_failed' end,
    jsonb_build_object('rule_id', delivery.rule_id, 'due_date', delivery.due_date, 'attempt_id', target_attempt_id));
  return to_jsonb(delivery);
end;
$$;

create or replace function public.create_recurring_run_record(
  target_workspace uuid, target_schedule_id text, target_run_date date,
  target_document_id text, target_document_year integer, target_data jsonb,
  target_totals jsonb, target_next_run_on date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  schedule public.recurring_schedules;
  existing_run public.recurring_schedule_runs;
  created_document jsonb;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  select * into schedule from public.recurring_schedules
  where workspace_id = target_workspace and id = target_schedule_id for update;
  if schedule.id is null then raise exception 'Recurring schedule not found' using errcode = 'P0002'; end if;
  select * into existing_run from public.recurring_schedule_runs
  where workspace_id = target_workspace and schedule_id = target_schedule_id and run_date = target_run_date;
  if existing_run.id is not null then
    update public.recurring_schedules set next_run_on = target_next_run_on, updated_at = now()
    where workspace_id = target_workspace and id = target_schedule_id;
    return jsonb_build_object('created', false, 'document', null);
  end if;
  if not schedule.active or schedule.next_run_on <> target_run_date then raise exception 'Recurring schedule changed before the run' using errcode = '40001'; end if;
  created_document := public.create_document_record(target_workspace, target_document_id, 'invoice', target_document_year, '',
    (target_data ->> 'customer_id'), null, target_schedule_id, target_data, target_totals);
  insert into public.recurring_schedule_runs (workspace_id, id, schedule_id, run_date, document_id)
  values (target_workspace, gen_random_uuid()::text, target_schedule_id, target_run_date, target_document_id);
  update public.recurring_schedules set last_run_on = target_run_date, next_run_on = target_next_run_on,
    generated_count = generated_count + 1, updated_at = now()
  where workspace_id = target_workspace and id = target_schedule_id;
  insert into public.document_audit_events (workspace_id, document_id, type, detail_json)
  values (target_workspace, target_document_id, 'recurring_generated', jsonb_build_object('schedule_id', target_schedule_id, 'run_date', target_run_date));
  return jsonb_build_object('created', true, 'document', created_document);
end;
$$;

revoke all on function public.begin_email_delivery_record(uuid, text, text, text, jsonb, text, text, jsonb) from public;
revoke all on function public.complete_email_delivery_record(uuid, text, text, boolean, text, text, text, text, jsonb, jsonb, jsonb, integer) from public;
revoke all on function public.claim_reminder_delivery_record(uuid, text, text, text, date, date, jsonb) from public;
revoke all on function public.complete_reminder_delivery_record(uuid, text, text, text, text) from public;
revoke all on function public.create_recurring_run_record(uuid, text, date, text, integer, jsonb, jsonb, date) from public;
grant execute on function public.begin_email_delivery_record(uuid, text, text, text, jsonb, text, text, jsonb) to service_role;
grant execute on function public.complete_email_delivery_record(uuid, text, text, boolean, text, text, text, text, jsonb, jsonb, jsonb, integer) to service_role;
grant execute on function public.claim_reminder_delivery_record(uuid, text, text, text, date, date, jsonb) to service_role;
grant execute on function public.complete_reminder_delivery_record(uuid, text, text, text, text) to service_role;
grant execute on function public.create_recurring_run_record(uuid, text, date, text, integer, jsonb, jsonb, date) to service_role;

create or replace function public.save_payment_method_record(
  target_workspace uuid, target_id text, target_name text, target_method_type text,
  target_details jsonb, target_active boolean, requested_default boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_method public.payment_methods;
  saved_method public.payment_methods;
  make_default boolean;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_workspace::text || ':payment-default', 0));
  if exists (select 1 from public.payment_methods where id = target_id and workspace_id <> target_workspace) then raise exception 'Payment method belongs to another workspace' using errcode = '42501'; end if;
  select * into existing_method from public.payment_methods where workspace_id = target_workspace and id = target_id;
  make_default := coalesce(requested_default, existing_method.is_default,
    not exists (select 1 from public.payment_methods where workspace_id = target_workspace and active and is_default));
  if make_default then update public.payment_methods set is_default = false, updated_at = now() where workspace_id = target_workspace and is_default; end if;
  insert into public.payment_methods (workspace_id, id, name, method_type, details_json, active, is_default)
  values (target_workspace, target_id, target_name, target_method_type, target_details, target_active, make_default)
  on conflict (id) do update set name = excluded.name, method_type = excluded.method_type,
    details_json = excluded.details_json, active = excluded.active, is_default = excluded.is_default, updated_at = now()
  returning * into saved_method;
  return to_jsonb(saved_method);
end;
$$;

create or replace function public.set_default_payment_method_record(target_workspace uuid, target_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_method public.payment_methods;
begin
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then raise exception 'Workspace write access required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_workspace::text || ':payment-default', 0));
  if not exists (select 1 from public.payment_methods where workspace_id = target_workspace and id = target_id) then raise exception 'Payment method not found' using errcode = 'P0002'; end if;
  update public.payment_methods set is_default = false, updated_at = now() where workspace_id = target_workspace and is_default;
  update public.payment_methods set is_default = true, active = true, updated_at = now()
  where workspace_id = target_workspace and id = target_id returning * into saved_method;
  return to_jsonb(saved_method);
end;
$$;

revoke all on function public.save_payment_method_record(uuid, text, text, text, jsonb, boolean, boolean) from public;
revoke all on function public.set_default_payment_method_record(uuid, text) from public;
grant execute on function public.save_payment_method_record(uuid, text, text, text, jsonb, boolean, boolean) to service_role;
grant execute on function public.set_default_payment_method_record(uuid, text) to service_role;
