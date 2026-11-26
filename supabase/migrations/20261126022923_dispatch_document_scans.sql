update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'application/pdf')
where id = 'dispatch-rate-confirmations' and not ('application/pdf' = any(allowed_mime_types));

create or replace function fleet_internal.dispatch_rate_confirmation_access(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when object_name ~ '^[a-z0-9]{1,20}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpeg|png|webp|heic|heif|pdf)$' then
    fleet_internal.office_has_permission(split_part(object_name, '/', 1), 'dispatch')
    and exists (
      select 1 from fleet_internal.dispatch_pro_reservations r
      where r.fleet_id = split_part(object_name, '/', 1)
        and r.load_id = split_part(object_name, '/', 2)::uuid
    )
    else false end;
$$;

create or replace function fleet_internal.driver_document_access(object_name text, writing boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load_key text := split_part(object_name,'/',1);
  load_row public.fleet_dispatch_loads%rowtype;
  assigned uuid;
begin
  if actor is null or load_key !~ '^[0-9a-f-]{36}$'
    or load_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select * into load_row from public.fleet_dispatch_loads where id = load_key::uuid;
  if not found then return false; end if;
  if not writing and exists (select 1 from public.fleets where id=load_row.fleet_id and admin_user_id=actor) then return true; end if;
  if not writing and fleet_internal.office_has_permission(load_row.fleet_id, 'dispatch') then return true; end if;
  assigned := fleet_internal.workflow_driver(actor,load_row.fleet_id);
  if assigned is null or (assigned is distinct from load_row.driver_id and assigned is distinct from load_row.second_driver_id) then
    return false;
  end if;
  if not writing then return load_row.status in ('current','completed') or load_row.return_review is not null; end if;
  if split_part(object_name,'/',2)<>actor::text then return false; end if;
  if load_row.status='completed' then
    return fleet_internal.can_attach_completed_paperwork(load_row,assigned);
  end if;
  return (load_row.status='current' or load_row.return_review='pending')
    and coalesce(load_row.progress #>> array['driverResponses',assigned::text,'decision'],'')='accepted';
end;
$$;

