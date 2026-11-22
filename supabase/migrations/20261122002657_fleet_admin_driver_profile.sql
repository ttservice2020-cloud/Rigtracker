create function fleet_internal.fleet_admin_driver_profile(
  action text, first_name text, last_name text, roster_driver uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owned_fleet text;
  current_link public.rigtracker_fleet_links%rowtype;
  driver_profile jsonb;
  available_drivers jsonb := '[]'::jsonb;
begin
  if actor is null then
    raise exception 'Sign in as a Fleet Admin.' using errcode = '42501';
  end if;
  if action = 'save' then
    select f.id into owned_fleet from public.fleets f where f.admin_user_id = actor for update;
  elsif action = 'get' then
    select f.id into owned_fleet from public.fleets f where f.admin_user_id = actor;
  else
    raise exception 'Choose a driver profile action.' using errcode = '22023';
  end if;
  if owned_fleet is null then
    raise exception 'Set up your Fleet ID to use My Driver Profile.' using errcode = '42501';
  end if;

  if action = 'save' then
    first_name := btrim(coalesce(first_name, ''));
    last_name := btrim(coalesce(last_name, ''));
    if char_length(first_name) not between 1 and 100 or char_length(last_name) not between 1 and 100 then
      raise exception 'Enter your first and last name.' using errcode = '22023';
    end if;

    select * into current_link from public.rigtracker_fleet_links l
    where l.fleet_id = owned_fleet and l.profile_user_id = actor;

    if current_link.dispatch_driver_id is not null and roster_driver is not null
      and current_link.dispatch_driver_id <> roster_driver then
      raise exception 'Your profile is already associated with a driver on this roster.' using errcode = '22023';
    end if;
    if current_link.dispatch_driver_id is null and roster_driver is not null then
      perform 1 from public.fleet_dispatch_drivers d
      where d.fleet_id = owned_fleet and d.id = roster_driver and d.link_active
        and not exists (select 1 from public.rigtracker_fleet_links l
          where l.fleet_id = owned_fleet and l.dispatch_driver_id = d.id)
      for update;
      if not found then
        raise exception 'That driver record is unavailable. Choose another roster entry.' using errcode = '22023';
      end if;
    end if;

    update public.rigtracker_profiles p
    set first_name = fleet_admin_driver_profile.first_name, last_name = fleet_admin_driver_profile.last_name
    where p.user_id = actor and p.profile_type = 'driver' and not p.password_required;
    if not found then
      if exists(select 1 from public.rigtracker_profiles p where p.user_id = actor) then
        raise exception 'Your existing profile could not be used as a fleet driver.' using errcode = '22023';
      end if;
      loop
        insert into public.rigtracker_profiles (user_id, profile_type, first_name, last_name)
        values (actor, 'driver', first_name, last_name)
        on conflict (profile_id) do nothing;
        exit when found;
      end loop;
    end if;

    if current_link.dispatch_driver_id is not null or roster_driver is null then
      perform fleet_internal.set_rigtracker_link(actor, owned_fleet, actor, null, false);
    else
      insert into public.rigtracker_fleet_links (fleet_id, profile_user_id, dispatch_driver_id)
      values (owned_fleet, actor, roster_driver);
      update public.fleet_dispatch_drivers d
      set name = left(first_name || ' ' || last_name, 100)
      where d.fleet_id = owned_fleet and d.id = roster_driver;
    end if;
  end if;

  select jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name,
    'driver_id', case when l.unlinked_at is null then l.dispatch_driver_id end, 'roster_name', d.name)
  into driver_profile
  from public.rigtracker_profiles p
  left join public.rigtracker_fleet_links l on l.fleet_id = owned_fleet and l.profile_user_id = p.user_id
  left join public.fleet_dispatch_drivers d on d.fleet_id = l.fleet_id and d.id = l.dispatch_driver_id
  where p.user_id = actor and p.profile_type = 'driver' and not p.password_required;

  if driver_profile ->> 'roster_name' is null then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'equipment', d.equipment)
      order by d.name, d.id), '[]'::jsonb) into available_drivers
    from public.fleet_dispatch_drivers d
    where d.fleet_id = owned_fleet and d.link_active
      and not exists (select 1 from public.rigtracker_fleet_links l
        where l.fleet_id = owned_fleet and l.dispatch_driver_id = d.id);
  end if;

  return jsonb_build_object('profile', driver_profile, 'available_drivers', available_drivers);
end;
$$;

create function public.fleet_admin_driver_profile(
  action text, first_name text default null, last_name text default null, roster_driver uuid default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select fleet_internal.fleet_admin_driver_profile(action, first_name, last_name, roster_driver);
$$;

revoke all on function fleet_internal.fleet_admin_driver_profile(text, text, text, uuid),
  public.fleet_admin_driver_profile(text, text, text, uuid) from public, anon, authenticated;
grant execute on function fleet_internal.fleet_admin_driver_profile(text, text, text, uuid),
  public.fleet_admin_driver_profile(text, text, text, uuid) to authenticated;
