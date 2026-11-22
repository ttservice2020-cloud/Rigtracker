create or replace function fleet_internal.stamp_dispatch_load_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if new.status='completed' then
    if tg_op='INSERT' then
      if nullif(new.progress->>'completedAt','') is null then
        new.progress := new.progress || jsonb_build_object('completedAt',new.updated_at);
      end if;
    elsif old.status is distinct from 'completed' then
      new.progress := new.progress || jsonb_build_object('completedAt',new.updated_at);
    elsif nullif(new.progress->>'completedAt','') is null then
      -- Older history rows used their last update as their completion date.
      new.progress := new.progress || jsonb_build_object('completedAt',old.updated_at);
    end if;
  end if;
  if new.status = 'current' then
    if tg_op = 'INSERT' then
      new.assigned_at := new.updated_at;
    elsif old.status is distinct from 'current' then
      new.assigned_at := new.updated_at;
    end if;
  end if;
  return new;
end;
$$;

-- Only loads approved at least two hours before the current hourly boundary are available.
create function fleet_internal.load_ready_for_settlement(load public.fleet_dispatch_loads)
returns boolean language sql stable set search_path = ''
as $$
  select coalesce(nullif((load).progress->>'completedAt','')::timestamptz,(load).updated_at)
    <= date_trunc('hour',statement_timestamp(),'UTC') - interval '2 hours';
$$;
revoke all on function fleet_internal.load_ready_for_settlement(public.fleet_dispatch_loads) from public, anon, authenticated;

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

