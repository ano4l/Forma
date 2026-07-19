-- Forma hosted security foundation.
-- This migration intentionally fails when hosted business rows already exist without
-- a workspace. Assign those rows in a dedicated data migration before retrying.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member', 'viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create or replace function public.workspace_role_rank(role_name text)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case role_name
    when 'owner' then 40
    when 'admin' then 30
    when 'member' then 20
    when 'viewer' then 10
    else 0
  end
$$;

create or replace function public.has_workspace_role(target_workspace uuid, required_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships membership
    where membership.workspace_id = target_workspace
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and public.workspace_role_rank(membership.role) >= public.workspace_role_rank(required_role)
  )
$$;

revoke all on function public.has_workspace_role(uuid, text) from public;
grant execute on function public.has_workspace_role(uuid, text) to authenticated, service_role;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();
revoke all on function public.handle_new_auth_user() from public;

insert into public.profiles (user_id, display_name, avatar_url)
select id, coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''), raw_user_meta_data ->> 'avatar_url'
from auth.users
on conflict (user_id) do nothing;

create or replace function public.create_workspace(workspace_name text, workspace_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_workspace public.workspaces;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if length(trim(workspace_name)) not between 2 and 100 then raise exception 'Workspace name must be 2-100 characters'; end if;
  if workspace_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then raise exception 'Workspace slug is invalid'; end if;
  insert into public.workspaces (name, slug, created_by)
  values (trim(workspace_name), workspace_slug, auth.uid())
  returning * into created_workspace;
  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (created_workspace.id, auth.uid(), 'owner');
  return created_workspace;
end;
$$;

revoke all on function public.create_workspace(text, text) from public;
grant execute on function public.create_workspace(text, text) to authenticated;

create or replace function public.allocate_document_number(target_workspace uuid, target_type text, target_year integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_value integer;
  number_prefix text;
begin
  if target_type not in ('invoice', 'quote', 'receipt') then
    raise exception 'Invalid document type' using errcode = '22023';
  end if;
  if target_year < 2000 or target_year > 9999 then
    raise exception 'Invalid document year' using errcode = '22023';
  end if;
  if (select auth.role()) <> 'service_role' and not public.has_workspace_role(target_workspace, 'member') then
    raise exception 'Workspace write access required' using errcode = '42501';
  end if;

  insert into public.document_sequences (workspace_id, document_type, year, value)
  values (target_workspace, target_type, target_year, 1)
  on conflict (workspace_id, document_type, year)
  do update set value = public.document_sequences.value + 1
  returning value into next_value;

  select coalesce(value ->> target_type, upper(left(target_type, 3)))
  into number_prefix
  from public.settings
  where workspace_id = target_workspace and key = 'number_prefixes';

  number_prefix := coalesce(number_prefix, case target_type when 'invoice' then 'INV' when 'quote' then 'QUO' else 'REC' end);
  return number_prefix || '-' || target_year::text || '-' || lpad(next_value::text, 5, '0');
end;
$$;

revoke all on function public.allocate_document_number(uuid, text, integer) from public;
grant execute on function public.allocate_document_number(uuid, text, integer) to service_role;

create or replace function public.accept_workspace_invitation(invitation_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.workspace_invitations;
  normalized_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select lower(email) into normalized_email from auth.users where id = auth.uid();
  select * into invitation
  from public.workspace_invitations
  where token_hash = encode(extensions.digest(invitation_token, 'sha256'), 'hex')
    and accepted_at is null
    and expires_at > now()
  for update;
  if invitation.id is null or lower(invitation.email) <> normalized_email then
    raise exception 'Invitation is invalid or expired' using errcode = '42501';
  end if;
  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (invitation.workspace_id, auth.uid(), invitation.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active', updated_at = now();
  update public.workspace_invitations set accepted_at = now() where id = invitation.id;
  return invitation.workspace_id;
end;
$$;

revoke all on function public.accept_workspace_invitation(text) from public;
grant execute on function public.accept_workspace_invitation(text) to authenticated;

do $$
declare
  table_name text;
  has_unassigned_rows boolean;
begin
  foreach table_name in array array[
    'settings', 'customers', 'products', 'document_sequences', 'documents',
    'document_audit_events', 'payments', 'payment_methods', 'branding_presets',
    'email_templates', 'media_assets', 'email_delivery_attempts', 'reminder_rules',
    'document_reminder_deliveries', 'recurring_schedules', 'recurring_schedule_runs'
  ] loop
    execute format('alter table public.%I add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade', table_name);
    execute format('create index if not exists %I on public.%I(workspace_id)', table_name || '_workspace_idx', table_name);
    execute format('select exists (select 1 from public.%I where workspace_id is null)', table_name) into has_unassigned_rows;
    if has_unassigned_rows then
      raise exception 'Table public.% contains rows without workspace_id; run an explicit tenant data migration first', table_name;
    end if;
    execute format('alter table public.%I alter column workspace_id set not null', table_name);
  end loop;
end $$;

-- Re-key workspace-local natural keys.
alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings add primary key (workspace_id, key);
alter table public.document_sequences drop constraint if exists document_sequences_pkey;
alter table public.document_sequences add primary key (workspace_id, document_type, year);

alter table public.email_delivery_attempts drop constraint if exists email_delivery_attempts_template_purpose_fkey;
alter table public.reminder_rules drop constraint if exists reminder_rules_purpose_fkey;
alter table public.document_reminder_deliveries drop constraint if exists document_reminder_deliveries_rule_id_fkey;
alter table public.email_templates drop constraint if exists email_templates_pkey;
alter table public.email_templates add primary key (workspace_id, purpose);
alter table public.reminder_rules drop constraint if exists reminder_rules_pkey;
alter table public.reminder_rules add primary key (workspace_id, id);

alter table public.documents drop constraint if exists documents_number_key;
alter table public.documents drop constraint if exists documents_document_type_number_year_number_key;
alter table public.documents add constraint documents_workspace_number_key unique (workspace_id, number);
alter table public.documents add constraint documents_workspace_type_year_number_key unique (workspace_id, document_type, number_year, number);

-- Composite uniqueness lets foreign keys prove that parent and child rows share a tenant.
alter table public.customers add constraint customers_workspace_id_key unique (workspace_id, id);
alter table public.documents add constraint documents_workspace_id_key unique (workspace_id, id);
alter table public.email_delivery_attempts add constraint email_attempts_workspace_id_key unique (workspace_id, id);
alter table public.recurring_schedules add constraint recurring_schedules_workspace_id_key unique (workspace_id, id);

alter table public.documents drop constraint if exists documents_customer_id_fkey;
alter table public.documents drop constraint if exists documents_source_document_id_fkey;
alter table public.documents drop constraint if exists documents_recurring_schedule_fk;
alter table public.documents add constraint documents_workspace_customer_fkey foreign key (workspace_id, customer_id) references public.customers(workspace_id, id) on delete set null (customer_id);
alter table public.documents add constraint documents_workspace_source_fkey foreign key (workspace_id, source_document_id) references public.documents(workspace_id, id) on delete set null (source_document_id);
alter table public.documents add constraint documents_workspace_recurring_fkey foreign key (workspace_id, recurring_schedule_id) references public.recurring_schedules(workspace_id, id) on delete set null (recurring_schedule_id);

alter table public.document_audit_events drop constraint if exists document_audit_events_document_id_fkey;
alter table public.document_audit_events add constraint document_audit_workspace_document_fkey foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade;
alter table public.payments drop constraint if exists payments_invoice_id_fkey;
alter table public.payments drop constraint if exists payments_receipt_id_fkey;
alter table public.payments add constraint payments_workspace_invoice_fkey foreign key (workspace_id, invoice_id) references public.documents(workspace_id, id) on delete cascade;
alter table public.payments add constraint payments_workspace_receipt_fkey foreign key (workspace_id, receipt_id) references public.documents(workspace_id, id) on delete set null (receipt_id);

alter table public.email_delivery_attempts drop constraint if exists email_delivery_attempts_document_id_fkey;
alter table public.email_delivery_attempts add constraint email_attempts_workspace_document_fkey foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade;
alter table public.email_delivery_attempts add constraint email_attempts_workspace_template_fkey foreign key (workspace_id, template_purpose) references public.email_templates(workspace_id, purpose);
alter table public.reminder_rules add constraint reminder_rules_workspace_template_fkey foreign key (workspace_id, purpose) references public.email_templates(workspace_id, purpose);

alter table public.document_reminder_deliveries drop constraint if exists document_reminder_deliveries_document_id_fkey;
alter table public.document_reminder_deliveries drop constraint if exists document_reminder_deliveries_attempt_id_fkey;
alter table public.document_reminder_deliveries add constraint reminder_deliveries_workspace_document_fkey foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade;
alter table public.document_reminder_deliveries add constraint reminder_deliveries_workspace_rule_fkey foreign key (workspace_id, rule_id) references public.reminder_rules(workspace_id, id);
alter table public.document_reminder_deliveries add constraint reminder_deliveries_workspace_attempt_fkey foreign key (workspace_id, attempt_id) references public.email_delivery_attempts(workspace_id, id) on delete set null (attempt_id);

alter table public.recurring_schedules drop constraint if exists recurring_schedules_source_document_id_fkey;
alter table public.recurring_schedules add constraint recurring_schedules_workspace_source_fkey foreign key (workspace_id, source_document_id) references public.documents(workspace_id, id) on delete set null (source_document_id);
alter table public.recurring_schedule_runs drop constraint if exists recurring_schedule_runs_schedule_id_fkey;
alter table public.recurring_schedule_runs drop constraint if exists recurring_schedule_runs_document_id_fkey;
alter table public.recurring_schedule_runs add constraint recurring_runs_workspace_schedule_fkey foreign key (workspace_id, schedule_id) references public.recurring_schedules(workspace_id, id) on delete cascade;
alter table public.recurring_schedule_runs add constraint recurring_runs_workspace_document_fkey foreign key (workspace_id, document_id) references public.documents(workspace_id, id) on delete cascade;

create unique index if not exists payment_methods_one_default_per_workspace
on public.payment_methods(workspace_id) where is_default and active;
create index if not exists workspace_memberships_user_idx on public.workspace_memberships(user_id, status);
create index if not exists workspace_invitations_email_idx on public.workspace_invitations(lower(email), expires_at);

create or replace function public.prevent_workspace_reassignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.protect_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active')
     and not exists (
       select 1 from public.workspace_memberships membership
       where membership.workspace_id = old.workspace_id
         and membership.user_id <> old.user_id
         and membership.role = 'owner'
         and membership.status = 'active'
     ) then
    raise exception 'A workspace must retain at least one active owner' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists protect_last_workspace_owner on public.workspace_memberships;
create trigger protect_last_workspace_owner
before update or delete on public.workspace_memberships
for each row execute function public.protect_last_workspace_owner();
drop trigger if exists prevent_membership_workspace_reassignment on public.workspace_memberships;
create trigger prevent_membership_workspace_reassignment
before update on public.workspace_memberships
for each row execute function public.prevent_workspace_reassignment();
drop trigger if exists prevent_invitation_workspace_reassignment on public.workspace_invitations;
create trigger prevent_invitation_workspace_reassignment
before update on public.workspace_invitations
for each row execute function public.prevent_workspace_reassignment();

revoke all on function public.prevent_workspace_reassignment() from public;
revoke all on function public.protect_last_workspace_owner() from public;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_invitations enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy workspaces_select_member on public.workspaces for select to authenticated using (public.has_workspace_role(id, 'viewer'));
create policy workspaces_update_admin on public.workspaces for update to authenticated using (public.has_workspace_role(id, 'admin')) with check (public.has_workspace_role(id, 'admin'));
create policy workspaces_delete_owner on public.workspaces for delete to authenticated using (public.has_workspace_role(id, 'owner'));
create policy memberships_select_member on public.workspace_memberships for select to authenticated using (public.has_workspace_role(workspace_id, 'viewer'));
create policy memberships_insert_admin on public.workspace_memberships for insert to authenticated with check (public.has_workspace_role(workspace_id, 'admin') and (role <> 'owner' or public.has_workspace_role(workspace_id, 'owner')));
create policy memberships_update_admin on public.workspace_memberships for update to authenticated using (public.has_workspace_role(workspace_id, 'admin') and (role <> 'owner' or public.has_workspace_role(workspace_id, 'owner'))) with check (public.has_workspace_role(workspace_id, 'admin') and (role <> 'owner' or public.has_workspace_role(workspace_id, 'owner')));
create policy memberships_delete_admin on public.workspace_memberships for delete to authenticated using (public.has_workspace_role(workspace_id, 'admin') and role <> 'owner');
create policy invitations_select_admin on public.workspace_invitations for select to authenticated using (public.has_workspace_role(workspace_id, 'admin'));
create policy invitations_insert_admin on public.workspace_invitations for insert to authenticated with check (public.has_workspace_role(workspace_id, 'admin') and created_by = (select auth.uid()));
create policy invitations_delete_admin on public.workspace_invitations for delete to authenticated using (public.has_workspace_role(workspace_id, 'admin'));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'settings', 'customers', 'products', 'document_sequences', 'documents',
    'document_audit_events', 'payments', 'payment_methods', 'branding_presets',
    'email_templates', 'media_assets', 'email_delivery_attempts', 'reminder_rules',
    'document_reminder_deliveries', 'recurring_schedules', 'recurring_schedule_runs'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop trigger if exists prevent_workspace_reassignment on public.%I', table_name);
    execute format('create trigger prevent_workspace_reassignment before update on public.%I for each row execute function public.prevent_workspace_reassignment()', table_name);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_workspace_role(workspace_id, ''viewer''))', table_name || '_workspace_select', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_workspace_role(workspace_id, ''member''))', table_name || '_workspace_insert', table_name);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_workspace_role(workspace_id, ''member'')) with check (public.has_workspace_role(workspace_id, ''member''))', table_name || '_workspace_update', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_workspace_role(workspace_id, ''admin''))', table_name || '_workspace_delete', table_name);
  end loop;
