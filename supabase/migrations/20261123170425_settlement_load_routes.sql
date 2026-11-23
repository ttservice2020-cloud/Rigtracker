create function fleet_internal.load_has_driver_bol(load public.fleet_dispatch_loads)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select 1 from fleet_internal.workflow_stops((load).details) s
    cross join lateral (select (load).progress#>array['stops',s.stop_key,'driverReport'] as data) r
    cross join lateral jsonb_array_elements_text(case
      when jsonb_typeof(r.data->'documents')='array' and r.data->'documents'<>'[]'::jsonb then r.data->'documents'
      when nullif(r.data->>'document','') is not null then jsonb_build_array(r.data->>'document')
      else '[]'::jsonb end) path(name)
    join storage.objects file on file.bucket_id='driver-load-documents' and file.name=path.name
    where s.kind='pickup' and split_part(path.name,'/',1)=(load).id::text
  );
$$;
revoke all on function fleet_internal.load_has_driver_bol(public.fleet_dispatch_loads) from public,anon,authenticated;

create or replace function fleet_internal.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',draft.id,'settlement_number',draft.settlement_number,'created_at',draft.created_at,
      'load_count',draft.load_count,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'pro_number',line.pro_number,'is_return',load.return_of is not null,
          'pickup',coalesce(line.load_snapshot->'pickup',load.details#>'{pickups,0}'),
          'receiver',coalesce(line.load_snapshot->'receiver',load.details#>'{receivers,0}'),
          'total_pay',line.total_pay,'has_signed_bol',fleet_internal.load_has_driver_bol(load),
          'loaded_miles',line.loaded_miles,'empty_miles',line.empty_miles,
          'pay_scale',line.pay_scale,'base_pay',line.base_pay,'base_pay_entered',line.base_pay_entered,
          'empty_mile_pay',line.empty_mile_pay,'stop_pay',line.stop_pay,'additional_pay',line.additional_pay
        ) order by line.created_at,line.pro_number),'[]'::jsonb)
        from fleet_internal.company_driver_settlement_lines line
        join public.fleet_dispatch_loads load on load.fleet_id=line.fleet_id and load.id=line.load_id
        where line.fleet_id=draft.fleet_id and line.settlement_id=draft.id
      ) end
    ) order by draft.created_at desc,draft.id)
    from fleet_internal.company_driver_settlements draft
    join public.rigtracker_profiles profile on profile.user_id=draft.driver_user_id
    cross join lateral (select exists (
      select 1 from fleet_internal.company_driver_pay_files f
      where f.fleet_id=draft.fleet_id and f.driver_id=draft.driver_user_id
        and (f.settlement_id=draft.id or lower(btrim(f.title))=lower(draft.settlement_number))
    ) as sent) publication
    where draft.fleet_id=target_fleet
      and case when requested_settlement_id is null then not publication.sent else draft.id=requested_settlement_id end
  ),'[]'::jsonb);
end;
$$;

