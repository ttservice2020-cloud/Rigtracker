create function fleet_internal.merge_driver_stop_documents(report jsonb, added jsonb)
returns jsonb language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_agg(path order by first_position),'[]'::jsonb)
  from (
    select path,min(position) as first_position
    from jsonb_array_elements_text(
      coalesce((select jsonb_agg(path order by file_order) from fleet_internal.driver_report_documents(report)),'[]'::jsonb)
      || added
    ) with ordinality file(path,position)
    group by path
  ) unique_files;
$$;
revoke all on function fleet_internal.merge_driver_stop_documents(jsonb,jsonb) from public, anon, authenticated;

create function fleet_internal.update_driver_stop_info(
  target_load uuid, target_stop text, load_info jsonb, expected_info jsonb, documents jsonb
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  assigned uuid;
  stop_kind text;
  stop_state jsonb;
  previous_report jsonb;
  report jsonb;
  changed_fields jsonb;
  combined jsonb;
begin
  if actor is null then
    raise exception 'Sign in to update load info.' using errcode='42501';
  end if;
  select l.* into load from public.fleet_dispatch_loads l
  where l.id=target_load and (l.status in ('current','completed') or l.return_review='pending')
  for update;
  if not found then
    raise exception 'This load is unavailable.' using errcode='42501';
  end if;
  assigned := fleet_internal.workflow_driver(actor,load.fleet_id);
  if load.status='completed' then
    if not fleet_internal.can_attach_completed_paperwork(load,assigned) then
      raise exception 'This load is unavailable.' using errcode='42501';
    end if;
  elsif assigned is null or load.progress#>>array['driverResponses',assigned::text,'decision'] is distinct from 'accepted' then
    raise exception 'Accept this load before updating load info.' using errcode='42501';
  end if;

  select stop.kind into stop_kind from fleet_internal.driver_assigned_stops(load,assigned) stop where stop.stop_key=target_stop;
  if not found then
    raise exception 'You can update load info only for your assigned stops.' using errcode='42501';
  end if;
  stop_state := coalesce(load.progress#>array['stops',target_stop],'{}'::jsonb);
  if load.status<>'completed' and stop_state->>'completedAt' is null
    and (stop_kind<>'pickup' or stop_state->>'arrivalAt' is null) then
    raise exception 'Check in at pickup or record departure at delivery before updating this stop.'
      using errcode='22023';
  end if;
  previous_report := coalesce(stop_state->'driverReport','{}'::jsonb);
  report := previous_report;

  if jsonb_typeof(load_info) is distinct from 'object' or jsonb_typeof(expected_info) is distinct from 'object'
    or octet_length(load_info::text)>1600 or octet_length(expected_info::text)>1600 then
    raise exception 'Enter valid pickup information.' using errcode='22023';
  end if;
  if load_info<>'{}'::jsonb then
    if stop_kind<>'pickup' or exists (
      select 1 from jsonb_each(load_info) field
      where field.key not in ('commodity','weight','pieces','bol')
        or jsonb_typeof(field.value) not in ('null','string')
        or char_length(field.value#>>'{}') > case field.key when 'commodity' then 120 when 'bol' then 100 else 20 end
    ) then
      raise exception 'Enter valid pickup information.' using errcode='22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(load_info) field(key)
      where not (expected_info ? field.key)
        or (expected_info->>field.key) is distinct from (previous_report->>field.key)
    ) then
      raise exception 'This pickup was updated. Reopen Input Load Info to see the latest values.' using errcode='40001';
    end if;
    select jsonb_object_agg(field.key,nullif(btrim(field.value),'')) into changed_fields from jsonb_each_text(load_info) field;
    report := (report - array(select field.key from jsonb_each(changed_fields) field where field.value='null'::jsonb))
      || jsonb_strip_nulls(changed_fields);
  end if;

  if jsonb_typeof(documents) is distinct from 'array' then
    raise exception 'Attach paperwork as a list of files.' using errcode='22023';
  end if;
  if jsonb_array_length(documents)>20 or exists(
    select 1 from jsonb_array_elements(documents) attachment(value)
    cross join lateral (select attachment.value#>>'{}' as name) file
    where jsonb_typeof(attachment.value)<>'string'
      or split_part(file.name,'/',1)<>load.id::text or split_part(file.name,'/',2)<>actor::text
      or not exists(select 1 from storage.objects o where o.bucket_id='driver-load-documents' and o.name=file.name)
  ) then
    raise exception 'Upload up to 20 files to this load before attaching them.' using errcode='22023';
  end if;
  if documents<>'[]'::jsonb then
    combined := fleet_internal.merge_driver_stop_documents(report,documents);
    if jsonb_array_length(combined)>20 then
      raise exception 'Attach up to 20 files per stop.' using errcode='22023';
    end if;
    report := report || jsonb_build_object('document',combined->>0,'documents',combined);
  end if;
  if report=previous_report then return; end if;

  stop_state := stop_state || jsonb_build_object('driverReport',report);
  perform fleet_internal.write_driver_progress(load.id,jsonb_set(load.progress,'{stops}',
    coalesce(load.progress->'stops','{}'::jsonb) || jsonb_build_object(target_stop,stop_state)));
end;
$$;

create function public.update_driver_stop_info(
  target_load uuid, target_stop text, load_info jsonb default '{}'::jsonb,
  expected_info jsonb default '{}'::jsonb, documents jsonb default '[]'::jsonb
)
returns void language sql security invoker set search_path = ''
as $$
  select fleet_internal.update_driver_stop_info(target_load,target_stop,load_info,expected_info,documents);
$$;

revoke all on function fleet_internal.update_driver_stop_info(uuid,text,jsonb,jsonb,jsonb),
  public.update_driver_stop_info(uuid,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.update_driver_stop_info(uuid,text,jsonb,jsonb,jsonb),
  public.update_driver_stop_info(uuid,text,jsonb,jsonb,jsonb) to authenticated;

create or replace function fleet_internal.attach_completed_load_paperwork(target_load uuid, target_stop text, documents jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.fleet_dispatch_loads l where l.id=target_load and l.status='completed'
  ) then
    raise exception 'This completed load is unavailable.' using errcode='42501';
  end if;
  if jsonb_typeof(documents) is distinct from 'array' or documents='[]'::jsonb then
    raise exception 'Attach paperwork as a list of files.' using errcode='22023';
  end if;
  perform fleet_internal.update_driver_stop_info(target_load,target_stop,'{}'::jsonb,'{}'::jsonb,documents);
end;
$$;

-- Paperwork and freight corrections on earlier stops leave the current equipment assignment intact.
create or replace function fleet_internal.track_driver_reported_trailer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  driver uuid := fleet_internal.workflow_driver(auth.uid(),new.fleet_id);
  report jsonb;
  next_trailer text;
  reported_type text;
  report_stop text;
  arrival_trailer text;
begin
  if driver is null or (driver is distinct from new.driver_id and driver is distinct from new.second_driver_id) then
    return new;
  end if;
  if new.progress->'yardPickedUpAt' is distinct from old.progress->'yardPickedUpAt' then
    select h.trailer into next_trailer from fleet_internal.driver_yard_handoffs h
    where h.load_id=new.id and h.offered_driver=driver and h.picked_up_at is not null;
  else
    select reports.current,stop.stop_key
    into report,report_stop
    from fleet_internal.driver_assigned_stops(new,driver) stop
    cross join lateral (select new.progress#>array['stops',stop.stop_key,'driverReport'] as current,
      old.progress#>array['stops',stop.stop_key,'driverReport'] as prior) reports
    where reports.current is not null and exists (
      select 1 from unnest(array['trailer','trailerType','bobtail','droppedTrailer','pickedTrailer']) field(key)
      where (reports.current->field.key) is distinct from (reports.prior->field.key)
    )
    order by stop.sequence_no desc limit 1;
    if nullif(report->>'droppedTrailer','') is not null then
      arrival_trailer := case
        when old.details->>'trailerDrop'='yes' and old.details->>'trailerDropStopId'=report_stop
          then nullif(btrim(old.details->>'trailerDropNumber'),'') end;
      arrival_trailer := coalesce(arrival_trailer,case when old.progress ? 'dispatchTrailerOverride'
        then old.progress->>'dispatchTrailerOverride'
        else old.progress #>> array['stops',report_stop,'arrivalTrailer'] end);
      if nullif(arrival_trailer,'') is not null and upper(arrival_trailer)<>upper(report->>'droppedTrailer') then
        raise exception 'The drop trailer must match your arrival trailer %.',arrival_trailer using errcode='22023';
      end if;
      if nullif(report->>'trailer','') is not null and nullif(report->>'pickedTrailer','') is null then
        raise exception 'Enter the trailer pickup number if you are leaving with a different trailer.' using errcode='22023';
      end if;
    end if;
    reported_type := report->>'trailerType';
    next_trailer := case
      when report->>'bobtail'='true' then 'Bobtail'
      when nullif(report->>'pickedTrailer','') is not null then report->>'pickedTrailer'
      when nullif(report->>'trailer','') is not null then report->>'trailer'
      when nullif(report->>'droppedTrailer','') is not null then 'Bobtail'
    end;
  end if;
  if next_trailer is not null then
    update public.fleet_dispatch_drivers d
    set assigned_trailer_number=next_trailer,
      assigned_trailer_type=coalesce(reported_type,
        case when upper(d.assigned_trailer_number)=upper(next_trailer) then d.assigned_trailer_type end)
    where d.fleet_id=new.fleet_id and d.id=driver and d.link_active
      and (d.assigned_trailer_number is distinct from next_trailer
        or (reported_type is not null and d.assigned_trailer_type is distinct from reported_type));
  end if;
  return new;
end;
$$;

-- Pickup photos may be attached while the driver is checked in. Keep them when recording departure.
create function fleet_internal.keep_pickup_paperwork_on_departure()
returns trigger language plpgsql set search_path = ''
as $$
declare
  stop_key text;
  old_state jsonb;
  new_state jsonb;
  report jsonb;
  combined jsonb;
begin
  if new.progress->'stops' is not distinct from old.progress->'stops' then return new; end if;
  for stop_key in select s.stop_key from fleet_internal.workflow_stops(new.details) s where s.kind='pickup' loop
    old_state := old.progress#>array['stops',stop_key];
    new_state := new.progress#>array['stops',stop_key];
    if old_state->>'completedAt' is not null or new_state->>'completedAt' is null
      or not exists (select 1 from fleet_internal.driver_report_documents(old_state->'driverReport')) then
      continue;
    end if;
    report := coalesce(new_state->'driverReport','{}'::jsonb);
    combined := fleet_internal.merge_driver_stop_documents(old_state->'driverReport',
      coalesce((select jsonb_agg(path order by file_order) from fleet_internal.driver_report_documents(report)),'[]'::jsonb));
    if jsonb_array_length(combined)>20 then
      raise exception 'This pickup is limited to 20 paperwork files. Remove extra files from this departure.' using errcode='22023';
    end if;
    new.progress := jsonb_set(new.progress,array['stops',stop_key,'driverReport'],
      report || jsonb_build_object('document',combined->>0,'documents',combined));
  end loop;
  return new;
end;
$$;
revoke all on function fleet_internal.keep_pickup_paperwork_on_departure() from public, anon, authenticated;
create trigger keep_pickup_paperwork_on_departure before update of progress on public.fleet_dispatch_loads
  for each row execute function fleet_internal.keep_pickup_paperwork_on_departure();
