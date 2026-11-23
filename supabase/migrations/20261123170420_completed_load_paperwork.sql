create function fleet_internal.can_attach_completed_paperwork(load public.fleet_dispatch_loads, driver uuid)
returns boolean language sql stable set search_path = ''
as $$
  select (load).status='completed' and driver is not null
    and (driver is not distinct from (load).driver_id or driver is not distinct from (load).second_driver_id)
    and (load).progress #>> array['driverResponses',driver::text,'decision'] is distinct from 'rejected';
$$;
revoke all on function fleet_internal.can_attach_completed_paperwork(public.fleet_dispatch_loads,uuid)
  from public, anon, authenticated;

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

create function fleet_internal.attach_completed_load_paperwork(target_load uuid, target_stop text, documents jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  assigned uuid;
  stop_state jsonb;
  report jsonb;
  current_documents jsonb;
  combined jsonb;
begin
  if actor is null then
    raise exception 'Sign in to attach paperwork.' using errcode='42501';
  end if;
  select l.* into load from public.fleet_dispatch_loads l
  where l.id=target_load and l.status='completed' for update;
  if not found then
    raise exception 'This completed load is unavailable.' using errcode='42501';
  end if;
  assigned := fleet_internal.workflow_driver(actor,load.fleet_id);
  if not fleet_internal.can_attach_completed_paperwork(load,assigned)
    or not exists(select 1 from fleet_internal.driver_assigned_stops(load,assigned) s where s.stop_key=target_stop) then
    raise exception 'You can attach paperwork only to your assigned stops.' using errcode='42501';
  end if;
  if jsonb_typeof(documents) is distinct from 'array' then
    raise exception 'Attach paperwork as a list of files.' using errcode='22023';
  end if;
  if jsonb_array_length(documents) not between 1 and 20 or exists(
    select 1 from jsonb_array_elements(documents) attachment(value)
    cross join lateral (select attachment.value #>> '{}' as name) file
    where jsonb_typeof(attachment.value) <> 'string'
      or split_part(file.name,'/',1)<>load.id::text or split_part(file.name,'/',2)<>actor::text
      or not exists(select 1 from storage.objects o where o.bucket_id='driver-load-documents' and o.name=file.name)
  ) then
    raise exception 'Upload the files to this load before attaching them.' using errcode='22023';
  end if;

  stop_state := coalesce(load.progress #> array['stops',target_stop],'{}'::jsonb);
  report := coalesce(stop_state->'driverReport','{}'::jsonb);
  current_documents := case
    when jsonb_typeof(report->'documents')='array' and report->'documents'<>'[]'::jsonb then report->'documents'
    when nullif(report->>'document','') is not null then jsonb_build_array(report->>'document')
    else '[]'::jsonb end;
  -- Order is preserved and a retry leaves the attachment list unchanged.
  select jsonb_agg(item order by first_position) into combined
  from (
    select item,min(position) first_position
    from jsonb_array_elements_text(current_documents || documents) with ordinality d(item,position)
    group by item
  ) ordered;
  if jsonb_array_length(combined)>20 then
    raise exception 'Attach up to 20 files per stop.' using errcode='22023';
  end if;
  if combined=current_documents then return; end if;
  stop_state := stop_state || jsonb_build_object('driverReport',
    report || jsonb_build_object('document',combined->>0,'documents',combined));
  perform fleet_internal.write_driver_progress(load.id,jsonb_set(load.progress,'{stops}',
    coalesce(load.progress->'stops','{}'::jsonb) || jsonb_build_object(target_stop,stop_state)));
end;
$$;

create function public.attach_completed_load_paperwork(target_load uuid,target_stop text,documents jsonb)
returns void language sql security invoker set search_path = ''
as $$
  select fleet_internal.attach_completed_load_paperwork(target_load,target_stop,documents);
$$;
revoke all on function fleet_internal.attach_completed_load_paperwork(uuid,text,jsonb),
  public.attach_completed_load_paperwork(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.attach_completed_load_paperwork(uuid,text,jsonb),
  public.attach_completed_load_paperwork(uuid,text,jsonb) to authenticated;
