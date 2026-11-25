create function fleet_internal.save_dispatch_stop_info(
  target_load uuid, target_stop text, expected_updated_at timestamptz, editing_session uuid, load_info jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  selected_stop record;
  stop_state jsonb;
  previous_report jsonb;
  report jsonb;
  fields jsonb;
  trailer text;
  pickup_trailer text;
begin
  select l.* into load from public.fleet_dispatch_loads l
    where l.id=target_load and l.status in ('current','completed') and actor is not null
      and fleet_internal.office_has_permission(l.fleet_id,'dispatch') for update;
  if not found then
    raise exception 'This load is unavailable for Dispatch.' using errcode='42501';
  end if;
  if not exists (
    select 1 from fleet_internal.dispatch_load_leases lease
    where lease.load_id=load.id and lease.holder=actor and lease.session_id=editing_session
      and lease.expires_at>clock_timestamp()
  ) then
    raise exception 'Open this load for editing before saving load info.' using errcode='55P03';
  end if;
  if expected_updated_at is distinct from load.updated_at then
    raise exception 'The load changed. Reopen Add Load Info to review the latest details.' using errcode='40001';
  end if;

  select stop.kind,stop.sequence_no into selected_stop
    from fleet_internal.workflow_stops(load.details) stop where stop.stop_key=target_stop;
  if not found then
    raise exception 'Choose a pickup or delivery on this load.' using errcode='22023';
  end if;
  if jsonb_typeof(load_info) is distinct from 'object' or octet_length(load_info::text)>2000 then
    raise exception 'Enter valid load info.' using errcode='22023';
  end if;
  if exists (
    select 1 from jsonb_each(load_info) field
    where field.key not in ('trailer','commodity','weight','pieces','bol')
      or jsonb_typeof(field.value) not in ('null','string')
      or char_length(field.value#>>'{}') > case field.key
        when 'trailer' then 40 when 'commodity' then 120 when 'bol' then 100 else 20 end
  ) then
    raise exception 'One or more load info fields are invalid.' using errcode='22023';
  end if;

  select coalesce(jsonb_object_agg(field.key,nullif(btrim(field.value),'')),'{}'::jsonb)
    into fields from jsonb_each_text(load_info) field;
  if coalesce(fields->>'weight','0') !~ '^[0-9]+([.][0-9]{1,2})?$'
    or coalesce(fields->>'pieces','0') !~ '^[0-9]+$' then
    raise exception 'Enter a valid weight and a whole number of pieces.' using errcode='22023';
  end if;

  stop_state := coalesce(load.progress#>array['stops',target_stop],'{}'::jsonb);
  previous_report := coalesce(stop_state->'driverReport','{}'::jsonb);
  report := (previous_report - array(select field.key from jsonb_each(fields) field where field.value='null'::jsonb))
    || jsonb_strip_nulls(fields);
  trailer := report->>'trailer';
  if (report->>'trailer') is distinct from (previous_report->>'trailer') then
    if previous_report->>'bobtail'='true' or (
      nullif(previous_report->>'pickedTrailer','') is not null
      and upper(trailer) is distinct from upper(previous_report->>'pickedTrailer')
    ) then
      raise exception 'The trailer number conflicts with the recorded bobtail or trailer pickup.' using errcode='22023';
    end if;
    report := report - 'trailerType';
    -- Do not replace the current load's equipment with a trailer from an earlier stop or relay leg.
    if trailer is not null and load.status='current' and selected_stop.kind='pickup'
      and stop_state ? 'arrivalAt'
      and load.progress#>>'{relay,droppedAt}' is null and load.progress->>'yardPickedUpAt' is null
      and not exists (
        select 1 from fleet_internal.workflow_stops(load.details) later
        where later.sequence_no>selected_stop.sequence_no
          and (load.progress#>array['stops',later.stop_key]) ?| array['arrivalAt','completedAt']
      ) and not exists (
        select 1 from fleet_internal.workflow_stops(load.details) earlier
        where earlier.sequence_no<selected_stop.sequence_no
          and load.progress#>>array['stops',earlier.stop_key,'completedAt'] is null
      ) then
      pickup_trailer := trailer;
      load.progress := load.progress - 'dispatchTrailerOverride';
    end if;
  end if;
  if report=previous_report then return to_jsonb(load); end if;

  -- Keep driver submission time, attachments, charges and dispatch review state.
  stop_state := stop_state || jsonb_build_object('driverReport',
    report || jsonb_build_object('dispatchEnteredAt',clock_timestamp()));
  perform fleet_internal.write_driver_progress(load.id,jsonb_set(load.progress,'{stops}',
    coalesce(load.progress->'stops','{}'::jsonb) || jsonb_build_object(target_stop,stop_state)),pickup_trailer);
  select l.* into load from public.fleet_dispatch_loads l where l.id=target_load;
  return to_jsonb(load);
end;
$$;

create function public.save_dispatch_stop_info(
  target_load uuid, target_stop text, expected_updated_at timestamptz, editing_session uuid, load_info jsonb
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.save_dispatch_stop_info(target_load,target_stop,expected_updated_at,editing_session,load_info);
$$;

revoke all on function fleet_internal.save_dispatch_stop_info(uuid,text,timestamptz,uuid,jsonb),
  public.save_dispatch_stop_info(uuid,text,timestamptz,uuid,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.save_dispatch_stop_info(uuid,text,timestamptz,uuid,jsonb),
  public.save_dispatch_stop_info(uuid,text,timestamptz,uuid,jsonb) to authenticated;
