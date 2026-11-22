alter table public.rigtracker_profiles
  add column display_profile_id text unique
    check (display_profile_id ~ '^[[:alpha:]]{2}[0-9]{6}$');

create table fleet_internal.rigtracker_profile_id_counters (
  prefix text primary key,
  last_number integer not null check (last_number between 1 and 999999)
);
alter table fleet_internal.rigtracker_profile_id_counters enable row level security;
revoke all on table fleet_internal.rigtracker_profile_id_counters from public, anon, authenticated;

create function fleet_internal.assign_display_profile_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_initial text := left(upper(substring(new.first_name from '[[:alpha:]]')), 1);
  last_initial text := left(upper(substring(new.last_name from '[[:alpha:]]')), 1);
  name_initials text := first_initial || last_initial;
  profile_number integer;
begin
  if tg_op = 'UPDATE' and old.display_profile_id is not null then
    new.display_profile_id := old.display_profile_id;
    return new;
  end if;
  new.display_profile_id := null;
  if name_initials is null then return new; end if;

  insert into fleet_internal.rigtracker_profile_id_counters as counter (prefix,last_number)
  values (name_initials,1)
  on conflict (prefix) do update set last_number=counter.last_number+1
  returning last_number into profile_number;
  new.display_profile_id := name_initials || lpad(profile_number::text,6,'0');
  return new;
end;
$$;

revoke all on function fleet_internal.assign_display_profile_id() from public, anon, authenticated;

create trigger rigtracker_assign_display_profile_id
  before insert or update of first_name, last_name, display_profile_id on public.rigtracker_profiles
  for each row execute function fleet_internal.assign_display_profile_id();

update public.rigtracker_profiles set display_profile_id = null;

create table fleet_internal.rigtracker_link_key_attempts (
  fleet_id text primary key references public.fleets(id) on delete cascade,
  window_ends_at timestamptz not null,
  failures integer not null check (failures between 0 and 10)
);
alter table fleet_internal.rigtracker_link_key_attempts enable row level security;
revoke all on table fleet_internal.rigtracker_link_key_attempts from public, anon, authenticated;

