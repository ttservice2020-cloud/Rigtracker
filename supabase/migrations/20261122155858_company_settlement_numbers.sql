alter table fleet_internal.company_driver_pay_files
  add column settlement_number text,
  add column settlement_id uuid references fleet_internal.company_driver_settlements(id);

create unique index company_pay_settlements_number
  on fleet_internal.company_driver_pay_files(fleet_id,settlement_number)
  where settlement_number is not null and replaces_key is null;
create unique index company_pay_settlements_draft
  on fleet_internal.company_driver_pay_files(settlement_id)
  where settlement_id is not null and replaces_key is null;
create index company_driver_settlements_driver
  on fleet_internal.company_driver_settlements(fleet_id,driver_user_id);

create function fleet_internal.next_company_settlement_number(target_fleet text, target_driver uuid)
returns text language plpgsql set search_path = ''
as $$
declare
  prefix text;
  next_counter bigint;
  available_counter integer;
begin
  select right(coalesce(p.display_profile_id,p.profile_id),3)
    || lower(coalesce(left(p.display_profile_id,2),
      coalesce(substring(p.first_name from '[[:alpha:]]'),'x') || coalesce(substring(p.last_name from '[[:alpha:]]'),'x')))
    into prefix
    from public.rigtracker_profiles p where p.user_id=target_driver;
  if prefix is null then
    raise exception 'A driver profile is required to generate a settlement number.' using errcode='22023';
  end if;

  -- Both settlement entry points allocate inside this fleet lock and save in the same transaction.
  perform pg_advisory_xact_lock(hashtextextended('rigtracker/settlement/' || target_fleet,0));

  with history as (
    select lower(btrim(s.settlement_number)) as number
    from fleet_internal.company_driver_settlements s
    where s.fleet_id=target_fleet and s.driver_user_id=target_driver
    union all
    select lower(btrim(coalesce(f.settlement_number,f.title)))
    from fleet_internal.company_driver_pay_files f
    where f.fleet_id=target_fleet and f.driver_id=target_driver and f.replaces_key is null
      and f.settlement_id is null and not exists(
        select 1 from fleet_internal.company_driver_settlements s
        where s.fleet_id=target_fleet and s.driver_user_id=target_driver
          and lower(btrim(s.settlement_number))=lower(btrim(f.title)))
  )
  select greatest(count(*),coalesce(max(case when left(number,5)=prefix and substring(number from 6) ~ '^[0-9]{3,4}$'
    then substring(number from 6)::integer end),0))+1 into next_counter from history;

  with company_numbers as (
    select lower(btrim(s.settlement_number)) as number from fleet_internal.company_driver_settlements s
    where s.fleet_id=target_fleet
    union all
    select lower(btrim(coalesce(f.settlement_number,f.title))) from fleet_internal.company_driver_pay_files f
    where f.fleet_id=target_fleet
  ), occupied as (
    select case when left(number,5)=prefix and substring(number from 6) ~ '^[0-9]{3,4}$'
      then substring(number from 6)::integer end as counter from company_numbers
  )
  select min(candidate)::integer into available_counter from generate_series(next_counter,9999) candidate
  where not exists(select 1 from occupied where counter=candidate);

  if available_counter is null then
    raise exception 'The four-digit settlement number series is full for this driver.' using errcode='22023';
  end if;
  return prefix || lpad(available_counter::text,4,'0');
end;
$$;

revoke all on function fleet_internal.next_company_settlement_number(text,uuid) from public, anon, authenticated;

