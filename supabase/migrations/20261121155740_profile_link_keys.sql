create table fleet_internal.rigtracker_profile_link_keys (
  profile_user_id uuid primary key references public.rigtracker_profiles(user_id) on delete cascade,
  key_hash bytea not null unique check (octet_length(key_hash)=32),
  expires_at timestamptz not null
);
revoke all on fleet_internal.rigtracker_profile_link_keys from public,anon,authenticated;

create function fleet_internal.profile_link_key(action text, link_key text, employee_number text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_fleet text;
  normalized_key text;
  key_text text;
  seed text;
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

    -- Use 80 random bits from UUIDv4, excluding its version and variant fields.
    seed := replace(gen_random_uuid()::text,'-','');
    normalized_key := upper(substr(seed,1,12) || substr(seed,18,8));
    key_text := substr(normalized_key,1,4) || '-' || substr(normalized_key,5,4) || '-'
      || substr(normalized_key,9,4) || '-' || substr(normalized_key,13,4) || '-' || substr(normalized_key,17,4);
    key_expires := clock_timestamp() + interval '24 hours';
    insert into fleet_internal.rigtracker_profile_link_keys(profile_user_id,key_hash,expires_at)
      values(actor,sha256(convert_to(normalized_key,'UTF8')),key_expires)
      on conflict(profile_user_id) do update set key_hash=excluded.key_hash,expires_at=excluded.expires_at;
    return jsonb_build_object('key',key_text,'expires_at',key_expires);
  end if;

  if coalesce(action,'') not in ('preview','redeem') then
    raise exception 'Choose a link key action.' using errcode='22023';
  end if;
  select f.id into target_fleet from public.fleets f where f.admin_user_id=actor;
  if not found then raise exception 'Only the Fleet Admin can use a link key.' using errcode='42501'; end if;

  normalized_key := upper(regexp_replace(coalesce(link_key,''),'[-[:space:]]','','g'));
  if normalized_key !~ '^[A-F0-9]{20}$' then
    raise exception 'Enter a complete link key.' using errcode='22023';
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
    raise exception 'This link key is no longer available. Ask the profile owner for a new key.' using errcode='22023';
  end if;
  if exists(select 1 from public.rigtracker_fleet_links l
    where l.fleet_id=target_fleet and l.profile_user_id=target_user and l.unlinked_at is null) then
    raise exception 'This profile is already linked to your fleet.' using errcode='22023';
  end if;
  if action='redeem' then
    perform fleet_internal.set_rigtracker_link(actor,target_fleet,target_user,nullif(btrim(employee_number),''),false);
    delete from fleet_internal.rigtracker_profile_link_keys where profile_user_id=target_user;
  end if;
  return jsonb_build_object('first_name',profile.first_name,'last_name',profile.last_name,'profile_type',profile.profile_type);
end;
$$;

create function public.profile_link_key(action text, link_key text default null, employee_number text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.profile_link_key(action,link_key,employee_number); $$;
revoke all on function fleet_internal.profile_link_key(text,text,text),public.profile_link_key(text,text,text)
  from public,anon,authenticated;
grant execute on function fleet_internal.profile_link_key(text,text,text),public.profile_link_key(text,text,text)
  to authenticated;

-- Fleet-created Company Drivers use the existing internal link helper during account creation.
create or replace function public.manage_rigtracker_link(
  acting_admin uuid,target_fleet text,target_profile_id text,requested_number text,removing boolean
)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if removing is distinct from true then
    raise exception 'Ask the profile owner for a link key.' using errcode='22023';
  end if;
  perform fleet_internal.set_rigtracker_link(acting_admin,target_fleet,
    (select user_id from public.rigtracker_profiles where profile_id=target_profile_id),null,true);
end;
$$;
