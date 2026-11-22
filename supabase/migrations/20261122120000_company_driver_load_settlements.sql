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
    and profile.profile_type = 'company_driver'
    and link.unlinked_at is null;

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
      'pickup', load.details -> 'pickups' -> 0,
      'receiver', load.details -> 'receivers' -> 0,
      'driver_slot', case when load.driver_id = dispatch_driver then 1 else 2 end,
      'pay_entry', (
        select entry.value
        from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) entry(value)
        where entry.value ->> 'slot' = case when load.driver_id = dispatch_driver then '1' else '2' end
        limit 1
      ),
      'manual_pay', nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1Pay' else 'driver2Pay' end, ''),
      'additional_pay', coalesce(nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1AdditionalPay' else 'driver2AdditionalPay' end, ''), '0')
    ) order by load.updated_at desc)
    from public.fleet_dispatch_loads load
    where load.fleet_id = target_fleet
      and load.status = 'completed'
      and (load.driver_id = dispatch_driver or load.second_driver_id = dispatch_driver)
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.company_driver_load_settlements(target_fleet text, target_profile text)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select fleet_internal.company_driver_load_settlements(target_fleet, target_profile);
$function$;

revoke all on function fleet_internal.company_driver_load_settlements(text, text) from public, anon;
grant execute on function fleet_internal.company_driver_load_settlements(text, text) to authenticated;
revoke all on function public.company_driver_load_settlements(text, text) from public, anon;
grant execute on function public.company_driver_load_settlements(text, text) to authenticated;