end $$;

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
revoke select on public.payment_methods from authenticated;
revoke insert, update, delete on all tables in schema public from authenticated;
revoke usage, update on all sequences in schema public from authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'forma-private',
  'forma-private',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf']
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy forma_private_objects_select on storage.objects
for select to authenticated
using (
  bucket_id = 'forma-private'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.has_workspace_role(((storage.foldername(name))[1])::uuid, 'viewer')
);
create policy forma_private_objects_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'forma-private'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and public.has_workspace_role(((storage.foldername(name))[1])::uuid, 'member')
);
create policy forma_private_objects_update on storage.objects
for update to authenticated
using (bucket_id = 'forma-private' and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and public.has_workspace_role(((storage.foldername(name))[1])::uuid, 'member'))
with check (bucket_id = 'forma-private' and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and public.has_workspace_role(((storage.foldername(name))[1])::uuid, 'member'));
create policy forma_private_objects_delete on storage.objects
for delete to authenticated
using (bucket_id = 'forma-private' and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and public.has_workspace_role(((storage.foldername(name))[1])::uuid, 'member'));

comment on table public.workspace_memberships is 'Authoritative workspace authorization source. Do not mirror roles into user-editable user_metadata.';
comment on column public.media_assets.storage_key is 'Private Storage key, always prefixed with workspace_id/.';
