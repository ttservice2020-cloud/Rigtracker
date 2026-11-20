alter table public.fleet_dispatch_drivers
  add column driver_type text,
  add column pay_method text,
  add column split_percent numeric(5,2),
  add column mile_rate numeric(8,4),
  add constraint fleet_dispatch_driver_pay_profile check (
    case driver_type
      when 'company' then pay_method is null and split_percent is null and mile_rate is null
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

grant insert (driver_type, pay_method, split_percent, mile_rate)
  on public.fleet_dispatch_drivers to authenticated;
grant update (driver_type, pay_method, split_percent, mile_rate)
  on public.fleet_dispatch_drivers to authenticated;

create table public.fleet_dispatch_fuel_rates (
  fleet_id text not null references public.fleets(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  cents_per_mile numeric(8,4) not null check (cents_per_mile between 0 and 9999),
  primary key (fleet_id, week_start)
);
alter table public.fleet_dispatch_fuel_rates enable row level security;
revoke all on public.fleet_dispatch_fuel_rates from public, anon, authenticated;
grant select, insert on public.fleet_dispatch_fuel_rates to authenticated;
grant update (fleet_id, week_start, cents_per_mile) on public.fleet_dispatch_fuel_rates to authenticated;
create policy fleet_dispatch_fuel_rate_owner on public.fleet_dispatch_fuel_rates
  for all to authenticated
  using (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())))
  with check (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())));

create function fleet_internal.dispatch_pay_inputs(details jsonb)
returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select jsonb_build_array(
    nullif(details #>> '{pickups,0,date}', ''), nullif(details ->> 'loadedMiles', ''),
    nullif(details ->> 'firstLegMiles', ''), nullif(details ->> 'payGross', ''),
    nullif(details ->> 'driver1Pay', ''), nullif(details ->> 'driver2Pay', '')
  );
$$;

create function public.calculate_dispatch_driver_pay(
  requested_fleet_id text, first_driver_id uuid, second_driver_id uuid, requested_details jsonb
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  pickup_day date;
  pickup_week date;
  miles numeric;
  first_leg numeric;
  gross numeric;
  rate numeric;
  surcharge numeric;
  split_base numeric;
  combined_split numeric;
  driver_slot record;
  pay numeric;
  driver_miles numeric;
  pending text;
  drivers jsonb := '[]';
  has_pending boolean := false;
begin
  if current_user = 'authenticated' and not exists (
    select 1 from public.fleets
    where id = requested_fleet_id and admin_user_id = (select auth.uid())
  ) then
    raise exception 'Only this Fleet Admin can calculate driver pay.' using errcode = '42501';
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
  select cents_per_mile into rate from public.fleet_dispatch_fuel_rates
    where fleet_id = requested_fleet_id and week_start = pickup_week;
  surcharge := round(miles * rate / 100, 2);
  split_base := gross - surcharge;
  select coalesce(sum(split_percent), 0) into combined_split
    from public.fleet_dispatch_drivers
    where fleet_id = requested_fleet_id and id in (first_driver_id, second_driver_id)
      and pay_method = 'split';

  for driver_slot in
    select slots.slot, d.id, d.driver_type, d.pay_method, d.split_percent, d.mile_rate
    from (values (1, first_driver_id), (2, second_driver_id)) as slots(slot, driver_id)
    join public.fleet_dispatch_drivers d on d.fleet_id = requested_fleet_id and d.id = slots.driver_id
    order by slots.slot
  loop
    pay := null;
    pending := null;
    driver_miles := null;
    case driver_slot.pay_method
      when 'split' then
        pending := case
          when gross is null then 'Enter the gross load amount.'
          when miles is null then 'Enter route loaded miles.'
          when pickup_week is null then 'Enter the first pickup date.'
          when rate is null then 'Set the fuel surcharge for the pickup week.'
          when split_base < 0 then 'Gross is below the fuel surcharge.'
          when combined_split > 100 then 'The two driver splits exceed 100% of the load.'
        end;
        if pending is null then pay := round(split_base * driver_slot.split_percent / 100, 2); end if;
      when 'per_mile' then
        if second_driver_id is null then driver_miles := miles;
        elsif first_leg between 0 and miles then
          driver_miles := case when driver_slot.slot = 1 then first_leg else miles - first_leg end;
        end if;
        if miles is null then pending := 'Enter route loaded miles.';
        elsif driver_miles is null then pending := 'Enter Driver 1 leg miles in Split Load Details.';
        else pay := round(driver_miles * driver_slot.mile_rate, 2);
        end if;
      when 'hourly' then null;
      else null;
    end case;
    has_pending := has_pending or pending is not null;
    drivers := drivers || jsonb_build_array(jsonb_build_object(
      'slot', driver_slot.slot, 'driverId', driver_slot.id, 'type', driver_slot.driver_type,
      'method', driver_slot.pay_method, 'amount', pay, 'pending', pending,
      'splitPercent', driver_slot.split_percent, 'mileRate', driver_slot.mile_rate, 'miles', driver_miles
    ));
  end loop;

  return jsonb_build_object(
    'drivers', drivers, 'pending', has_pending, 'gross', gross, 'loadedMiles', miles,
    'weekStart', pickup_week, 'fuelRateCents', rate, 'fuelSurcharge', surcharge, 'splitBase', split_base
  );
end;
$$;

create function fleet_internal.snapshot_dispatch_driver_pay()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  saved_pay jsonb;
begin
  if new.status not in ('current','completed') then
    new.details := new.details - 'driverPay';
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.status in ('current','completed')
      and coalesce((old.details #>> '{driverPay,pending}') = 'false', false)
      and old.driver_id is not distinct from new.driver_id
      and old.second_driver_id is not distinct from new.second_driver_id
      and fleet_internal.dispatch_pay_inputs(old.details) = fleet_internal.dispatch_pay_inputs(new.details) then
      saved_pay := old.details -> 'driverPay';
    end if;
  end if;
  if saved_pay is null then
    saved_pay := public.calculate_dispatch_driver_pay(new.fleet_id, new.driver_id, new.second_driver_id, new.details);
  end if;
  new.details := jsonb_set(new.details, '{driverPay}', saved_pay);
  return new;
end;
$$;

revoke all on function fleet_internal.dispatch_pay_inputs(jsonb) from public, anon, authenticated;
revoke all on function fleet_internal.snapshot_dispatch_driver_pay() from public, anon, authenticated;
revoke all on function public.calculate_dispatch_driver_pay(text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.dispatch_pay_inputs(jsonb) to authenticated;
grant execute on function public.calculate_dispatch_driver_pay(text, uuid, uuid, jsonb) to authenticated;

create trigger fleet_dispatch_snapshot_driver_pay
  before insert or update on public.fleet_dispatch_loads
  for each row execute function fleet_internal.snapshot_dispatch_driver_pay();
