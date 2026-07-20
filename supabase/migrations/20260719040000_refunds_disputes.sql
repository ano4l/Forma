create table if not exists public.payment_refunds (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text not null,
  invoice_id text not null,
  checkout_id text not null,
  provider text not null check (provider in ('stripe','paypal')),
  provider_refund_id text,
  provider_payment_id text not null,
  request_key text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  status text not null,
  reason text not null default '',
  provider_error text,
  ledger_applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (id),
  unique (workspace_id,request_key),
  unique (provider,provider_refund_id),
  foreign key (workspace_id,invoice_id) references public.documents(workspace_id,id),
  foreign key (checkout_id) references public.payment_checkouts(id)
);

create table if not exists public.payment_disputes (
  workspace_id uuid references public.workspaces(id) on delete set null,
  id text not null,
  invoice_id text,
  checkout_id text,
  provider text not null check (provider in ('stripe','paypal')),
  provider_dispute_id text not null,
  provider_payment_id text,
  amount_minor integer,
  currency text,
  status text not null,
  reason text not null default '',
  event_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider,provider_dispute_id)
);

alter table public.payment_refunds enable row level security;
alter table public.payment_disputes enable row level security;
revoke all on public.payment_refunds, public.payment_disputes from anon, authenticated;
grant select on public.payment_refunds, public.payment_disputes to authenticated;
create policy payment_refunds_workspace_select on public.payment_refunds for select to authenticated using (public.is_workspace_member(workspace_id));
create policy payment_disputes_workspace_select on public.payment_disputes for select to authenticated using (public.is_workspace_member(workspace_id));

