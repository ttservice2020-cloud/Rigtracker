create or replace function fleet_internal.update_driver_stop_info(
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
  expected_trailer text;
  pickup_trailer text;
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
      where field.key not in ('pickupTrailer','commodity','weight','pieces','bol')
        or jsonb_typeof(field.value) not in ('null','string')
        or char_length(field.value#>>'{}') > case field.key when 'pickupTrailer' then 40 when 'commodity' then 120 when 'bol' then 100 else 20 end
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
    if changed_fields ? 'pickupTrailer' then
      if previous_report->>'bobtail'='true' or coalesce(nullif(previous_report->>'trailer',''),
        nullif(previous_report->>'pickedTrailer',''),nullif(previous_report->>'droppedTrailer','')) is not null then
        raise exception 'Dispatch can correct a trailer already recorded for this stop.' using errcode='22023', hint='pickup_trailer';
      end if;
      pickup_trailer := nullif(changed_fields->>'pickupTrailer','');
      expected_trailer := case
        when load.details->>'trailerPickup'='yes' and load.details->>'trailerPickupStopId'=target_stop
          and load.details->>'trailerPickupMode' is distinct from 'bobtail'
          and nullif(btrim(load.details->>'trailerPickupNumber'),'') is not null
          then btrim(load.details->>'trailerPickupNumber')
        when load.status<>'completed' and stop_state->>'completedAt' is null then
          case when load.progress ? 'dispatchTrailerOverride' then load.progress->>'dispatchTrailerOverride'
            when stop_state ? 'arrivalTrailer' then stop_state->>'arrivalTrailer'
            else fleet_internal.driver_incoming_trailer(load,assigned,target_stop) end
        else stop_state->>'arrivalTrailer'
      end;
      if pickup_trailer is not null and nullif(btrim(expected_trailer),'') is not null
        and upper(pickup_trailer)<>upper(btrim(expected_trailer)) then
        raise exception 'Trailer number must match % for this pickup.', expected_trailer using errcode='22023', hint='pickup_trailer';
      end if;
    end if;
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
