alter table public.fleet_dispatch_drivers
  add column empty_mile_rate numeric(8,4),
  add constraint fleet_dispatch_driver_empty_mile_rate check (
    empty_mile_rate is null or (
      coalesce(driver_type = 'owner_op' and pay_method in ('split','per_mile'), false)
      and empty_mile_rate between 0 and 9999
    )
  );

grant insert (empty_mile_rate), update (empty_mile_rate) on public.fleet_dispatch_drivers to authenticated;

alter table public.fleet_dispatch_drivers
  drop constraint fleet_dispatch_driver_pay_profile,
  add constraint fleet_dispatch_driver_pay_profile check (
    case driver_type
      when 'company' then
        case
          when pay_method is null or pay_method = 'hourly' then split_percent is null and mile_rate is null
          when pay_method = 'load_percent' then split_percent is not null and split_percent between 0 and 100 and mile_rate is null
          when pay_method = 'per_mile' then split_percent is null and mile_rate is not null and mile_rate between 0 and 9999
          when pay_method = 'higher_of' then split_percent is not null and split_percent between 0 and 100
            and mile_rate is not null and mile_rate between 0 and 9999
          else false
        end
      when 'owner_op' then
        case pay_method
          when 'hourly' then split_percent is null and mile_rate is null
          when 'split' then split_percent is not null and split_percent between 0 and 100 and mile_rate is null
          when 'per_mile' then split_percent is null and mile_rate is not null and mile_rate between 0 and 9999
          else false
        end
      else driver_type is null and pay_method is null and split_percent is null and mile_rate is null
    end
  );

create or replace function fleet_internal.protect_dispatch_pay_profile()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or fleet_internal.office_has_permission(new.fleet_id,'official') then
    return new;
  end if;
  if tg_op='INSERT' then
    if new.driver_type is null and new.pay_method is null and new.split_percent is null and new.mile_rate is null and new.empty_mile_rate is null then return new; end if;
  elsif (new.driver_type,new.pay_method,new.split_percent,new.mile_rate,new.empty_mile_rate) is not distinct from
        (old.driver_type,old.pay_method,old.split_percent,old.mile_rate,old.empty_mile_rate) then
    return new;
  end if;
  raise exception 'Only a Fleet Admin or Official can change a driver pay profile.' using errcode='42501';
end;
$$;
revoke all on function fleet_internal.protect_dispatch_pay_profile() from public,anon,authenticated;
drop trigger protect_dispatch_pay_profile on public.fleet_dispatch_drivers;
create trigger protect_dispatch_pay_profile before insert or update of driver_type,pay_method,split_percent,mile_rate,empty_mile_rate
  on public.fleet_dispatch_drivers for each row execute function fleet_internal.protect_dispatch_pay_profile();

