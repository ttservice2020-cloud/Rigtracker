create table fleet_internal.company_driver_presence (
  user_id uuid primary key references public.rigtracker_profiles(user_id) on delete cascade,
  last_seen_at timestamptz not null
);
alter table fleet_internal.company_driver_presence enable row level security;
revoke all on table fleet_internal.company_driver_presence from public, anon, authenticated;

create index fleet_dispatch_completed_driver_history_idx
  on public.fleet_dispatch_loads (fleet_id, driver_id, updated_at desc, id desc)
  where status = 'completed';
create index fleet_dispatch_completed_second_driver_history_idx
  on public.fleet_dispatch_loads (fleet_id, second_driver_id, updated_at desc, id desc)
  where status = 'completed' and second_driver_id is not null;

create function fleet_internal.record_company_driver_presence()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into fleet_internal.company_driver_presence as presence (user_id, last_seen_at)
  select p.user_id, statement_timestamp() from public.rigtracker_profiles p
  where p.user_id = (select auth.uid()) and p.profile_type = 'company_driver' and not p.password_required
    and exists (select 1 from public.rigtracker_fleet_links l
      where l.profile_user_id = p.user_id and l.unlinked_at is null)
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at
  where presence.last_seen_at < excluded.last_seen_at - interval '30 seconds';
$$;

create function fleet_internal.fleet_company_driver_profile(
  action text, target_fleet text, profile_number text, roster_driver uuid,
  before_time timestamptz, before_load uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  driver record;
  recent_activity jsonb;
begin
  if not exists(select 1 from public.fleets f where f.id = target_fleet and f.admin_user_id = (select auth.uid())) then
    raise exception 'Fleet Admin access is required to view this driver profile.' using errcode = '42501';
  end if;

  select p.user_id, p.profile_id, p.first_name, p.last_name, p.phone, p.license_number,
    l.employee_number, l.dispatch_driver_id, l.unlinked_at, d.equipment, d.availability
  into driver
  from public.rigtracker_fleet_links l
  join public.rigtracker_profiles p on p.user_id = l.profile_user_id and p.profile_type = 'company_driver'
  left join public.fleet_dispatch_drivers d on d.id = l.dispatch_driver_id and d.fleet_id = l.fleet_id
  where l.fleet_id = target_fleet and (
    (profile_number is not null and p.profile_id = profile_number)
    or (roster_driver is not null and l.dispatch_driver_id = roster_driver and l.unlinked_at is null)
  );
  if not found then
    raise exception 'This driver does not have a Company Driver profile linked to your fleet.' using errcode = '22023';
  end if;

  if action in ('overview', 'presence') then
    select jsonb_build_object('last_seen_at', p.last_seen_at, 'online',
      p.last_seen_at >= statement_timestamp() - interval '2 minutes')
    into recent_activity from fleet_internal.company_driver_presence p
    where p.user_id = driver.user_id and driver.unlinked_at is null;
    if action = 'presence' then return coalesce(recent_activity, '{}'::jsonb); end if;
    return jsonb_build_object('profile_id', driver.profile_id, 'first_name', driver.first_name,
      'last_name', driver.last_name, 'employee_number', driver.employee_number,
      'linked', driver.unlinked_at is null, 'equipment', driver.equipment,
      'availability', case
        when driver.unlinked_at is not null then null
        when exists(select 1 from public.fleet_dispatch_loads l
          where l.fleet_id = target_fleet and l.status = 'current'
            and driver.dispatch_driver_id in (l.driver_id, l.second_driver_id)) then 'assigned'
        else driver.availability end,
      'email', case when driver.unlinked_at is null then (select u.email from auth.users u where u.id = driver.user_id) end,
      'phone', case when driver.unlinked_at is null then driver.phone end,
      'license_number', case when driver.unlinked_at is null then driver.license_number end,
      'presence', coalesce(recent_activity, '{}'::jsonb));
  end if;

  if action <> 'history' or action is null then
    raise exception 'Choose a driver profile section.' using errcode = '22023';
  end if;

  return (
    with candidate_loads as (
      (
        select l.id, l.updated_at from public.fleet_dispatch_loads l
        where l.fleet_id = target_fleet and l.status = 'completed' and l.driver_id = driver.dispatch_driver_id
          and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        order by l.updated_at desc, l.id desc limit 26
      )
      union all
      (
        select l.id, l.updated_at from public.fleet_dispatch_loads l
        where l.fleet_id = target_fleet and l.status = 'completed' and l.second_driver_id = driver.dispatch_driver_id
          and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        order by l.updated_at desc, l.id desc limit 26
      )
    ), page as (
      select c.id from candidate_loads c order by c.updated_at desc, c.id desc limit 26
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'load_id', l.id, 'pro_number', l.pro_number::text, 'return_load', l.return_of is not null,
      'updated_at', l.updated_at, 'completed_at', coalesce(l.progress ->> 'completedAt', l.updated_at::text),
      'origin', l.details #>> '{pickups,0,company}', 'destination', l.details #>> '{receivers,-1,company}',
      'paperwork', coalesce(documents.files, '[]'::jsonb)
    ) order by l.updated_at desc, l.id desc), '[]'::jsonb)
    from page p join public.fleet_dispatch_loads l on l.id = p.id
    left join lateral (
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'path', r.path) order by s.sequence_no) as files
      from fleet_internal.workflow_stops(l.details) s
      cross join lateral (select l.progress #>> array['stops', s.stop_key, 'driverReport', 'document'] as path) r
      where split_part(r.path, '/', 1) = l.id::text
    ) documents on true
  );
end;
$$;

create function public.record_company_driver_presence()
returns void language sql security invoker set search_path = ''
as $$ select fleet_internal.record_company_driver_presence(); $$;

create function public.fleet_company_driver_profile(
  action text, target_fleet text, profile_number text default null, roster_driver uuid default null,
  before_time timestamptz default null, before_load uuid default null
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.fleet_company_driver_profile(action, target_fleet, profile_number, roster_driver, before_time, before_load);
$$;

revoke all on function fleet_internal.record_company_driver_presence(), public.record_company_driver_presence(),
  fleet_internal.fleet_company_driver_profile(text,text,text,uuid,timestamptz,uuid),
  public.fleet_company_driver_profile(text,text,text,uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function fleet_internal.record_company_driver_presence(), public.record_company_driver_presence(),
  fleet_internal.fleet_company_driver_profile(text,text,text,uuid,timestamptz,uuid),
  public.fleet_company_driver_profile(text,text,text,uuid,timestamptz,uuid)
  to authenticated;