create or replace function fleet_internal.create_company_driver_settlement(
  target_fleet text,
  target_profile text,
  requested_load_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  driver_user uuid;
  dispatch_driver uuid;
  driver public.fleet_dispatch_drivers%rowtype;
  load public.fleet_dispatch_loads%rowtype;
  new_id uuid := gen_random_uuid();
  new_number text;
  requested_count integer;
  valid_count integer;
  slot integer;
  pay_entry jsonb;
  loaded numeric;
  empty numeric;
  gross numeric;
  raw_total numeric;
  raw_base numeric;
  empty_pay numeric;
  additional numeric;
  stop_amount numeric;
  base numeric;
  total numeric;
  base_entered boolean;
  scale jsonb;
  line_count integer := 0;
  grand_total numeric := 0;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not fleet_internal.company_pay_staff(actor, target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode = '42501';
  end if;
  if requested_load_ids is null or cardinality(requested_load_ids) = 0
    or cardinality(requested_load_ids) <> (select count(distinct id) from unnest(requested_load_ids) as ids(id)) then
    raise exception 'Select one or more completed loads.' using errcode = '22023';
  end if;

  select profile.user_id, link.dispatch_driver_id
    into driver_user, dispatch_driver
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = target_fleet
    and profile.profile_id = target_profile
    and profile.profile_type = 'company_driver';

  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;

  select * into driver
  from public.fleet_dispatch_drivers
  where fleet_id = target_fleet and id = dispatch_driver;
  if not found then raise exception 'Driver pay profile is unavailable.' using errcode = '42501'; end if;

  select count(*) into requested_count from unnest(requested_load_ids);
  select count(*) into valid_count from (
    select l.id
    from public.fleet_dispatch_loads l
    where l.fleet_id = target_fleet and l.status = 'completed'
      and l.id = any(requested_load_ids)
      and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver)
      and fleet_internal.load_ready_for_settlement(l)
    order by l.id for share
  ) eligible;
  if valid_count <> requested_count then
    raise exception 'Select completed loads for this driver that have cleared the two-hour hold and hourly release.'
      using errcode = '22023';
  end if;

  new_number := fleet_internal.next_company_settlement_number(target_fleet,driver_user);

  insert into fleet_internal.company_driver_settlements
    (id, fleet_id, driver_profile_id, driver_user_id, settlement_number, load_count, created_by)
  values (new_id, target_fleet, target_profile, driver_user, new_number, requested_count, actor);

  for load in
    select l.* from public.fleet_dispatch_loads l
    where l.fleet_id = target_fleet and l.status = 'completed'
      and l.id = any(requested_load_ids)
      and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver)
    order by l.updated_at, l.pro_number
  loop
    slot := case when load.driver_id = dispatch_driver then 1 else 2 end;
    select item.value into pay_entry
    from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) item(value)
    where item.value ->> 'slot' = slot::text limit 1;

    if slot = 1 then
      loaded := coalesce(nullif(load.details ->> 'firstLegMiles', '')::numeric, nullif(load.details ->> 'loadedMiles', '')::numeric);
      empty := coalesce(nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric,
        case when load.second_driver_id is null then nullif(load.details ->> 'emptyMiles', '')::numeric end, 0);
      raw_base := coalesce(nullif(pay_entry ->> 'amount', '')::numeric, nullif(load.details ->> 'driver1Pay', '')::numeric);
      additional := coalesce(nullif(pay_entry ->> 'additionalPay', '')::numeric,
        nullif(load.details ->> 'driver1AdditionalPay', '')::numeric, 0);
      stop_amount := coalesce(nullif(load.details ->> 'stopPay', '')::numeric, 0);
    else
      loaded := case when nullif(load.details ->> 'firstLegMiles', '') is null
        then nullif(load.details ->> 'loadedMiles', '')::numeric
        else greatest(0, coalesce(nullif(load.details ->> 'loadedMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegMiles', '')::numeric) end;
      empty := case when nullif(load.details ->> 'firstLegEmptyMiles', '') is null
        then coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0)
        else greatest(0, coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric) end;
      raw_base := coalesce(nullif(pay_entry ->> 'amount', '')::numeric, nullif(load.details ->> 'driver2Pay', '')::numeric);
      additional := coalesce(nullif(pay_entry ->> 'additionalPay', '')::numeric,
        nullif(load.details ->> 'driver2AdditionalPay', '')::numeric, 0);
      stop_amount := 0;
    end if;

    gross := nullif(load.details ->> 'payGross', '')::numeric;
    raw_total := nullif(pay_entry ->> 'totalPay', '')::numeric;
    empty_pay := coalesce(nullif(pay_entry ->> 'emptyPay', '')::numeric, empty * coalesce(driver.empty_mile_rate, 0));
    scale := jsonb_build_object(
      'driver_type', driver.driver_type,
      'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
      'split_percent', driver.split_percent,
      'mile_rate', driver.mile_rate,
      'empty_mile_rate', driver.empty_mile_rate
    );

    base := 0;
    base_entered := false;
    if raw_total is not null then
      base := raw_total;
      base_entered := true;
      empty_pay := 0;
      additional := 0;
    elsif raw_base is not null then
      base := raw_base;
      base_entered := true;
    elsif driver.pay_method = 'per_mile' and loaded is not null and driver.mile_rate is not null then
      base := loaded * driver.mile_rate;
      base_entered := true;
    elsif driver.pay_method = 'load_percent' and gross is not null and driver.split_percent is not null then
      base := gross * driver.split_percent / 100;
      base_entered := true;
    elsif driver.pay_method = 'higher_of' and gross is not null and loaded is not null
      and driver.split_percent is not null and driver.mile_rate is not null then
      base := greatest(gross * driver.split_percent / 100, loaded * driver.mile_rate);
      base_entered := true;
    end if;

    total := base + empty_pay + additional + stop_amount;
    grand_total := grand_total + total;
    line_count := line_count + 1;

    insert into fleet_internal.company_driver_settlement_lines
      (fleet_id, settlement_id, load_id, driver_profile_id, pro_number, loaded_miles, empty_miles, pay_scale,
       base_pay, base_pay_entered, empty_mile_pay, stop_pay, additional_pay, total_pay, load_snapshot)
    values (
      target_fleet, new_id, load.id, target_profile, load.pro_number, loaded, empty, scale,
      base, base_entered, empty_pay, stop_amount, additional, total,
      jsonb_build_object('route_number', load.details ->> 'routeNumber',
        'pickup', load.details -> 'pickups' -> 0, 'receiver', load.details -> 'receivers' -> 0,
        'gross', gross, 'pay_entry', pay_entry, 'updated_at', load.updated_at)
    );
  end loop;

  update fleet_internal.company_driver_settlements
  set total_pay = grand_total, load_count = line_count
  where id = new_id;

  return jsonb_build_object('id', new_id, 'settlement_number', new_number,
    'total_pay', grand_total, 'load_count', line_count, 'status', 'draft');
exception
  when unique_violation then
    raise exception 'One or more loads are already included in another settlement.' using errcode = '23505';
end;
$function$;
