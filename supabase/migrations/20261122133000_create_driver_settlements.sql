create table if not exists fleet_internal.company_driver_settlements (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_profile_id text not null,
  driver_user_id uuid not null references auth.users(id),
  settlement_number text not null,
  status text not null default 'draft' check (status in ('draft')),
  total_pay numeric(14,2) not null default 0 check (total_pay >= 0),
  load_count integer not null default 0 check (load_count > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (fleet_id, settlement_number)
);

create table if not exists fleet_internal.company_driver_settlement_lines (
  fleet_id text not null references public.fleets(id) on delete cascade,
  settlement_id uuid not null references fleet_internal.company_driver_settlements(id) on delete cascade,
  load_id uuid not null,
  driver_profile_id text not null,
  pro_number bigint not null,
  loaded_miles numeric,
  empty_miles numeric,
  pay_scale jsonb not null default '{}'::jsonb,
  base_pay numeric(14,2) not null default 0,
  base_pay_entered boolean not null default false,
  empty_mile_pay numeric(14,2) not null default 0,
  stop_pay numeric(14,2) not null default 0,
  additional_pay numeric(14,2) not null default 0,
  total_pay numeric(14,2) not null default 0,
  load_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key (settlement_id, load_id),
  unique (fleet_id, load_id, driver_profile_id),
  foreign key (fleet_id, load_id) references public.fleet_dispatch_loads(fleet_id, id)
);

alter table fleet_internal.company_driver_settlements enable row level security;
alter table fleet_internal.company_driver_settlement_lines enable row level security;
revoke all on fleet_internal.company_driver_settlements, fleet_internal.company_driver_settlement_lines from public, anon, authenticated;

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
  new_number text := 'SET-' || upper(left(new_id::text, 8));
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
  select count(*) into valid_count
  from public.fleet_dispatch_loads l
  where l.fleet_id = target_fleet and l.status = 'completed'
    and l.id = any(requested_load_ids)
    and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver);
  if valid_count <> requested_count then
    raise exception 'One or more loads are not completed or assigned to this driver.' using errcode = '22023';
  end if;

  insert into fleet_internal.company_driver_settlements
    (id, fleet_id, driver_profile_id, driver_user_id, settlement_number, created_by)
  values (new_id, target_fleet, target_profile, driver_user, new_number, actor);

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

create or replace function public.create_company_driver_settlement(
  target_fleet text, target_profile text, requested_load_ids uuid[]
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select fleet_internal.create_company_driver_settlement(target_fleet, target_profile, requested_load_ids);
$function$;

revoke all on function fleet_internal.create_company_driver_settlement(text, text, uuid[]) from public, anon;
grant execute on function fleet_internal.create_company_driver_settlement(text, text, uuid[]) to authenticated;
revoke all on function public.create_company_driver_settlement(text, text, uuid[]) from public, anon;
grant execute on function public.create_company_driver_settlement(text, text, uuid[]) to authenticated;


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
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not fleet_internal.company_pay_staff(actor, target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode = '42501';
  end if;
  select link.dispatch_driver_id into dispatch_driver
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = target_fleet and profile.profile_id = target_profile
    and profile.profile_type = 'company_driver';
  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'load_id', load.id, 'pro_number', load.pro_number, 'is_return', load.return_of is not null,
      'route_number', load.details ->> 'routeNumber', 'updated_at', load.updated_at,
      'pickup', load.details -> 'pickups' -> 0, 'receiver', load.details -> 'receivers' -> 0,
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
      'pay_scale', (select jsonb_build_object('driver_type', driver.driver_type,
        'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
        'split_percent', driver.split_percent, 'mile_rate', driver.mile_rate, 'empty_mile_rate', driver.empty_mile_rate)
        from public.fleet_dispatch_drivers driver where driver.id = dispatch_driver and driver.fleet_id = target_fleet),
      'pay_entry', (select entry.value from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) entry(value)
        where entry.value ->> 'slot' = case when load.driver_id = dispatch_driver then '1' else '2' end limit 1),
      'manual_pay', nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1Pay' else 'driver2Pay' end, '')::numeric,
      'additional_pay', coalesce(nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1AdditionalPay' else 'driver2AdditionalPay' end, '')::numeric, 0),
      'created_settlement', (select jsonb_build_object('id', settlement.id, 'number', settlement.settlement_number,
        'status', settlement.status, 'total_pay', settlement.total_pay, 'created_at', settlement.created_at,
        'line_total', line.total_pay, 'base_pay_entered', line.base_pay_entered)
        from fleet_internal.company_driver_settlement_lines line
        join fleet_internal.company_driver_settlements settlement on settlement.id = line.settlement_id
        where line.fleet_id = target_fleet and line.load_id = load.id and line.driver_profile_id = target_profile
        limit 1)
    ) order by load.updated_at desc)
    from public.fleet_dispatch_loads load
    where load.fleet_id = target_fleet and load.status = 'completed'
      and (load.driver_id = dispatch_driver or load.second_driver_id = dispatch_driver)
  ), '[]'::jsonb);
end;
$function$;
