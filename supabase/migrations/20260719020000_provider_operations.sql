alter table public.email_delivery_attempts add column if not exists next_retry_at timestamptz;
alter table public.email_delivery_attempts add column if not exists updated_at timestamptz;

create table if not exists public.provider_webhook_events (
  provider text not null,
  event_id text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  event_type text not null,
  object_id text,
  payload_json jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table if not exists public.email_suppressions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  reason text not null,
  provider text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

create table if not exists public.payment_checkouts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text primary key,
  invoice_id text not null references public.documents(id) on delete cascade,
  provider text not null check (provider in ('stripe','paypal')),
  provider_checkout_id text,
  provider_payment_id text,
  request_key text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  status text not null,
  checkout_url text,
  provider_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (workspace_id, request_key),
  unique (provider, provider_checkout_id)
);

alter table public.provider_webhook_events enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.payment_checkouts enable row level security;
revoke all on public.provider_webhook_events, public.email_suppressions, public.payment_checkouts from anon, authenticated;
grant select on public.payment_checkouts to authenticated;
create policy payment_checkouts_workspace_select on public.payment_checkouts for select to authenticated using (public.is_workspace_member(workspace_id));

create or replace function public.begin_payment_checkout_record(target_workspace uuid, target_id text, target_invoice_id text, target_provider text, target_request_key text, target_amount integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare invoice public.documents; existing_checkout public.payment_checkouts; saved public.payment_checkouts; currency_code text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  select * into existing_checkout from public.payment_checkouts where workspace_id=target_workspace and request_key=target_request_key;
  if found then
    if existing_checkout.invoice_id<>target_invoice_id or existing_checkout.provider<>target_provider or existing_checkout.amount_minor<>target_amount then raise exception 'request_key was already used for different payment link parameters' using errcode='23505'; end if;
    return jsonb_build_object('inserted',false,'checkout',to_jsonb(existing_checkout));
  end if;
  select * into invoice from public.documents where workspace_id=target_workspace and id=target_invoice_id and document_type='invoice' for update;
  if not found then raise exception 'Invoice not found' using errcode='P0002'; end if;
  if invoice.status not in ('finalized','sent','partially_paid','overdue') or invoice.balance_due_minor <= 0 then raise exception 'Only an issued invoice with an outstanding balance can be paid' using errcode='23514'; end if;
  if target_amount <= 0 or target_amount > invoice.balance_due_minor then raise exception 'Payment amount exceeds the outstanding balance' using errcode='23514'; end if;
  currency_code := upper(coalesce(invoice.snapshot_json->>'currency',invoice.data_json->>'currency','ZAR'));
  insert into public.payment_checkouts(workspace_id,id,invoice_id,provider,request_key,amount_minor,currency,status) values(target_workspace,target_id,target_invoice_id,target_provider,target_request_key,target_amount,currency_code,'creating') returning * into saved;
  return jsonb_build_object('inserted',true,'checkout',to_jsonb(saved));
end $$;

create or replace function public.complete_payment_checkout_record(target_workspace uuid, target_id text, target_provider_checkout_id text, target_checkout_url text, target_status text, target_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved public.payment_checkouts;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  update public.payment_checkouts set provider_checkout_id=coalesce(target_provider_checkout_id,provider_checkout_id),checkout_url=coalesce(target_checkout_url,checkout_url),status=case when target_error is null then target_status else 'failed' end,provider_error=target_error,updated_at=now() where workspace_id=target_workspace and id=target_id returning * into saved;
  if not found then raise exception 'Payment checkout not found' using errcode='P0002'; end if;
  return to_jsonb(saved);
end $$;

create or replace function public.process_resend_provider_event(target_event_id text,target_event_type text,target_message_id text,target_status text,target_terminal boolean,target_recipients jsonb,target_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare attempt public.email_delivery_attempts; inserted_count integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into attempt from public.email_delivery_attempts where provider='resend' and provider_message_id=target_message_id limit 1 for update;
  insert into public.provider_webhook_events(provider,event_id,workspace_id,event_type,object_id,payload_json) values('resend',target_event_id,attempt.workspace_id,target_event_type,target_message_id,target_payload) on conflict do nothing;
  get diagnostics inserted_count = row_count; if inserted_count=0 then return jsonb_build_object('duplicate',true); end if;
  if attempt.id is not null then
    update public.email_delivery_attempts set provider_status=target_status,provider_error=case when target_terminal then 'Resend reported '||target_status else null end,next_retry_at=case when target_status='delayed' then now()+interval '15 minutes' else null end,updated_at=now() where workspace_id=attempt.workspace_id and id=attempt.id;
    if target_terminal then insert into public.email_suppressions(workspace_id,email,reason,provider) select attempt.workspace_id,lower(value),target_status,'resend' from jsonb_array_elements_text(case when jsonb_array_length(coalesce(target_recipients,'[]'::jsonb))>0 then target_recipients else attempt.recipients_json end) on conflict(workspace_id,email) do update set reason=excluded.reason,provider=excluded.provider,updated_at=now(); end if;
    insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(attempt.workspace_id,attempt.document_id,'email_'||target_status,jsonb_build_object('attempt_id',attempt.id,'event_id',target_event_id));
  end if;
  return jsonb_build_object('duplicate',false,'matched',attempt.id is not null);
end $$;

create or replace function public.process_payment_provider_event(target_provider text,target_event_id text,target_event_type text,target_checkout_id text,target_provider_checkout_id text,target_provider_payment_id text,target_amount integer,target_currency text,target_success boolean,target_failed boolean,target_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare checkout public.payment_checkouts; invoice public.documents; payment_id text; inserted_count integer; paid integer; balance integer; next_status text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if target_checkout_id is not null then select * into checkout from public.payment_checkouts where provider=target_provider and id=target_checkout_id for update; else select * into checkout from public.payment_checkouts where provider=target_provider and provider_checkout_id=target_provider_checkout_id for update; end if;
  if checkout.id is not null and target_success and (target_amount is distinct from checkout.amount_minor or upper(target_currency) is distinct from checkout.currency) then raise exception 'Provider payment amount or currency does not match the checkout' using errcode='23514'; end if;
  insert into public.provider_webhook_events(provider,event_id,workspace_id,event_type,object_id,payload_json) values(target_provider,target_event_id,checkout.workspace_id,target_event_type,coalesce(target_provider_checkout_id,target_provider_payment_id),target_payload) on conflict do nothing;
  get diagnostics inserted_count = row_count; if inserted_count=0 then return jsonb_build_object('duplicate',true); end if;
  if checkout.id is null then return jsonb_build_object('duplicate',false,'matched',false); end if;
  if target_success and checkout.status <> 'paid' then
    select * into invoice from public.documents where workspace_id=checkout.workspace_id and id=checkout.invoice_id for update;
    if invoice.status not in ('finalized','sent','partially_paid','overdue') or checkout.amount_minor > invoice.balance_due_minor then raise exception 'Invoice can no longer accept this payment' using errcode='23514'; end if;
    payment_id := gen_random_uuid()::text;
    insert into public.payments(workspace_id,id,invoice_id,amount_minor,method,reference,received_date,notes) values(checkout.workspace_id,payment_id,checkout.invoice_id,checkout.amount_minor,case when target_provider='stripe' then 'Stripe' else 'PayPal' end,coalesce(target_provider_payment_id,checkout.provider_checkout_id),current_date,'Automatically reconciled from '||target_provider);
    paid := invoice.amount_paid_minor+checkout.amount_minor; balance := greatest(0,(invoice.totals_json->>'total_minor')::integer-paid); next_status := case when balance=0 then 'paid' else 'partially_paid' end;
    update public.documents set amount_paid_minor=paid,balance_due_minor=balance,status=next_status,updated_at=now() where workspace_id=checkout.workspace_id and id=checkout.invoice_id;
    update public.payment_checkouts set status='paid',provider_payment_id=target_provider_payment_id,provider_error=null,paid_at=now(),updated_at=now() where id=checkout.id;
    insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(checkout.workspace_id,checkout.invoice_id,'payment_recorded',jsonb_build_object('payment_id',payment_id,'checkout_id',checkout.id,'amount_minor',checkout.amount_minor,'provider',target_provider));
  elsif target_failed and checkout.status <> 'paid' then update public.payment_checkouts set status='failed',provider_error=target_provider||' reported '||target_event_type,updated_at=now() where id=checkout.id; end if;
  return jsonb_build_object('duplicate',false,'matched',true,'checkout_id',checkout.id);
end $$;

create or replace function public.get_payment_checkout_for_capture(target_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare checkout public.payment_checkouts;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into checkout from public.payment_checkouts where id=target_id;
  if not found then raise exception 'Payment checkout not found' using errcode='P0002'; end if;
  return to_jsonb(checkout);
end $$;

revoke all on function public.begin_payment_checkout_record(uuid,text,text,text,text,integer), public.complete_payment_checkout_record(uuid,text,text,text,text,text), public.process_resend_provider_event(text,text,text,text,boolean,jsonb,jsonb), public.process_payment_provider_event(text,text,text,text,text,text,integer,text,boolean,boolean,jsonb), public.get_payment_checkout_for_capture(text) from public;
grant execute on function public.begin_payment_checkout_record(uuid,text,text,text,text,integer), public.complete_payment_checkout_record(uuid,text,text,text,text,text), public.process_resend_provider_event(text,text,text,text,boolean,jsonb,jsonb), public.process_payment_provider_event(text,text,text,text,text,text,integer,text,boolean,boolean,jsonb), public.get_payment_checkout_for_capture(text) to service_role;
