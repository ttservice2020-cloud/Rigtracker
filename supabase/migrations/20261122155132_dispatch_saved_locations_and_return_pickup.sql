create table public.fleet_dispatch_locations (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  name text not null check (name=btrim(name) and char_length(name) between 1 and 120),
  address text not null check (address=btrim(address) and char_length(address) between 1 and 180),
  city text not null check (city=btrim(city) and char_length(city) between 1 and 80),
  state text not null check (state ~ '^[A-Z]{2}$'),
  zip text not null check (zip ~ '^[0-9]{5}(-[0-9]{4})?$')
);

create unique index fleet_dispatch_locations_name_idx
  on public.fleet_dispatch_locations(fleet_id, lower(name));
create index fleet_dispatch_locations_list_idx on public.fleet_dispatch_locations(fleet_id, name, id);

alter table public.fleet_dispatch_locations enable row level security;
revoke all on public.fleet_dispatch_locations from public, anon, authenticated;
grant select, insert on public.fleet_dispatch_locations to authenticated;
grant update (name, address, city, state, zip) on public.fleet_dispatch_locations to authenticated;

create policy fleet_dispatch_locations_read on public.fleet_dispatch_locations for select to authenticated
  using (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_locations_add on public.fleet_dispatch_locations for insert to authenticated
  with check (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_locations_update on public.fleet_dispatch_locations for update to authenticated
  using (fleet_internal.office_has_permission(fleet_id,'dispatch'))
  with check (fleet_internal.office_has_permission(fleet_id,'dispatch'));

create function fleet_internal.validate_dispatch_relay_address()
returns trigger language plpgsql set search_path = ''
as $$
declare
  address_fields constant text[] := array['relayLocation','relayAddress','relayCity','relayState','relayZip'];
  relay_fields constant text[] := address_fields || array['relayDate','relayDrop','relayPickup'];
begin
  if new.status='draft' or not exists(select 1 from unnest(relay_fields) k
    where nullif(btrim(new.details ->> k),'') is not null) then
    return new;
  end if;
  if tg_op='UPDATE' and old.status<>'draft'
    and not exists(select 1 from unnest(address_fields[2:5]) k where nullif(btrim(old.details ->> k),'') is not null)
    and not exists(select 1 from unnest(relay_fields) k
      where nullif(btrim(new.details ->> k),'') is distinct from nullif(btrim(old.details ->> k),'')) then
    return new;
  end if;
  if exists(select 1 from unnest(address_fields) k where nullif(btrim(new.details ->> k),'') is null) then
    raise exception 'Enter the relay name, street address, city, state, and ZIP.' using errcode='22023';
  end if;
  if upper(btrim(new.details ->> 'relayState')) !~ '^[A-Z]{2}$'
    or btrim(new.details ->> 'relayZip') !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'Enter a two-letter relay state and a valid relay ZIP code.' using errcode='22023';
  end if;
  return new;
end;
$$;

revoke all on function fleet_internal.validate_dispatch_relay_address() from public, anon, authenticated;
create trigger fleet_dispatch_load_relay_address before insert or update of details,status
  on public.fleet_dispatch_loads for each row execute function fleet_internal.validate_dispatch_relay_address();

create or replace function fleet_internal.driver_load_info(details jsonb, primary_driver boolean)
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'commodity',coalesce(nullif(case when details ->> 'commodity'='Other'
      then details ->> 'commodityOther' end,''),nullif(details ->> 'commodity','')),
    'equipment',coalesce(nullif(case when details ->> 'equipmentType'='Other'
      then details ->> 'equipmentTypeOther' end,''),nullif(details ->> 'equipmentType','')),
    'weight',nullif(details ->> 'weightLbs',''),
    'pieces',nullif(details ->> 'pieces',''),
    'route',nullif(details ->> 'routeNumber',''),
    'miles',nullif(details ->> 'loadedMiles',''),
    'emptyMiles',nullif(details ->> 'emptyMiles',''),
    'pickupNumber',nullif(details ->> 'pickupNumber',''),
    'bolNumber',nullif(details ->> 'bolNumber',''),
    'brokerName',nullif(details ->> 'brokerName',''),
    'brokerLoadNumber',nullif(details ->> 'brokerLoadNumber',''),
    'brokerPhone',nullif(details ->> 'brokerPhone',''),
    'brokerEmail',nullif(details ->> 'brokerEmail',''),
    'truckNumber',nullif(details ->> 'truckNumber',''),
    'trailerNumber',nullif(details ->> 'trailerNumber',''),
    'trailerType',case when details ->> 'trailerType' in ('fleet','power_only') then details ->> 'trailerType' end,
    'trailerDropNumber',case when details ->> 'trailerDrop'='yes' then nullif(btrim(details ->> 'trailerDropNumber'),'') end,
    'trailerDropStopId',case when details ->> 'trailerDrop'='yes' then nullif(details ->> 'trailerDropStopId','') end,
    'trailerDropNotes',case when details ->> 'trailerDrop'='yes' then nullif(details ->> 'trailerDropNotes','') end,
    'trailerPickupMode',case when details ->> 'trailerPickup'='yes' then nullif(details ->> 'trailerPickupMode','') end,
    'trailerPickupNumber',case when details ->> 'trailerPickup'='yes'
      and details ->> 'trailerPickupMode' is distinct from 'bobtail'
      then nullif(btrim(details ->> 'trailerPickupNumber'),'') end,
    'trailerPickupStopId',case when details ->> 'trailerPickup'='yes' then nullif(details ->> 'trailerPickupStopId','') end,
    'trailerPickupNotes',case when details ->> 'trailerPickup'='yes'
      and details ->> 'trailerPickupMode' is distinct from 'bobtail' then nullif(details ->> 'trailerPickupNotes','') end,
    'nextTrailerLocation',case when details ->> 'trailerPickup'='yes' and details ->> 'trailerPickupMode'='bobtail'
      then nullif(details ->> 'nextTrailerLocation','') end,
    'bobtailInstructions',case when details ->> 'trailerPickup'='yes' and details ->> 'trailerPickupMode'='bobtail'
      then nullif(details ->> 'bobtailInstructions','') end,
    'trailerDrop',case when details ->> 'trailerDrop'='yes'
      then coalesce(nullif(details ->> 'trailerDropNotes',''),'Yes') end,
    'trailerPickup',case when details ->> 'trailerPickup'='yes'
      then coalesce(nullif(details ->> 'trailerPickupNotes',''),'Yes') end,
    'relayLocation',nullif(details ->> 'relayLocation',''),
    'relayAddress',nullif(details ->> 'relayAddress',''),
    'relayCity',nullif(details ->> 'relayCity',''),
    'relayState',nullif(details ->> 'relayState',''),
    'relayZip',nullif(details ->> 'relayZip',''),
    'relayDate',nullif(details ->> 'relayDate',''),
    'relayDrop',nullif(details ->> 'relayDrop',''),
    'relayPickup',nullif(details ->> 'relayPickup',''),
    'firstLegMiles',nullif(details ->> 'firstLegMiles',''),
    'firstLegEmptyMiles',nullif(details ->> 'firstLegEmptyMiles',''),
    'stopPay',case when primary_driver then nullif(details ->> 'stopPay','') end
  ));
