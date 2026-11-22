insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dispatch-rate-confirmations', 'dispatch-rate-confirmations', false, 10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']);

create function fleet_internal.dispatch_rate_confirmation_access(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when object_name ~ '^[a-z0-9]{1,20}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpeg|png|webp|heic|heif)$' then
    fleet_internal.office_has_permission(split_part(object_name, '/', 1), 'dispatch')
    and exists (
      select 1 from fleet_internal.dispatch_pro_reservations r
      where r.fleet_id = split_part(object_name, '/', 1)
        and r.load_id = split_part(object_name, '/', 2)::uuid
    )
    else false end;
$$;

revoke all on function fleet_internal.dispatch_rate_confirmation_access(text) from public, anon, authenticated;
grant execute on function fleet_internal.dispatch_rate_confirmation_access(text) to authenticated;

create policy dispatch_rate_confirmations_read on storage.objects
  for select to authenticated
  using (bucket_id = 'dispatch-rate-confirmations' and fleet_internal.dispatch_rate_confirmation_access(name));

create policy dispatch_rate_confirmations_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'dispatch-rate-confirmations' and fleet_internal.dispatch_rate_confirmation_access(name));