create or replace function fleet_internal.create_company_driver_settlement(
  target_fleet text,
  target_profile text,
  requested_load_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  driver_user uuid;
  dispatch_driver uuid;
  driver public.fleet_dispatch_drivers%rowtype;
  load public.fleet_dispatch_loads%rowtype;
  new_id uuid := gen_random_uuid();
  new_number text;
  requested_count integer;
  valid_count integer;
  slot integer;
  pay_entry jsonb;
  loaded numeric;
  empty numeric;
  gross numeric;
  raw_total numeric;
  raw_base numeric;
  empty_pay numeric;
  additional numeric;
  stop_amount numeric;
  base numeric;
  total numeric;
  base_entered boolean;
  scale jsonb;
  line_count integer := 0;
  grand_total numeric := 0;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not fleet_internal.company_pay_staff(actor, target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode = '42501';
  end if;
  if requested_load_ids is null or cardinality(requested_load_ids) = 0
    or cardinality(requested_load_ids) <> (select count(distinct id) from unnest(requested_load_ids) as ids(id)) then
    raise exception 'Select one or more completed loads.' using errcode = '22023';
  end if;

  select profile.user_id, link.dispatch_driver_id
    into driver_user, dispatch_driver
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = target_fleet
    and profile.profile_id = target_profile
    and profile.profile_type = 'company_driver';

  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;

  select * into driver
  from public.fleet_dispatch_drivers
  where fleet_id = target_fleet and id = dispatch_driver;
  if not found then raise exception 'Driver pay profile is unavailable.' using errcode = '42501'; end if;

  select count(*) into requested_count from unnest(requested_load_ids);
  select count(*) into valid_count
  from public.fleet_dispatch_loads l
  where l.fleet_id = target_fleet and l.status = 'completed'
    and l.id = any(requested_load_ids)
    and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver);
  if valid_count <> requested_count then
    raise exception 'One or more loads are not completed or assigned to this driver.' using errcode = '22023';
  end if;

  new_number := fleet_internal.next_company_settlement_number(target_fleet,driver_user);

  insert into fleet_internal.company_driver_settlements
    (id, fleet_id, driver_profile_id, driver_user_id, settlement_number, load_count, created_by)
  values (new_id, target_fleet, target_profile, driver_user, new_number, requested_count, actor);

  for load in
    select l.* from public.fleet_dispatch_loads l
    where l.fleet_id = target_fleet and l.status = 'completed'
      and l.id = any(requested_load_ids)
      and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver)
    order by l.updated_at, l.pro_number
  loop
    slot := case when load.driver_id = dispatch_driver then 1 else 2 end;
    select item.value into pay_entry
    from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) item(value)
    where item.value ->> 'slot' = slot::text limit 1;

    if slot = 1 then
      loaded := coalesce(nullif(load.details ->> 'firstLegMiles', '')::numeric, nullif(load.details ->> 'loadedMiles', '')::numeric);
      empty := coalesce(nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric,
        case when load.second_driver_id is null then nullif(load.details ->> 'emptyMiles', '')::numeric end, 0);
      raw_base := coalesce(nullif(pay_entry ->> 'amount', '')::numeric, nullif(load.details ->> 'driver1Pay', '')::numeric);
      additional := coalesce(nullif(pay_entry ->> 'additionalPay', '')::numeric,
        nullif(load.details ->> 'driver1AdditionalPay', '')::numeric, 0);
      stop_amount := coalesce(nullif(load.details ->> 'stopPay', '')::numeric, 0);
    else
      loaded := case when nullif(load.details ->> 'firstLegMiles', '') is null
        then nullif(load.details ->> 'loadedMiles', '')::numeric
        else greatest(0, coalesce(nullif(load.details ->> 'loadedMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegMiles', '')::numeric) end;
      empty := case when nullif(load.details ->> 'firstLegEmptyMiles', '') is null
        then coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0)
        else greatest(0, coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric) end;
      raw_base := coalesce(nullif(pay_entry ->> 'amount', '')::numeric, nullif(load.details ->> 'driver2Pay', '')::numeric);
      additional := coalesce(nullif(pay_entry ->> 'additionalPay', '')::numeric,
        nullif(load.details ->> 'driver2AdditionalPay', '')::numeric, 0);
      stop_amount := 0;
    end if;

    gross := nullif(load.details ->> 'payGross', '')::numeric;
    raw_total := nullif(pay_entry ->> 'totalPay', '')::numeric;
    empty_pay := coalesce(nullif(pay_entry ->> 'emptyPay', '')::numeric, empty * coalesce(driver.empty_mile_rate, 0));
    scale := jsonb_build_object(
      'driver_type', driver.driver_type,
      'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
      'split_percent', driver.split_percent,
      'mile_rate', driver.mile_rate,
      'empty_mile_rate', driver.empty_mile_rate
    );

    base := 0;
    base_entered := false;
    if raw_total is not null then
      base := raw_total;
      base_entered := true;
      empty_pay := 0;
      additional := 0;
    elsif raw_base is not null then
      base := raw_base;
      base_entered := true;
    elsif driver.pay_method = 'per_mile' and loaded is not null and driver.mile_rate is not null then
      base := loaded * driver.mile_rate;
      base_entered := true;
    elsif driver.pay_method = 'load_percent' and gross is not null and driver.split_percent is not null then
      base := gross * driver.split_percent / 100;
      base_entered := true;
    elsif driver.pay_method = 'higher_of' and gross is not null and loaded is not null
      and driver.split_percent is not null and driver.mile_rate is not null then
      base := greatest(gross * driver.split_percent / 100, loaded * driver.mile_rate);
      base_entered := true;
    end if;

    total := base + empty_pay + additional + stop_amount;
    grand_total := grand_total + total;
    line_count := line_count + 1;

    insert into fleet_internal.company_driver_settlement_lines
      (fleet_id, settlement_id, load_id, driver_profile_id, pro_number, loaded_miles, empty_miles, pay_scale,
       base_pay, base_pay_entered, empty_mile_pay, stop_pay, additional_pay, total_pay, load_snapshot)
    values (
      target_fleet, new_id, load.id, target_profile, load.pro_number, loaded, empty, scale,
      base, base_entered, empty_pay, stop_amount, additional, total,
      jsonb_build_object('route_number', load.details ->> 'routeNumber',
        'pickup', load.details -> 'pickups' -> 0, 'receiver', load.details -> 'receivers' -> 0,
        'gross', gross, 'pay_entry', pay_entry, 'updated_at', load.updated_at)
    );
  end loop;

  update fleet_internal.company_driver_settlements
  set total_pay = grand_total, load_count = line_count
  where id = new_id;

  return jsonb_build_object('id', new_id, 'settlement_number', new_number,
    'total_pay', grand_total, 'load_count', line_count, 'status', 'draft');