$$;

CREATE OR REPLACE FUNCTION fleet_internal.dispatch_workflow(fleet text, action text, load_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  l public.fleet_dispatch_loads%rowtype;
  handoff fleet_internal.driver_yard_handoffs%rowtype;
  offered uuid;
  trailer_value text := upper(btrim(payload ->> 'trailer'));
  yard_value text := btrim(payload ->> 'yard');
  updated_details jsonb;
  new_progress jsonb;
  pickup_time timestamp;
  pickup_zone text;
  side text;
  part text;
  field_value text;
begin
  if actor is null or not fleet_internal.office_has_permission(fleet,'dispatch') then
    raise exception 'Only this Fleet Admin can review driver activity.' using errcode='42501';
  end if;
  if action='list' then
    return jsonb_build_object(
      'returns',coalesce((
        select jsonb_agg(jsonb_build_object('id',q.id,'pro',q.pro_number,'driver',d.name,'shipper',q.details #>> '{pickups,0,company}',
          'receiver',q.details #>> '{receivers,0,company}','address',q.details #>> '{receivers,0,address}',
          'pickup',q.details #> '{pickups,0}','delivery',q.details #> '{receivers,0}',
          'source_pro',source.pro_number,'freight',fleet_internal.driver_load_info(q.details,true)) order by q.created_at)
        from public.fleet_dispatch_loads q join public.fleet_dispatch_loads source on source.id=q.return_of
        left join public.fleet_dispatch_drivers d on d.id=q.driver_id
        where q.fleet_id=fleet and q.return_review='pending'
      ),'[]'::jsonb),
      'responses',coalesce((
        select jsonb_agg(notification order by responded desc) from (
          select jsonb_build_object('id',q.id,'pro',q.pro_number,'return_of',q.return_of,'driver',d.name,
            'decision',r.value ->> 'decision','at',r.value ->> 'at') notification, r.value ->> 'at' responded
          from public.fleet_dispatch_loads q
          cross join lateral jsonb_each(coalesce(q.progress->'driverResponses','{}'::jsonb)) r
          join public.fleet_dispatch_drivers d on d.id::text=r.key and d.id in (q.driver_id,q.second_driver_id)
          where q.fleet_id=fleet and q.status='current'
          order by responded desc limit 100
        ) rows
      ),'[]'::jsonb),
      'yard',coalesce((
        select jsonb_agg(jsonb_build_object('id',y.load_id,'pro',q.pro_number,'return_of',q.return_of,'trailer',y.trailer,'yard',y.yard,
          'driver',d.name,'offered_driver',y.offered_driver,'picked_up_at',y.picked_up_at) order by y.picked_up_at desc nulls last,y.trailer)
        from fleet_internal.driver_yard_handoffs y join public.fleet_dispatch_loads q on q.id=y.load_id
        left join public.fleet_dispatch_drivers d on d.id=y.offered_driver
        where y.fleet_id=fleet and y.confirmed_at is null and q.status='current'
      ),'[]'::jsonb),
      'loads',coalesce((
        select jsonb_agg(item order by pro desc) from (
          select q.pro_number pro,jsonb_build_object('id',q.id,'pro',q.pro_number,'return_of',q.return_of,
            'driver_id',q.driver_id,'receiver',q.details #>> '{receivers,0,company}') item
          from public.fleet_dispatch_loads q where q.fleet_id=fleet and q.status='current'
          order by q.pro_number desc limit 250
        ) rows
      ),'[]'::jsonb),
      'drivers',coalesce((
        select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name) order by d.name)
        from public.rigtracker_fleet_links link join public.fleet_dispatch_drivers d on d.id=link.dispatch_driver_id
        where link.fleet_id=fleet and link.unlinked_at is null and d.link_active
      ),'[]'::jsonb));
  end if;

  select * into l from public.fleet_dispatch_loads where id=load_id and fleet_id=fleet for update;
  if not found then raise exception 'Load unavailable in this fleet.' using errcode='42501'; end if;
  perform fleet_internal.assert_dispatch_load_unlocked(l.id);
  if action in ('post_return','deny_return') then
    if l.return_review is distinct from 'pending' then raise exception 'This request was already reviewed.' using errcode='22023'; end if;
    if action='deny_return' then
      update public.fleet_dispatch_loads set return_review='denied' where id=l.id;
      return '{}'::jsonb;
    end if;
    if char_length(btrim(payload ->> 'shipper')) not between 1 and 160
      or char_length(btrim(payload ->> 'receiver')) not between 1 and 160
      or nullif(btrim(payload ->> 'shipper'),'') is null or nullif(btrim(payload ->> 'receiver'),'') is null then
      raise exception 'Enter a shipper and receiver.' using errcode='22023';
    end if;
    updated_details := jsonb_set(jsonb_set(l.details,'{pickups,0,company}',to_jsonb(btrim(payload ->> 'shipper'))),
      '{receivers,0,company}',to_jsonb(btrim(payload ->> 'receiver')));
    if payload ? 'address' then
      updated_details := jsonb_set(updated_details,'{receivers,0,address}',to_jsonb(left(coalesce(payload ->> 'address',''),180)));
    end if;
    foreach side in array array['pickup','receiver'] loop
      foreach part in array array['address','city','state','zip'] loop
        if not (payload ? (side || '_' || part)) then continue; end if;
        field_value := left(btrim(coalesce(payload ->> (side || '_' || part),'')),
          case part when 'address' then 180 when 'city' then 80 when 'state' then 2 else 10 end);
        if part='state' then
          field_value := upper(field_value);
          if field_value<>'' and field_value !~ '^[A-Z]{2}$' then
            raise exception 'Enter a two-letter % state.',side using errcode='22023';
          end if;
        elsif part='zip' and field_value<>'' and field_value !~ '^[0-9]{5}(-[0-9]{4})?$' then
          raise exception 'Enter a valid % ZIP code.',side using errcode='22023';
        end if;
        updated_details := jsonb_set(updated_details,array[side || 's','0',part],to_jsonb(field_value));
      end loop;
    end loop;
    if payload ->> 'pickup_now'='yes' then
      pickup_zone := payload ->> 'pickup_zone';
      if pickup_zone is null or pickup_zone not in ('America/New_York','America/Chicago','America/Denver',
        'America/Phoenix','America/Los_Angeles','America/Anchorage','Pacific/Honolulu') then
        raise exception 'Choose the pickup time zone to use the current time.' using errcode='22023';
      end if;
      pickup_time := clock_timestamp() at time zone pickup_zone;
      updated_details := jsonb_set(updated_details,'{pickups,0}',(updated_details #> '{pickups,0}') ||
        jsonb_build_object('zone',pickup_zone,'date',to_char(pickup_time,'YYYY-MM-DD'),'from',to_char(pickup_time,'HH24:MI'),'to',''));
    end if;
    update public.fleet_dispatch_loads set return_review='posted',status='current',details=updated_details where id=l.id;
    if coalesce(trailer_value,'')='' and coalesce(yard_value,'')='' then return '{}'::jsonb; end if;
    action := 'send_yard';
    l.status := 'current';
  end if;

  if l.status<>'current' then raise exception 'Post the load before working the yard split.' using errcode='22023'; end if;
  select * into handoff from fleet_internal.driver_yard_handoffs y where y.load_id=l.id for update;
  if action='send_yard' then
    if handoff.picked_up_at is not null then raise exception 'This trailer was already picked up.' using errcode='22023'; end if;
    if coalesce(char_length(trailer_value),0) not between 1 and 40 or coalesce(char_length(yard_value),0) not between 1 and 160 then
      raise exception 'Enter the trailer number and yard.' using errcode='22023';
    end if;
    offered := nullif(payload ->> 'driver_id','')::uuid;
    if offered is not null and (offered=l.driver_id or not exists(
      select 1 from public.rigtracker_fleet_links where fleet_id=fleet and dispatch_driver_id=offered and unlinked_at is null
    )) then raise exception 'Choose a different linked driver for the yard pickup.' using errcode='22023'; end if;
    insert into fleet_internal.driver_yard_handoffs(load_id,fleet_id,trailer,yard,offered_driver)
      values(l.id,fleet,trailer_value,yard_value,offered)
      on conflict on constraint driver_yard_handoffs_pkey do update
        set trailer=excluded.trailer,yard=excluded.yard,offered_driver=excluded.offered_driver;
    return '{}'::jsonb;
  end if;
  if action='finish_yard' then
    if handoff.picked_up_at is null or handoff.confirmed_at is not null or handoff.offered_driver is null then
      raise exception 'Wait for the driver’s yard pickup before confirming the split.' using errcode='22023';
    end if;
    new_progress := l.progress || jsonb_build_object('driverResponses',coalesce(l.progress -> 'driverResponses','{}'::jsonb));
    new_progress := jsonb_set(new_progress,array['driverResponses',handoff.offered_driver::text],
      jsonb_build_object('decision','accepted','at',handoff.picked_up_at));
    update public.fleet_dispatch_loads set second_driver_id=handoff.offered_driver,
      details=details || jsonb_build_object('secondDriverMode','assigned','relayLocation',handoff.yard),progress=new_progress where id=l.id;
    update fleet_internal.driver_yard_handoffs set confirmed_at=clock_timestamp() where driver_yard_handoffs.load_id=l.id;
    return '{}'::jsonb;
  end if;
  raise exception 'Unsupported Dispatch action.' using errcode='22023';
exception when unique_violation then
  raise exception 'This trailer is already listed for another open yard split.' using errcode='22023';
end;
$function$;
