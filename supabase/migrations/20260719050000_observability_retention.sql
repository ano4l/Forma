create or replace function public.redact_provider_payloads(target_workspace uuid,target_before timestamptz)
returns integer language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  update public.provider_webhook_events set payload_json='{"redacted":true}'::jsonb
  where workspace_id is not distinct from target_workspace and processed_at<target_before and payload_json<>'{"redacted":true}'::jsonb;
  get diagnostics changed=row_count;
  return changed;
end $$;

revoke all on function public.redact_provider_payloads(uuid,timestamptz) from public;
grant execute on function public.redact_provider_payloads(uuid,timestamptz) to service_role;
