create function fleet_internal.add_company_statement_loads(
  target_fleet text,
  target_profile text,
  requested_load_ids uuid[],
  target_statement uuid
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
  new_id uuid;
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
  line_count integer;
  grand_total numeric;
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
  select count(*) into valid_count from (
    select l.id
    from public.fleet_dispatch_loads l
    where l.fleet_id = target_fleet and l.status = 'completed'
      and l.id = any(requested_load_ids)
      and (l.driver_id = dispatch_driver or l.second_driver_id = dispatch_driver)
      and fleet_internal.load_ready_for_settlement(l)
    order by l.id for share
  ) eligible;
  if valid_count <> requested_count then
    raise exception 'Select completed loads for this driver that have cleared the two-hour hold and hourly release.'
      using errcode = '22023';
  end if;

  if target_statement is null then
    new_id := gen_random_uuid();
    new_number := fleet_internal.next_company_settlement_number(target_fleet,driver_user);
    insert into fleet_internal.company_driver_settlements
      (id, fleet_id, driver_profile_id, driver_user_id, settlement_number, load_count, created_by)
    values (new_id, target_fleet, target_profile, driver_user, new_number, requested_count, actor);
  else
    -- Match recording a paid check's lock before inspecting the draft.
    perform pg_advisory_xact_lock(hashtextextended(target_fleet || ':' || driver_user::text,0));
    select d.id,d.settlement_number into new_id,new_number from fleet_internal.company_driver_settlements d
    where d.id=target_statement and d.fleet_id=target_fleet and d.driver_user_id=driver_user
      and d.driver_profile_id=target_profile and d.status='draft'
    for update;
    if not found then
      raise exception 'Select a draft for this driver.' using errcode='42501';
    end if;
    if exists (select 1 from fleet_internal.payroll_paid_checks c where c.settlement_id=new_id)
      or exists (select 1 from fleet_internal.company_driver_pay_files f
        where f.fleet_id=target_fleet and f.driver_id=driver_user
          and (f.settlement_id=new_id or lower(btrim(f.title))=lower(new_number))) then
      raise exception 'This statement was issued. Start a new statement to add more loads.' using errcode='55000';
    end if;
  end if;

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

  select count(*),coalesce(sum(l.total_pay),0) into line_count,grand_total
  from fleet_internal.company_driver_settlement_lines l where l.settlement_id=new_id;
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


create or replace function fleet_internal.create_company_driver_settlement(
  target_fleet text,target_profile text,requested_load_ids uuid[])
returns jsonb language sql security definer set search_path = ''
as $$select fleet_internal.add_company_statement_loads(target_fleet,target_profile,requested_load_ids,null)$$;

create function public.add_company_statement_loads(
  target_fleet text,target_profile text,requested_load_ids uuid[],target_statement uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$select fleet_internal.add_company_statement_loads(target_fleet,target_profile,requested_load_ids,target_statement)$$;

revoke all on function fleet_internal.add_company_statement_loads(text,text,uuid[],uuid),
  public.add_company_statement_loads(text,text,uuid[],uuid) from public,anon,authenticated;
grant execute on function fleet_internal.add_company_statement_loads(text,text,uuid[],uuid),
  public.add_company_statement_loads(text,text,uuid[],uuid) to authenticated;
create or replace function fleet_internal.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',draft.id,'driver_profile_id',draft.driver_profile_id,
      'paid',exists(select 1 from fleet_internal.payroll_paid_checks c where c.settlement_id=draft.id),
      'settlement_number',draft.settlement_number,'created_at',draft.created_at,
      'load_count',draft.load_count,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'pro_number',line.pro_number,'is_return',load.return_of is not null,
          'pickup',coalesce(line.load_snapshot->'pickup',load.details#>'{pickups,0}'),
          'receiver',coalesce(line.load_snapshot->'receiver',load.details#>'{receivers,0}'),
          'total_pay',line.total_pay,'has_signed_bol',fleet_internal.load_has_driver_bol(load),
          'loaded_miles',line.loaded_miles,'empty_miles',line.empty_miles,
          'pay_scale',line.pay_scale,'base_pay',line.base_pay,'base_pay_entered',line.base_pay_entered,
          'empty_mile_pay',line.empty_mile_pay,'stop_pay',line.stop_pay,'additional_pay',line.additional_pay
        ) order by line.created_at,line.pro_number),'[]'::jsonb)
        from fleet_internal.company_driver_settlement_lines line
        join public.fleet_dispatch_loads load on load.fleet_id=line.fleet_id and load.id=line.load_id
        where line.fleet_id=draft.fleet_id and line.settlement_id=draft.id
      ) end
    ) order by draft.created_at desc,draft.id)
    from fleet_internal.company_driver_settlements draft
    join public.rigtracker_profiles profile on profile.user_id=draft.driver_user_id
    cross join lateral (select exists (
      select 1 from fleet_internal.company_driver_pay_files f
      where f.fleet_id=draft.fleet_id and f.driver_id=draft.driver_user_id
        and (f.settlement_id=draft.id or lower(btrim(f.title))=lower(draft.settlement_number))
    ) as sent) publication
    where draft.fleet_id=target_fleet
      and case when requested_settlement_id is null then not publication.sent else draft.id=requested_settlement_id end
  ),'[]'::jsonb);
end;
$$;


create function fleet_internal.check_paid_statement_load_count()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.settlement_id is not null and new.statement ? 'loadCount'
    and (select d.load_count from fleet_internal.company_driver_settlements d where d.id=new.settlement_id)
      is distinct from (new.statement->>'loadCount')::integer then
    raise exception 'Loads changed on this statement. Reopen the statement before recording payment.' using errcode='40001';
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.check_paid_statement_load_count() from public,anon,authenticated;
create trigger paid_statement_load_count before insert on fleet_internal.payroll_paid_checks
  for each row execute function fleet_internal.check_paid_statement_load_count();