create or replace function fleet_internal.dispatch_pay_inputs(details jsonb)
returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select jsonb_build_array(
    nullif(details #>> '{pickups,0,date}', ''), nullif(details ->> 'loadedMiles', ''),
    nullif(details ->> 'firstLegMiles', ''), nullif(details ->> 'payGross', ''),
    nullif(details ->> 'driver1Pay', ''), nullif(details ->> 'driver2Pay', ''),
    nullif(details ->> 'fuelSurchargeOverride', ''), nullif(details ->> 'emptyMiles', ''),
    nullif(details ->> 'firstLegEmptyMiles', '')
  );
$$;

CREATE OR REPLACE FUNCTION public.calculate_dispatch_driver_pay(requested_fleet_id text, first_driver_id uuid, second_driver_id uuid, requested_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  pickup_day date;
  pickup_week date;
  miles numeric;
  first_leg numeric;
  empty_miles numeric;
  first_empty_leg numeric;
  driver_empty_miles numeric;
  empty_pay numeric;
  linehaul_pay numeric;
  override_rate numeric;
  gross numeric;
  rate numeric;
  surcharge numeric;
  split_base numeric;
  combined_split numeric;
  driver_slot record;
  pay numeric;
  driver_miles numeric;
  percent_pay numeric;
  mileage_pay numeric;
  winning_method text;
  pending text;
  drivers jsonb := '[]';
  has_pending boolean := false;
begin
  if current_user = 'authenticated' and not fleet_internal.office_has_permission(requested_fleet_id,'dispatch') then
    raise exception 'Dispatch access is required to calculate driver pay.' using errcode = '42501';
  end if;
  if requested_details #>> '{pickups,0,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_input_is_valid(requested_details #>> '{pickups,0,date}', 'date') then
    pickup_day := (requested_details #>> '{pickups,0,date}')::date;
    pickup_week := pickup_day - (extract(isodow from pickup_day)::integer - 1);
  end if;
  if requested_details ->> 'loadedMiles' ~ '^([0-9]{1,9}(\.[0-9]{0,4})?|\.[0-9]{1,4})$' then
    miles := (requested_details ->> 'loadedMiles')::numeric;
  end if;
  if requested_details ->> 'firstLegMiles' ~ '^([0-9]{1,9}(\.[0-9]{0,4})?|\.[0-9]{1,4})$' then
    first_leg := (requested_details ->> 'firstLegMiles')::numeric;
  end if;
  if requested_details ->> 'payGross' ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$' then
    gross := (requested_details ->> 'payGross')::numeric;
  end if;
  if requested_details ->> 'emptyMiles' ~ '^[0-9]{1,9}(\.[0-9]{1,4})?$' then
    empty_miles := (requested_details ->> 'emptyMiles')::numeric;
  end if;
  if requested_details ->> 'firstLegEmptyMiles' ~ '^[0-9]{1,9}(\.[0-9]{1,4})?$' then
    first_empty_leg := (requested_details ->> 'firstLegEmptyMiles')::numeric;
  end if;
  if requested_details ->> 'fuelSurchargeOverride' ~ '^[0-9]{1,4}(\.[0-9]{1,4})?$' then
    override_rate := (requested_details ->> 'fuelSurchargeOverride')::numeric;
  end if;
  if override_rate > 9999 then override_rate := null; end if;
  select cents_per_mile into rate from public.fleet_dispatch_fuel_rates
    where fleet_id = requested_fleet_id and week_start = pickup_week;
  rate := coalesce(override_rate, rate);
  surcharge := round(miles * rate / 100, 2);
  split_base := gross - surcharge;
  select coalesce(sum(split_percent), 0) into combined_split
    from public.fleet_dispatch_drivers
    where fleet_id = requested_fleet_id and id in (first_driver_id, second_driver_id)
      and pay_method = 'split';

  for driver_slot in
    select slots.slot, d.id, d.driver_type, d.pay_method, d.split_percent, d.mile_rate, d.empty_mile_rate
    from (values (1, first_driver_id), (2, second_driver_id)) as slots(slot, driver_id)
    join public.fleet_dispatch_drivers d on d.fleet_id = requested_fleet_id and d.id = slots.driver_id
    order by slots.slot
  loop
    pay := null;
    pending := null;
    percent_pay := null;
    mileage_pay := null;
    winning_method := null;
    driver_miles := null;
    driver_empty_miles := null;
    empty_pay := null;
    linehaul_pay := null;
    if driver_slot.pay_method in ('per_mile', 'higher_of') then
      if second_driver_id is null then
        driver_miles := miles;
      elsif first_leg between 0 and miles then
        driver_miles := case when driver_slot.slot = 1 then first_leg else miles - first_leg end;
      end if;
      mileage_pay := round(driver_miles * driver_slot.mile_rate, 2);
    end if;
    if driver_slot.pay_method in ('load_percent', 'higher_of') then
      percent_pay := round(gross * driver_slot.split_percent / 100, 2);
    end if;
    case driver_slot.pay_method
      when 'split' then
        pending := case
          when gross is null then 'Enter the gross load amount.'
          when miles is null then 'Enter route loaded miles.'
          when pickup_week is null and override_rate is null then 'Enter the first pickup date.'
          when rate is null then 'Set the fuel surcharge for the pickup week.'
          when split_base < 0 then 'Gross is below the fuel surcharge.'
          when combined_split > 100 then 'The two driver splits exceed 100% of the load.'
        end;
        if pending is null then pay := round(split_base * driver_slot.split_percent / 100, 2); end if;
      when 'load_percent' then
        if gross is null then pending := 'Enter the gross broker rate.';
        else pay := percent_pay;
        end if;
      when 'per_mile' then
        if miles is null then pending := 'Enter route loaded miles.';
        elsif driver_miles is null then pending := 'Enter Driver 1 leg miles in Split Load Details.';
        else pay := mileage_pay;
        end if;
      when 'higher_of' then
        if gross is null then pending := 'Enter the gross broker rate.';
        elsif miles is null then pending := 'Enter route loaded miles.';
        elsif driver_miles is null then pending := 'Enter Driver 1 leg miles in Split Load Details.';
        else
          pay := greatest(percent_pay, mileage_pay);
          winning_method := case when percent_pay > mileage_pay then 'load_percent'
            when mileage_pay > percent_pay then 'per_mile' else 'tie' end;
        end if;
      when 'hourly' then null;
      else null;
    end case;
    if driver_slot.empty_mile_rate is not null then
      linehaul_pay := pay;
      if coalesce(empty_miles, 0) = 0 then driver_empty_miles := 0;
      elsif second_driver_id is null then driver_empty_miles := empty_miles;
      elsif first_empty_leg between 0 and empty_miles then
        driver_empty_miles := case when driver_slot.slot = 1 then first_empty_leg else empty_miles - first_empty_leg end;
      end if;
      if driver_empty_miles is null then
        pending := coalesce(pending, 'Enter Driver 1 empty miles to allocate empty-mile pay.');
        pay := null;
      else
        empty_pay := round(driver_empty_miles * driver_slot.empty_mile_rate, 2);
        pay := pay + empty_pay;
      end if;
    end if;
    has_pending := has_pending or pending is not null;
    drivers := drivers || jsonb_build_array(jsonb_build_object(
      'slot', driver_slot.slot, 'driverId', driver_slot.id, 'type', driver_slot.driver_type,
      'method', driver_slot.pay_method, 'amount', pay, 'pending', pending,
      'splitPercent', driver_slot.split_percent, 'mileRate', driver_slot.mile_rate, 'miles', driver_miles,
      'percentAmount', percent_pay, 'mileageAmount', mileage_pay, 'winningMethod', winning_method,
      'emptyMileRate', driver_slot.empty_mile_rate, 'emptyMiles', driver_empty_miles,
      'emptyPay', empty_pay, 'linehaulPay', linehaul_pay
    ));
  end loop;

  return jsonb_build_object(
    'drivers', drivers, 'pending', has_pending, 'gross', gross, 'loadedMiles', miles,
    'weekStart', pickup_week, 'fuelRateCents', rate, 'fuelOverride', override_rate is not null, 'fuelSurcharge', surcharge, 'splitBase', split_base
  );
end;
$function$;

create or replace function fleet_internal.add_dispatch_coverage_pay(calculation jsonb, details jsonb)
returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select jsonb_set(calculation, '{drivers}', coalesce(jsonb_agg(driver || jsonb_build_object(
    'additionalPay', additional,
    'totalPay', base_pay + additional
  ) order by position), '[]'::jsonb))
  from jsonb_array_elements(calculation -> 'drivers') with ordinality as slots(driver, position)
  cross join lateral (
    select details ->> ('driver' || (driver ->> 'slot') || 'AdditionalPay') as extra_text,
           details ->> ('driver' || (driver ->> 'slot') || 'Pay') as manual_text
  ) as inputs
  cross join lateral (
    select coalesce(nullif(extra_text, '')::numeric, 0) as additional,
      case
        when driver ->> 'type' = 'owner_op' or driver ->> 'method' in ('load_percent', 'per_mile', 'higher_of') then (driver ->> 'amount')::numeric
        when manual_text ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$' then manual_text::numeric
      end as base_pay
  ) as amounts;
$$;

create or replace function fleet_internal.driver_offer_pay(details jsonb, assigned uuid, profile_type text, active_method text)
returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select case
    when active_method='hourly' or entry ->> 'method'='hourly' then null
    when profile_type='company_driver' and entry ->> 'type'='company'
      and entry ->> 'method' in ('load_percent', 'per_mile', 'higher_of') then
      jsonb_strip_nulls(jsonb_build_object(
        'type','company','method',entry -> 'method','amount',entry -> 'amount',
        'pending',entry -> 'pending','additionalPay',entry -> 'additionalPay','totalPay',entry -> 'totalPay',
        'splitPercent',entry -> 'splitPercent',
        'mileRate',entry -> 'mileRate','miles',entry -> 'miles',
        'percentAmount',entry -> 'percentAmount','mileageAmount',entry -> 'mileageAmount',
        'winningMethod',entry -> 'winningMethod'))
    when profile_type='company_driver' and coalesce(entry ->> 'type','company')='company'
      and (manual_pay is not null or entry ->> 'additionalPay' is not null) then
      jsonb_strip_nulls(jsonb_build_object(
        'type','company','amount',manual_pay,'additionalPay',entry -> 'additionalPay',
        'totalPay',entry -> 'totalPay'))
    when profile_type='driver' and entry ->> 'type'='owner_op' and entry ->> 'method'='split' then
      jsonb_strip_nulls(jsonb_build_object(
        'type','owner_op','method','split','amount',entry -> 'amount',
        'emptyMileRate',entry -> 'emptyMileRate','emptyMiles',entry -> 'emptyMiles',
        'emptyPay',entry -> 'emptyPay','linehaulPay',entry -> 'linehaulPay',
        'additionalPay',entry -> 'additionalPay','totalPay',entry -> 'totalPay',
        'splitPercent',entry -> 'splitPercent','gross',details #> '{driverPay,gross}',
        'loadedMiles',details #> '{driverPay,loadedMiles}','fuelRateCents',details #> '{driverPay,fuelRateCents}',
        'fuelSurcharge',details #> '{driverPay,fuelSurcharge}','splitBase',details #> '{driverPay,splitBase}'))
    when profile_type='driver' and entry ->> 'type'='owner_op' and entry ->> 'method'='per_mile' then
      jsonb_strip_nulls(jsonb_build_object(
        'type','owner_op','method','per_mile','amount',entry -> 'amount',
        'emptyMileRate',entry -> 'emptyMileRate','emptyMiles',entry -> 'emptyMiles',
        'emptyPay',entry -> 'emptyPay','linehaulPay',entry -> 'linehaulPay',
        'additionalPay',entry -> 'additionalPay','totalPay',entry -> 'totalPay',
        'mileRate',entry -> 'mileRate','miles',entry -> 'miles'))
    end
  from jsonb_array_elements(case when jsonb_typeof(details #> '{driverPay,drivers}')='array'
    then details #> '{driverPay,drivers}' else '[]'::jsonb end) as pay(entry)
  cross join lateral (
    select case when details ->> ('driver' || (entry ->> 'slot') || 'Pay')
        ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$'
      then (details ->> ('driver' || (entry ->> 'slot') || 'Pay'))::numeric
    end as manual_pay
  ) as own_pay
  where entry ->> 'driverId'=assigned::text
  limit 1;
$$;