create or replace function public.begin_payment_refund_record(target_workspace uuid,target_id text,target_invoice_id text,target_checkout_id text,target_request_key text,target_amount integer,target_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare invoice public.documents; checkout public.payment_checkouts; existing_refund public.payment_refunds; saved public.payment_refunds; reserved integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into existing_refund from public.payment_refunds where workspace_id=target_workspace and request_key=target_request_key;
  if found then
    select * into checkout from public.payment_checkouts where workspace_id=target_workspace and id=existing_refund.checkout_id;
    select * into invoice from public.documents where workspace_id=target_workspace and id=existing_refund.invoice_id;
    if existing_refund.invoice_id<>target_invoice_id or (target_checkout_id is not null and existing_refund.checkout_id<>target_checkout_id) or existing_refund.amount_minor<>target_amount then raise exception 'request_key was already used for different refund parameters' using errcode='23505'; end if;
    return jsonb_build_object('inserted',false,'refund',to_jsonb(existing_refund),'checkout',to_jsonb(checkout),'invoice',to_jsonb(invoice));
  end if;
  select * into invoice from public.documents where workspace_id=target_workspace and id=target_invoice_id and document_type='invoice' for update;
  if not found then raise exception 'Invoice not found' using errcode='P0002'; end if;
  if invoice.amount_paid_minor<=0 or invoice.status not in ('paid','partially_paid','overdue','refunded') then raise exception 'Only a paid invoice can be refunded' using errcode='23514'; end if;
  if target_checkout_id is null then select * into checkout from public.payment_checkouts where workspace_id=target_workspace and invoice_id=target_invoice_id and status='paid' and provider_payment_id is not null order by paid_at desc limit 1 for update; else select * into checkout from public.payment_checkouts where workspace_id=target_workspace and invoice_id=target_invoice_id and id=target_checkout_id and status='paid' for update; end if;
  if checkout.id is null then raise exception 'A completed Stripe or PayPal payment is required before refunding' using errcode='23514'; end if;
  select coalesce(sum(amount_minor),0)::integer into reserved from public.payment_refunds where workspace_id=target_workspace and checkout_id=checkout.id and status not in ('failed','canceled');
  if target_amount<=0 or target_amount>checkout.amount_minor-reserved or target_amount>invoice.amount_paid_minor then raise exception 'Refund amount exceeds the remaining refundable payment' using errcode='23514'; end if;
  if length(coalesce(target_reason,''))>255 then raise exception 'reason must be 255 characters or fewer' using errcode='23514'; end if;
  insert into public.payment_refunds(workspace_id,id,invoice_id,checkout_id,provider,provider_payment_id,request_key,amount_minor,currency,status,reason) values(target_workspace,target_id,target_invoice_id,checkout.id,checkout.provider,checkout.provider_payment_id,target_request_key,target_amount,checkout.currency,'creating',coalesce(target_reason,'')) returning * into saved;
  return jsonb_build_object('inserted',true,'refund',to_jsonb(saved),'checkout',to_jsonb(checkout),'invoice',to_jsonb(invoice));
end $$;

create or replace function public.complete_payment_refund_record(target_workspace uuid,target_id text,target_provider_refund_id text,target_status text,target_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved public.payment_refunds;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  update public.payment_refunds set provider_refund_id=coalesce(target_provider_refund_id,provider_refund_id),status=case when target_error is null then lower(target_status) else 'failed' end,provider_error=target_error,updated_at=now() where workspace_id=target_workspace and id=target_id returning * into saved;
  if not found then raise exception 'Refund not found' using errcode='P0002'; end if;
  return to_jsonb(saved);
end $$;

create or replace function public.process_payment_refund_event(target_provider text,target_event_id text,target_event_type text,target_refund_id text,target_checkout_id text,target_provider_refund_id text,target_provider_payment_id text,target_amount integer,target_currency text,target_status text,target_success boolean,target_failed boolean,target_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare refund public.payment_refunds; checkout public.payment_checkouts; invoice public.documents; inserted_count integer; paid integer; balance integer; next_status text; timestamp_value timestamptz := now();
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if target_refund_id is not null then select * into refund from public.payment_refunds where provider=target_provider and id=target_refund_id for update; end if;
  if refund.id is null and target_provider_refund_id is not null then select * into refund from public.payment_refunds where provider=target_provider and provider_refund_id=target_provider_refund_id for update; end if;
  if refund.id is not null then select * into checkout from public.payment_checkouts where workspace_id=refund.workspace_id and id=refund.checkout_id for update;
  else select * into checkout from public.payment_checkouts where provider=target_provider and (provider_payment_id=target_provider_payment_id or id=target_checkout_id) order by paid_at desc limit 1 for update; end if;
  if refund.id is null and checkout.id is not null and (target_success or not target_failed) and target_amount>0 then
    insert into public.payment_refunds(workspace_id,id,invoice_id,checkout_id,provider,provider_refund_id,provider_payment_id,request_key,amount_minor,currency,status,reason)
    values(checkout.workspace_id,gen_random_uuid()::text,checkout.invoice_id,checkout.id,target_provider,target_provider_refund_id,checkout.provider_payment_id,'external:'||target_provider||':'||coalesce(target_provider_refund_id,target_event_id),target_amount,coalesce(upper(target_currency),checkout.currency),coalesce(lower(target_status),'pending'),'Created outside Forma') returning * into refund;
  end if;
  if refund.id is not null and target_amount is not null and (target_amount is distinct from refund.amount_minor or upper(target_currency) is distinct from refund.currency) then raise exception 'Provider refund amount or currency does not match the refund request' using errcode='23514'; end if;
  insert into public.provider_webhook_events(provider,event_id,workspace_id,event_type,object_id,payload_json) values(target_provider,target_event_id,refund.workspace_id,target_event_type,coalesce(target_provider_refund_id,target_provider_payment_id),target_payload) on conflict do nothing;
  get diagnostics inserted_count=row_count; if inserted_count=0 then return jsonb_build_object('duplicate',true); end if;
  if refund.id is null then return jsonb_build_object('duplicate',false,'matched',false); end if;
  update public.payment_refunds set provider_refund_id=coalesce(target_provider_refund_id,provider_refund_id),status=case when target_failed then 'failed' when target_success then 'succeeded' else coalesce(lower(target_status),'pending') end,provider_error=case when target_failed then target_provider||' reported '||target_event_type else null end,updated_at=timestamp_value where workspace_id=refund.workspace_id and id=refund.id returning * into refund;
  if target_success and refund.ledger_applied_at is null then
    select * into invoice from public.documents where workspace_id=refund.workspace_id and id=refund.invoice_id for update;
    if invoice.amount_paid_minor<refund.amount_minor then raise exception 'Refund exceeds the invoice recorded payments' using errcode='23514'; end if;
    paid:=invoice.amount_paid_minor-refund.amount_minor; balance:=greatest(0,(invoice.totals_json->>'total_minor')::integer-paid); next_status:=case when paid=0 then 'refunded' when balance>0 then 'partially_paid' else 'paid' end;
    update public.documents set amount_paid_minor=paid,balance_due_minor=balance,status=next_status,updated_at=timestamp_value where workspace_id=refund.workspace_id and id=refund.invoice_id;
    update public.payment_refunds set status='succeeded',ledger_applied_at=timestamp_value,completed_at=timestamp_value,updated_at=timestamp_value where workspace_id=refund.workspace_id and id=refund.id returning * into refund;
    insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(refund.workspace_id,refund.invoice_id,'refund_recorded',jsonb_build_object('refund_id',refund.id,'checkout_id',refund.checkout_id,'amount_minor',refund.amount_minor,'provider',target_provider));
  end if;
  return jsonb_build_object('duplicate',false,'matched',true,'refund',to_jsonb(refund));
end $$;

create or replace function public.process_payment_dispute_event(target_provider text,target_event_id text,target_event_type text,target_provider_dispute_id text,target_provider_payment_id text,target_amount integer,target_currency text,target_status text,target_reason text,target_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare checkout public.payment_checkouts; inserted_count integer; timestamp_value timestamptz:=now();
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into checkout from public.payment_checkouts where provider=target_provider and provider_payment_id=target_provider_payment_id order by paid_at desc limit 1;
  insert into public.provider_webhook_events(provider,event_id,workspace_id,event_type,object_id,payload_json) values(target_provider,target_event_id,checkout.workspace_id,target_event_type,target_provider_dispute_id,target_payload) on conflict do nothing;
  get diagnostics inserted_count=row_count; if inserted_count=0 then return jsonb_build_object('duplicate',true); end if;
  insert into public.payment_disputes(workspace_id,id,invoice_id,checkout_id,provider,provider_dispute_id,provider_payment_id,amount_minor,currency,status,reason,event_type,created_at,updated_at)
  values(checkout.workspace_id,gen_random_uuid()::text,checkout.invoice_id,checkout.id,target_provider,target_provider_dispute_id,target_provider_payment_id,target_amount,upper(target_currency),coalesce(target_status,'open'),coalesce(target_reason,''),target_event_type,timestamp_value,timestamp_value)
  on conflict(provider,provider_dispute_id) do update set status=excluded.status,reason=excluded.reason,event_type=excluded.event_type,amount_minor=coalesce(excluded.amount_minor,public.payment_disputes.amount_minor),currency=coalesce(excluded.currency,public.payment_disputes.currency),updated_at=excluded.updated_at;
  if checkout.id is not null then insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(checkout.workspace_id,checkout.invoice_id,'payment_dispute_updated',jsonb_build_object('provider',target_provider,'provider_dispute_id',target_provider_dispute_id,'status',target_status,'amount_minor',target_amount)); end if;
  return jsonb_build_object('duplicate',false,'matched',checkout.id is not null);
end $$;

revoke all on function public.begin_payment_refund_record(uuid,text,text,text,text,integer,text), public.complete_payment_refund_record(uuid,text,text,text,text), public.process_payment_refund_event(text,text,text,text,text,text,text,integer,text,text,boolean,boolean,jsonb), public.process_payment_dispute_event(text,text,text,text,text,integer,text,text,text,jsonb) from public;
grant execute on function public.begin_payment_refund_record(uuid,text,text,text,text,integer,text), public.complete_payment_refund_record(uuid,text,text,text,text), public.process_payment_refund_event(text,text,text,text,text,text,text,integer,text,text,boolean,boolean,jsonb), public.process_payment_dispute_event(text,text,text,text,text,integer,text,text,text,jsonb) to service_role;
