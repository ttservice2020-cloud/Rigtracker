create function fleet_internal.add_dispatch_coverage_pay(calculation jsonb, details jsonb)
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
        when driver ->> 'type' = 'owner_op' then (driver ->> 'amount')::numeric
        when manual_text ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$' then manual_text::numeric
      end as base_pay
  ) as amounts;
$$;

revoke all on function fleet_internal.add_dispatch_coverage_pay(jsonb, jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.add_dispatch_coverage_pay(jsonb, jsonb) to authenticated;

create or replace function fleet_internal.snapshot_dispatch_driver_pay()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  saved_pay jsonb;
  slot record;
  amount_key text;
  amount_text text;
  previous_driver_id uuid;
begin
  for slot in select * from (values (1, new.driver_id), (2, new.second_driver_id)) as slots(number, driver_id) loop
    amount_key := 'driver' || slot.number || 'AdditionalPay';
    if new.status = 'contract' or slot.driver_id is null then
      new.details := new.details - amount_key;
      continue;
    end if;
    -- Older loaded pages can still save notes and stops without erasing an existing bonus.
    if tg_op = 'UPDATE' then
      previous_driver_id := case when slot.number = 1 then old.driver_id else old.second_driver_id end;
      if slot.driver_id = previous_driver_id and not (new.details ? amount_key) and old.details ? amount_key then
        new.details := jsonb_set(new.details, array[amount_key], old.details -> amount_key);
      end if;
    end if;
    amount_text := nullif(new.details ->> amount_key, '');
    if amount_text is not null and amount_text !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then
      raise exception 'Enter a nonnegative additional pay amount in dollars and cents.' using errcode = '22023';
    end if;
  end loop;

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
  new.details := jsonb_set(new.details, '{driverPay}', fleet_internal.add_dispatch_coverage_pay(saved_pay, new.details));
  return new;
end;
$$;