CREATE OR REPLACE FUNCTION fleet_internal.profile_link_key(action text, link_key text, employee_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  target_fleet text;
  fleet_admin uuid;
  normalized_key text;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  seed bigint;
  short_key boolean;
  attempt_window fleet_internal.rigtracker_link_key_attempts%rowtype;
  key_expires timestamptz;
  target_user uuid;
  profile public.rigtracker_profiles%rowtype;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;

  if action in ('issue','revoke','status') then
    perform 1 from public.rigtracker_profiles p where p.user_id=actor and not p.password_required
      for update;
    if not found then raise exception 'An active RigTracker profile is required.' using errcode='42501'; end if;
    if action='revoke' then
      delete from fleet_internal.rigtracker_profile_link_keys where profile_user_id=actor;
      return '{}'::jsonb;
    end if;
    if action='status' then
      select k.expires_at into key_expires from fleet_internal.rigtracker_profile_link_keys k
        where k.profile_user_id=actor and k.expires_at>clock_timestamp();
      return jsonb_build_object('expires_at',key_expires);
    end if;

    key_expires := clock_timestamp() + interval '24 hours';
    for attempt in 1..12 loop
      -- The first 30 bits of a random UUID give six uniformly random base-32 characters.
      seed := ('x' || left(gen_random_uuid()::text,8))::bit(32)::bigint;
      normalized_key := '';
      for position in 0..5 loop
        normalized_key := normalized_key || substr(alphabet,((seed >> (position*5)) & 31)::integer + 1,1);
      end loop;
      begin
        insert into fleet_internal.rigtracker_profile_link_keys(profile_user_id,key_hash,expires_at)
        values (actor,sha256(convert_to(normalized_key,'UTF8')),key_expires)
        on conflict (profile_user_id) do update set key_hash=excluded.key_hash,expires_at=excluded.expires_at;
        return jsonb_build_object('key',normalized_key,'expires_at',key_expires);
      exception when unique_violation then
        -- Another profile holds this key. Retry with fresh random characters.
      end;
    end loop;
    raise exception 'Could not generate a link key. Try again.';
  end if;

  if coalesce(action,'') not in ('preview','redeem') then
    raise exception 'Choose a link key action.' using errcode='22023';
  end if;
  select f.id, f.admin_user_id into target_fleet, fleet_admin
    from public.fleets f where f.admin_user_id=actor;
  if not found then
    select f.id, f.admin_user_id into target_fleet, fleet_admin
      from public.fleet_employees e
      join public.fleets f on f.id=e.fleet_id
      where e.user_id=actor and e.office_is_official and e.office_can_link_profiles
        and not e.password_required
      for share of e;
    if not found then
      raise exception 'Profile linking access is required.' using errcode='42501';
    end if;
  end if;

  normalized_key := upper(regexp_replace(coalesce(link_key,''),'[-[:space:]]','','g'));
  short_key := normalized_key ~ '^[A-Z0-9]{6}$';
  if not short_key and normalized_key !~ '^[A-F0-9]{20}$' then
    raise exception 'Enter a complete link key.' using errcode='22023';
  end if;
  if short_key then
    -- Share the guessing limit across the Fleet Admin and their Office Officials.
    insert into fleet_internal.rigtracker_link_key_attempts (fleet_id,window_ends_at,failures)
    values (target_fleet,clock_timestamp() + interval '15 minutes',0) on conflict do nothing;
    select * into attempt_window from fleet_internal.rigtracker_link_key_attempts a
    where a.fleet_id=target_fleet for update;
    if attempt_window.window_ends_at <= clock_timestamp() then
      update fleet_internal.rigtracker_link_key_attempts
      set failures=0, window_ends_at=clock_timestamp() + interval '15 minutes'
      where fleet_id=target_fleet;
    elsif attempt_window.failures >= 10 then
      return jsonb_build_object('link_key_error','Too many incorrect link keys. Try again in up to 15 minutes.');
    end if;
  end if;
  if action='redeem' then
    select k.profile_user_id into target_user from fleet_internal.rigtracker_profile_link_keys k
      where k.key_hash=sha256(convert_to(normalized_key,'UTF8')) and k.expires_at>clock_timestamp()
      for update;
  else
    select k.profile_user_id into target_user from fleet_internal.rigtracker_profile_link_keys k
      where k.key_hash=sha256(convert_to(normalized_key,'UTF8')) and k.expires_at>clock_timestamp();
  end if;

  select * into profile from public.rigtracker_profiles p where p.user_id=target_user and not p.password_required;
  if not found then
    if short_key then
      update fleet_internal.rigtracker_link_key_attempts set failures=failures+1 where fleet_id=target_fleet;
      -- Return the failure so the attempt is recorded even when no profile is linked.
      return jsonb_build_object('link_key_error','This link key is no longer available. Check the key or ask for a new one.');
    end if;
    raise exception 'This link key is no longer available. Ask the profile owner for a new key.' using errcode='22023';
  end if;
  if exists(select 1 from public.rigtracker_fleet_links l
    where l.fleet_id=target_fleet and l.profile_user_id=target_user and l.unlinked_at is null) then
    raise exception 'This profile is already linked to your fleet.' using errcode='22023';
  end if;
  if action='redeem' then
    perform fleet_internal.set_rigtracker_link(fleet_admin,target_fleet,target_user,nullif(btrim(employee_number),''),false);
    delete from fleet_internal.rigtracker_profile_link_keys where profile_user_id=target_user;
  end if;
  return jsonb_build_object('first_name',profile.first_name,'last_name',profile.last_name,'profile_type',profile.profile_type);
end;
$function$;
