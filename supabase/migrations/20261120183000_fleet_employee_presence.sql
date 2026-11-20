alter table public.fleet_employees add column last_seen_at timestamptz;

grant update (last_seen_at) on public.fleet_employees to authenticated;

create policy fleet_employee_update_own_presence
  on public.fleet_employees
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (last_seen_at is null or last_seen_at <= statement_timestamp())
  );

create function public.set_fleet_employee_presence(is_online boolean)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.fleet_employees
  set last_seen_at = case when is_online then statement_timestamp() else null end
  where user_id = (select auth.uid());
$$;

create function public.fleet_online_employee_count(requested_fleet_id text)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
  from public.fleet_employees as employee
  join public.fleets as fleet on fleet.id = employee.fleet_id
  where fleet.id = requested_fleet_id
    and fleet.admin_user_id = (select auth.uid())
    and employee.last_seen_at >= statement_timestamp() - interval '2 minutes';
$$;

revoke all on function public.set_fleet_employee_presence(boolean) from public, anon, authenticated;
revoke all on function public.fleet_online_employee_count(text) from public, anon, authenticated;
grant execute on function public.set_fleet_employee_presence(boolean) to authenticated;
grant execute on function public.fleet_online_employee_count(text) to authenticated;