create or replace function fleet_internal.company_driver_load_settlements(target_fleet text, target_profile text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  dispatch_driver uuid;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not fleet_internal.company_pay_staff(actor, target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode = '42501';
  end if;

  select link.dispatch_driver_id into dispatch_driver
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = target_fleet
    and profile.profile_id = target_profile
    and profile.profile_type = 'company_driver';

  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'load_id', load.id,
      'pro_number', load.pro_number,
      'is_return', load.return_of is not null,
      'has_signed_bol', fleet_internal.load_has_driver_bol(load),
      'route_number', load.details ->> 'routeNumber',
      'updated_at', load.updated_at,
      'completed_at', coalesce(nullif(load.progress->>'completedAt',''),load.updated_at::text),
      'created_settlement', case when settlement.id is not null then jsonb_build_object(
        'id',settlement.id,'number',settlement.settlement_number,'status',settlement.status,'line_total',line.total_pay) end,
      'pickup', load.details -> 'pickups' -> 0,
      'receiver', load.details -> 'receivers' -> 0,
      'freight', jsonb_build_object(
        'truckNumber', load.details -> 'truckNumber',
        'trailerNumber', load.details -> 'trailerNumber',
        'commodity', load.details -> 'commodity',
        'commodityOther', load.details -> 'commodityOther',
        'weightLbs', load.details -> 'weightLbs',
        'pieces', load.details -> 'pieces',
        'equipmentType', load.details -> 'equipmentType',
        'equipmentTypeOther', load.details -> 'equipmentTypeOther',
        'trailerDrop', load.details -> 'trailerDrop',
        'trailerDropNotes', load.details -> 'trailerDropNotes',
        'trailerPickup', load.details -> 'trailerPickup',
        'trailerPickupNotes', load.details -> 'trailerPickupNotes',
        'brokerName', load.details -> 'brokerName',
        'brokerPhone', load.details -> 'brokerPhone',
        'brokerEmail', load.details -> 'brokerEmail',
        'brokerLoadNumber', load.details -> 'brokerLoadNumber',
        'routeNumber', load.details -> 'routeNumber',
        'pickupNumber', load.details -> 'pickupNumber',
        'stopPay', load.details -> 'stopPay',
        'driver1AdditionalPay', load.details -> 'driver1AdditionalPay',
        'driver2AdditionalPay', load.details -> 'driver2AdditionalPay',
        'rateConfirmation', load.details -> 'rateConfirmation'
      ),
      'pickup_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'pickup',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'pickup-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'pickups', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'receiver_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'receiver',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'receiver-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'receivers', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'loaded_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegMiles', '')::numeric, nullif(load.details ->> 'loadedMiles', '')::numeric)
        else case when nullif(load.details ->> 'firstLegMiles', '') is null
          then nullif(load.details ->> 'loadedMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'loadedMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegMiles', '')::numeric) end end,
      'empty_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric,
          case when load.second_driver_id is null then nullif(load.details ->> 'emptyMiles', '')::numeric else null end)
        else case when nullif(load.details ->> 'firstLegEmptyMiles', '') is null
          then nullif(load.details ->> 'emptyMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric) end end,
      'gross', nullif(load.details ->> 'payGross', '')::numeric,
      'stop_pay', case when load.driver_id = dispatch_driver then coalesce(nullif(load.details ->> 'stopPay', '')::numeric, 0) else 0 end,
      'driver_slot', case when load.driver_id = dispatch_driver then 1 else 2 end,
      'pay_scale', (
        select jsonb_build_object(
          'driver_type', driver.driver_type,
          'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
          'split_percent', driver.split_percent,
          'mile_rate', driver.mile_rate,
          'empty_mile_rate', driver.empty_mile_rate
        )
        from public.fleet_dispatch_drivers driver
        where driver.id = dispatch_driver and driver.fleet_id = target_fleet
      ),
      'pay_entry', (
        select entry.value
        from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) entry(value)
        where entry.value ->> 'slot' = case when load.driver_id = dispatch_driver then '1' else '2' end
        limit 1
      ),
      'manual_pay', nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1Pay' else 'driver2Pay' end, '')::numeric,
      'additional_pay', coalesce(nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1AdditionalPay' else 'driver2AdditionalPay' end, '')::numeric, 0)
    ) order by load.updated_at desc)
    from public.fleet_dispatch_loads load
    left join fleet_internal.company_driver_settlement_lines line
      on line.fleet_id=load.fleet_id and line.load_id=load.id and line.driver_profile_id=target_profile
    left join fleet_internal.company_driver_settlements settlement
      on settlement.fleet_id=load.fleet_id and settlement.id=line.settlement_id
    where load.fleet_id = target_fleet
      and load.status = 'completed'
      and (settlement.id is not null or fleet_internal.load_ready_for_settlement(load))
      and (load.driver_id = dispatch_driver or load.second_driver_id = dispatch_driver)
  ), '[]'::jsonb);
end;
$function$;