exception
  when unique_violation then
    raise exception 'One or more loads are already included in another settlement.' using errcode = '23505';
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.company_driver_resources(action text, fleet text, profile_number text, params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  target_driver uuid;
  link public.rigtracker_fleet_links%rowtype;
  title_value text;
  settlement_value text;
  draft_id uuid;
  existing_file fleet_internal.company_driver_pay_files%rowtype;
  object_key text := params ->> 'storage_key';
  pay_start date;
  pay_end date;
  shift_key uuid;
  managing_owner boolean;
  replacement text := nullif(params ->> 'replaces_key','');
  review_status text := params ->> 'decision';
  note text := nullif(btrim(params ->> 'review_note'),'');
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='payroll_fleet' then
    return (select jsonb_build_object('fleet_id',f.id,'notices',coalesce((
      select jsonb_agg(p.storage_key || ':' || p.status order by p.reviewed_at)
      from fleet_internal.company_driver_pay_files p where p.fleet_id=f.id and p.status in ('accepted','correction_requested')
    ),'[]'::jsonb)) from public.fleets f
    where (f.admin_user_id=actor or f.id=(select fleet_id from public.fleet_employees where user_id=actor))
      and fleet_internal.company_pay_staff(actor,f.id) limit 1);
  end if;
  if action='hourly_roster' then
    if not fleet_internal.office_has_permission(fleet,'hourly') then
      raise exception 'Hourly Time access is required.' using errcode='42501';
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
      'name',coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),'Company Driver'),
      'started_at',s.started_at,'ended_at',s.ended_at) order by s.started_at desc)
      from (select driver_id,started_at,ended_at from fleet_internal.company_driver_shifts
        where fleet_id=fleet order by started_at desc limit 100) s
      left join public.rigtracker_profiles p on p.user_id=s.driver_id),'[]'::jsonb);
  end if;
  if action in ('clock_status','clock_in','clock_out','driver_pay','review_pay') then
    if not exists (select 1 from public.rigtracker_profiles where user_id=actor and profile_type='company_driver' and not password_required) then
      raise exception 'Sign in as a Company Driver.' using errcode='42501';
    end if;
    if action='driver_pay' then
      return coalesce((select jsonb_agg(to_jsonb(f) - 'driver_id' order by f.period_end desc,f.published_at desc)
        from fleet_internal.company_driver_pay_files f where f.driver_id=actor),'[]'::jsonb);
    end if;
    if action='review_pay' then
      if coalesce(review_status,'') not in ('accepted','correction_requested')
        or (review_status='correction_requested' and (note is null or char_length(note)>1000)) then
        raise exception 'Explain the requested correction or accept the statement.' using errcode='22023';
      end if;
      update fleet_internal.company_driver_pay_files set status=review_status,
        review_note=case when review_status='correction_requested' then note else null end,
        reviewed_at=clock_timestamp()
      where storage_key=object_key and driver_id=actor and status='awaiting_review';
      if not found then raise exception 'This statement is no longer waiting for your review.' using errcode='22023'; end if;
      return '{}'::jsonb;
    end if;
    if action='clock_status' then
      return coalesce((select jsonb_agg(jsonb_build_object(
        'fleet_id',l.fleet_id,'enabled',l.unlinked_at is null and l.time_clock_enabled,
        'shifts', coalesce((
          select jsonb_agg(to_jsonb(s) - 'driver_id' order by s.started_at desc)
          from (select * from fleet_internal.company_driver_shifts
            where fleet_id=l.fleet_id and driver_id=actor order by started_at desc limit 30) s
        ),'[]'::jsonb)
      ) order by l.fleet_id)
      from public.rigtracker_fleet_links l
      where l.profile_user_id=actor and ((l.unlinked_at is null and l.time_clock_enabled) or exists(
        select 1 from fleet_internal.company_driver_shifts s where s.driver_id=actor and s.fleet_id=l.fleet_id and s.ended_at is null
      ))),'[]'::jsonb);
    end if;
    select * into link from public.rigtracker_fleet_links where fleet_id=fleet and profile_user_id=actor for update;
    if not found then raise exception 'This fleet is unavailable.' using errcode='42501'; end if;
    if action='clock_in' then
      if not link.time_clock_enabled or link.unlinked_at is not null then
        raise exception 'This fleet has turned off your time clock.' using errcode='42501';
      end if;
      insert into fleet_internal.company_driver_shifts(fleet_id,driver_id) values(fleet,actor)
      on conflict (fleet_id,driver_id) where ended_at is null do nothing returning id into shift_key;
      if shift_key is null then raise exception 'You are already clocked in for this fleet.' using errcode='22023'; end if;
    else
      update fleet_internal.company_driver_shifts set ended_at=clock_timestamp()
      where fleet_id=fleet and driver_id=actor and ended_at is null returning id into shift_key;
      if shift_key is null then raise exception 'You are already clocked out.' using errcode='22023'; end if;
    end if;
    return '{}'::jsonb;
  end if;

  managing_owner := exists (select 1 from public.fleets where id=fleet and admin_user_id=actor);
  if not managing_owner and (action not in ('admin_detail','publish_pay','submit_pay','payroll_queue')
    or not fleet_internal.company_pay_staff(actor,fleet)) then
    raise exception 'Only this Fleet Admin can manage driver pay and time clock settings.' using errcode='42501';
  end if;
  if action in ('publish_pay','submit_pay') and not fleet_internal.office_has_permission(fleet,'payroll') then
    raise exception 'Payroll access is required to send or submit a settlement.' using errcode='42501';
  end if;
  if action='payroll_queue' then
    return jsonb_build_object('drivers',coalesce((select jsonb_agg(jsonb_build_object(
      'profile_id',p.profile_id,'first_name',p.first_name,'last_name',p.last_name) order by p.last_name,p.first_name)
      from public.rigtracker_fleet_links l join public.rigtracker_profiles p on p.user_id=l.profile_user_id
      where l.fleet_id=fleet and p.profile_type='company_driver'), '[]'::jsonb),'records',
      coalesce((select jsonb_agg(jsonb_build_object(
      'profile_id',p.profile_id,'first_name',p.first_name,'last_name',p.last_name,'title',f.title,
      'storage_key',f.storage_key,'status',f.status,'review_note',f.review_note,'period_start',f.period_start,'period_end',f.period_end
    ) order by f.reviewed_at desc nulls last,f.published_at desc)
      from fleet_internal.company_driver_pay_files f join public.rigtracker_profiles p on p.user_id=f.driver_id
      where f.fleet_id=fleet and f.status in ('awaiting_review','accepted','correction_requested')),'[]'::jsonb));
  end if;
  if action='former_drivers' then
    return coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'first_name',p.first_name,
      'last_name',p.last_name) order by p.last_name,p.first_name)
      from public.rigtracker_fleet_links l join public.rigtracker_profiles p on p.user_id=l.profile_user_id
      where l.fleet_id=fleet and l.unlinked_at is not null and p.profile_type='company_driver'),'[]'::jsonb);
  end if;

  select p.user_id into target_driver from public.rigtracker_profiles p
  where p.profile_id=profile_number and p.profile_type='company_driver';
  select * into link from public.rigtracker_fleet_links where fleet_id=fleet and profile_user_id=target_driver for update;
  if not found then raise exception 'Driver unavailable for this fleet.' using errcode='42501'; end if;
  case action
    when 'admin_detail' then
      return jsonb_build_object('linked',link.unlinked_at is null,'can_manage_clock',managing_owner,
        'can_manage_pay',fleet_internal.office_has_permission(fleet,'payroll'),
        'enabled',link.unlinked_at is null and link.time_clock_enabled,
        'shifts',coalesce((select jsonb_agg(to_jsonb(s) - 'driver_id' order by s.started_at desc)
          from (select * from fleet_internal.company_driver_shifts where fleet_id=fleet and driver_id=target_driver and managing_owner
            order by started_at desc limit 60) s),'[]'::jsonb),
        'settlement_drafts',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'number',d.settlement_number)
          order by d.created_at desc) from fleet_internal.company_driver_settlements d
          where d.fleet_id=fleet and d.driver_user_id=target_driver
            and fleet_internal.office_has_permission(fleet,'payroll')
            and not exists(select 1 from fleet_internal.company_driver_pay_files f
              where f.fleet_id=fleet and f.driver_id=target_driver
                and (f.settlement_id=d.id or lower(btrim(f.title))=lower(d.settlement_number)))),'[]'::jsonb),
        'documents',coalesce((select jsonb_agg(to_jsonb(f) - 'driver_id' order by f.period_end desc,f.published_at desc)
          from fleet_internal.company_driver_pay_files f where f.fleet_id=fleet and f.driver_id=target_driver),'[]'::jsonb));
    when 'set_clock' then
      if link.unlinked_at is not null or jsonb_typeof(params -> 'enabled') is distinct from 'boolean' then
        raise exception 'Choose an active Company Driver and a switch setting.' using errcode='22023';
      end if;
      update public.rigtracker_fleet_links set time_clock_enabled=(params ->> 'enabled')::boolean
        where fleet_id=fleet and profile_user_id=target_driver;
    when 'publish_pay' then
      if coalesce(object_key,'') not like fleet || '/' || profile_number || '/%'
        or not fleet_internal.company_driver_files_access(object_key,'upload') or not exists(
          select 1 from storage.objects where bucket_id='company-driver-pay' and name=object_key
        ) then raise exception 'Upload the settlement file before sending it.' using errcode='22023'; end if;
      pay_start := (params ->> 'period_start')::date;
      pay_end := (params ->> 'period_end')::date;
      if pay_start is null or pay_end is null or not isfinite(pay_start) or not isfinite(pay_end) or pay_end < pay_start then
        raise exception 'Enter the start and end dates for the pay period.' using errcode='22023';
      end if;
      if replacement is null then draft_id := nullif(params ->> 'settlement_id','')::uuid; end if;
      select * into existing_file from fleet_internal.company_driver_pay_files
        where storage_key=object_key and fleet_id=fleet and driver_id=target_driver;
      if found then
        if existing_file.period_start is distinct from pay_start or existing_file.period_end is distinct from pay_end
          or existing_file.replaces_key is distinct from replacement
          or (replacement is null and existing_file.settlement_id is distinct from draft_id) then
          raise exception 'This file was already sent. Choose a new file to send a different settlement.' using errcode='22023';
        end if;
        return jsonb_build_object('settlement_number',existing_file.settlement_number);
      end if;
      if replacement is not null then
        update fleet_internal.company_driver_pay_files set status='replaced'
          where storage_key=replacement and fleet_id=fleet and driver_id=target_driver and status='correction_requested'
          returning title,settlement_number,settlement_id into title_value,settlement_value,draft_id;
        if not found then raise exception 'This statement is no longer awaiting a correction.' using errcode='22023'; end if;
      elsif draft_id is not null then
        select d.settlement_number into settlement_value from fleet_internal.company_driver_settlements d
          where d.id=draft_id and d.fleet_id=fleet and d.driver_user_id=target_driver for update;
        if not found then raise exception 'Choose a settlement draft for this driver and fleet.' using errcode='22023'; end if;
        if exists(select 1 from fleet_internal.company_driver_pay_files f where f.fleet_id=fleet and f.driver_id=target_driver
           and (f.settlement_id=draft_id or lower(btrim(f.title))=lower(settlement_value))) then
          raise exception 'This settlement number was already sent for review.' using errcode='22023';
        end if;
        title_value := settlement_value;
      else
        settlement_value := fleet_internal.next_company_settlement_number(fleet,target_driver);
        title_value := settlement_value;
      end if;
      insert into fleet_internal.company_driver_pay_files(storage_key,fleet_id,driver_id,title,period_start,period_end,replaces_key,
        settlement_number,settlement_id)
        values(object_key,fleet,target_driver,title_value,pay_start,pay_end,replacement,settlement_value,draft_id);
      return jsonb_build_object('settlement_number',settlement_value);
    when 'submit_pay' then
      update fleet_internal.company_driver_pay_files set status='submitted',submitted_at=clock_timestamp()
        where storage_key=object_key and fleet_id=fleet and driver_id=target_driver and status='accepted';
      if not found then raise exception 'The driver must accept this statement before payroll can submit it.' using errcode='22023'; end if;
    else raise exception 'Unsupported driver document or clock action.' using errcode='22023';
  end case;
  return '{}'::jsonb;
end;
$function$;
