create table if not exists public.document_portal_links (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text primary key,
  document_id text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade
);
create index if not exists document_portal_links_document_idx on public.document_portal_links(workspace_id, document_id, created_at desc);
alter table public.document_portal_links enable row level security;
revoke all on public.document_portal_links from anon, authenticated;

alter table public.workspace_invitations add column if not exists delivery_status text;
alter table public.workspace_invitations add column if not exists delivery_error text;

create or replace function public.create_document_portal_link(target_workspace uuid,target_id text,target_document_id text,target_token_hash text,target_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare document public.documents; link public.document_portal_links;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into document from public.documents where workspace_id=target_workspace and id=target_document_id;
  if not found then raise exception 'Document not found' using errcode='P0002'; end if;
  if document.status='draft' then raise exception 'Finalize or send the document before sharing it' using errcode='23514'; end if;
  insert into public.document_portal_links(workspace_id,id,document_id,token_hash,expires_at) values(target_workspace,target_id,target_document_id,target_token_hash,target_expires_at) returning * into link;
  insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(target_workspace,target_document_id,'portal_link_created',jsonb_build_object('portal_link_id',target_id,'expires_at',target_expires_at));
  return to_jsonb(link)-'token_hash';
end $$;

create or replace function public.resolve_document_portal_link(target_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare link public.document_portal_links; document public.documents; payment_links jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  select * into link from public.document_portal_links where token_hash=target_token_hash and revoked_at is null and expires_at>now() for update;
  if not found then return null; end if;
  select * into document from public.documents where workspace_id=link.workspace_id and id=link.document_id;
  update public.document_portal_links set last_viewed_at=now() where id=link.id;
  select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'amount_minor',amount_minor,'currency',currency,'status',status,'checkout_url',checkout_url) order by created_at desc),'[]'::jsonb) into payment_links from public.payment_checkouts where workspace_id=link.workspace_id and invoice_id=link.document_id and checkout_url is not null and status not in ('failed','paid');
  return jsonb_build_object('link',jsonb_build_object('id',link.id,'expires_at',link.expires_at),'document',to_jsonb(document),'payment_links',payment_links);
end $$;

create or replace function public.portal_quote_action(target_token_hash text,target_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare link public.document_portal_links; document public.documents;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if target_action not in ('accepted','declined') then raise exception 'Quote action is invalid' using errcode='22023'; end if;
  select * into link from public.document_portal_links where token_hash=target_token_hash and revoked_at is null and expires_at>now() for update;
  if not found then raise exception 'Portal link is invalid or expired' using errcode='P0002'; end if;
  select * into document from public.documents where workspace_id=link.workspace_id and id=link.document_id for update;
  if document.document_type<>'quote' or document.status<>'sent' then raise exception 'This quote can no longer be updated' using errcode='23514'; end if;
  update public.documents set status=target_action,updated_at=now() where workspace_id=link.workspace_id and id=link.document_id returning * into document;
  insert into public.document_audit_events(workspace_id,document_id,type,detail_json) values(link.workspace_id,link.document_id,target_action,jsonb_build_object('source','customer_portal','portal_link_id',link.id));
  return to_jsonb(document);
end $$;

create or replace function public.create_workspace_invitation_record(target_workspace uuid,target_id uuid,target_email text,target_role text,target_token_hash text,target_expires_at timestamptz,target_created_by uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare invitation public.workspace_invitations;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if target_role not in ('admin','member','viewer') then raise exception 'Invitation role is invalid' using errcode='22023'; end if;
  if not exists(select 1 from public.workspace_memberships where workspace_id=target_workspace and user_id=target_created_by and status='active' and public.workspace_role_rank(role)>=30) then raise exception 'Workspace admin access required' using errcode='42501'; end if;
  insert into public.workspace_invitations(id,workspace_id,email,role,token_hash,expires_at,created_by,delivery_status) values(target_id,target_workspace,lower(trim(target_email)),target_role,target_token_hash,target_expires_at,target_created_by,'pending') on conflict(workspace_id,email) do update set role=excluded.role,token_hash=excluded.token_hash,expires_at=excluded.expires_at,accepted_at=null,created_by=excluded.created_by,created_at=now(),delivery_status='pending',delivery_error=null returning * into invitation;
  return to_jsonb(invitation)-'token_hash';
end $$;

create or replace function public.revoke_document_portal_link(target_workspace uuid,target_id text)
returns void language plpgsql security definer set search_path='' as $$ begin if (select auth.role())<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if; update public.document_portal_links set revoked_at=now() where workspace_id=target_workspace and id=target_id and revoked_at is null; if not found then raise exception 'Portal link not found' using errcode='P0002'; end if; end $$;

revoke all on function public.create_document_portal_link(uuid,text,text,text,timestamptz), public.resolve_document_portal_link(text), public.portal_quote_action(text,text), public.create_workspace_invitation_record(uuid,uuid,text,text,text,timestamptz,uuid), public.revoke_document_portal_link(uuid,text) from public;
grant execute on function public.create_document_portal_link(uuid,text,text,text,timestamptz), public.resolve_document_portal_link(text), public.portal_quote_action(text,text), public.create_workspace_invitation_record(uuid,uuid,text,text,text,timestamptz,uuid), public.revoke_document_portal_link(uuid,text) to service_role;
