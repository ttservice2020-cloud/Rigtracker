alter table fleet_internal.company_driver_settlements
  add column period_start date,
  add column period_end date,
  add constraint company_statement_valid_period check (
    (period_start is null and period_end is null)
    or (period_start is not null and period_end is not null and period_start<=period_end)
  );

alter table fleet_internal.company_driver_settlement_lines add column delivered_on date;

create function fleet_internal.statement_delivery_day(load public.fleet_dispatch_loads)
returns date language sql stable set search_path = ''
as $$
  select (
    coalesce(nullif((load).progress#>>array['stops',final_stop.stop_key,'completedAt'],'')::timestamptz,
      nullif((load).progress->>'completedAt','')::timestamptz,(load).updated_at)
    at time zone coalesce(zone.name,'America/New_York')
  )::date
  from (select 1) anchor
  left join lateral (
    select s.stop_key,s.info->>'zone' as delivery_zone
    from fleet_internal.workflow_stops((load).details) s
    where s.kind='delivery' order by s.sequence_no desc limit 1
  ) final_stop on true
  left join pg_catalog.pg_timezone_names zone on zone.name=final_stop.delivery_zone;
$$;
revoke all on function fleet_internal.statement_delivery_day(public.fleet_dispatch_loads) from public,anon,authenticated;

create function fleet_internal.capture_statement_line_delivery()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  starts_on date;
  ends_on date;
begin
  select fleet_internal.statement_delivery_day(l) into new.delivered_on
    from public.fleet_dispatch_loads l where l.id=new.load_id and l.fleet_id=new.fleet_id;
  select d.period_start,d.period_end into starts_on,ends_on
    from fleet_internal.company_driver_settlements d where d.id=new.settlement_id;
  if starts_on is not null and (new.delivered_on is null or new.delivered_on not between starts_on and ends_on) then
    raise exception 'A selected load was delivered outside this statement’s pay period.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.capture_statement_line_delivery() from public,anon,authenticated;
create trigger company_statement_line_delivery before insert on fleet_internal.company_driver_settlement_lines
  for each row execute function fleet_internal.capture_statement_line_delivery();

create function fleet_internal.add_company_statement_loads_for_period(
  target_fleet text,target_profile text,requested_load_ids uuid[],target_statement uuid,
  starts_on date,ends_on date)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  created jsonb;
  draft fleet_internal.company_driver_settlements%rowtype;
  locked_load public.fleet_dispatch_loads%rowtype;
  delivery_day date;
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  if starts_on is null or ends_on is null or starts_on>ends_on then
    raise exception 'Enter a valid start and end date.' using errcode='22023';
  end if;

  -- Use the same load order as settlement creation, and hold the cutoff consistent through the insert.
  for locked_load in
    select l.* from public.fleet_dispatch_loads l
    where l.fleet_id=target_fleet and l.id=any(requested_load_ids) order by l.id for share
  loop
    delivery_day := fleet_internal.statement_delivery_day(locked_load);
    if delivery_day is null or delivery_day not between starts_on and ends_on then
      raise exception 'A selected load was delivered outside this statement’s pay period.' using errcode='22023';
    end if;
  end loop;

  created := fleet_internal.add_company_statement_loads(target_fleet,target_profile,requested_load_ids,target_statement);
  select d.* into draft from fleet_internal.company_driver_settlements d where d.id=(created->>'id')::uuid;
  if draft.period_start is not null then
    if (draft.period_start,draft.period_end) is distinct from (starts_on,ends_on) then
      raise exception 'Use the pay period already saved on this statement.' using errcode='22023';
    end if;
  else
    -- A historical draft can adopt a period if its existing lines all belong within that range.
    if target_statement is not null and exists(
      select 1 from fleet_internal.company_driver_settlement_lines line
      left join public.fleet_dispatch_loads l on l.id=line.load_id and l.fleet_id=line.fleet_id
      where line.settlement_id=draft.id
        and (coalesce(line.delivered_on,fleet_internal.statement_delivery_day(l)) between starts_on and ends_on)
          is distinct from true
    ) then
      raise exception 'This draft already contains loads delivered outside the selected pay period.' using errcode='22023';
    end if;
    update fleet_internal.company_driver_settlements d
    set period_start=starts_on,period_end=ends_on where d.id=draft.id;
  end if;
  return created;
end;
$$;

create function public.add_company_statement_loads_for_period(
  target_fleet text,target_profile text,requested_load_ids uuid[],target_statement uuid,
  starts_on date,ends_on date)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.add_company_statement_loads_for_period(
    target_fleet,target_profile,requested_load_ids,target_statement,starts_on,ends_on);
$$;
revoke all on function fleet_internal.add_company_statement_loads_for_period(text,text,uuid[],uuid,date,date),
  public.add_company_statement_loads_for_period(text,text,uuid[],uuid,date,date) from public,anon,authenticated;
grant execute on function fleet_internal.add_company_statement_loads_for_period(text,text,uuid[],uuid,date,date),
  public.add_company_statement_loads_for_period(text,text,uuid[],uuid,date,date) to authenticated;

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
    and profile.profile_type = 'company_driver';

  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'load_id', load.id,
      'pro_number', load.pro_number,
      'is_return', load.return_of is not null,
      'has_signed_bol', fleet_internal.load_has_driver_bol(load),
      'bol_review', (select jsonb_build_object('status',r.status,'note',r.note)
        from fleet_internal.load_bol_pay_reviews r where r.load_id=load.id),
      'lumper_reimbursement',fleet_internal.load_lumper_reimbursement(load,dispatch_driver),
      'route_number', load.details ->> 'routeNumber',
      'updated_at', load.updated_at,
      'delivered_on',fleet_internal.statement_delivery_day(load),
      'completed_at', coalesce(nullif(load.progress->>'completedAt',''),load.updated_at::text),
      'created_settlement', case when settlement.id is not null then jsonb_build_object(
        'id',settlement.id,'number',settlement.settlement_number,'status',settlement.status,'line_total',line.total_pay) end,
      'pickup', load.details -> 'pickups' -> 0,
      'receiver', load.details -> 'receivers' -> 0,
      'freight', jsonb_build_object(
        'truckNumber', load.details -> 'truckNumber',
        'trailerNumber', load.details -> 'trailerNumber',
        'commodity', load.details -> 'commodity',
        'commodityOther', load.details -> 'commodityOther',
        'weightLbs', load.details -> 'weightLbs',
        'pieces', load.details -> 'pieces',
        'equipmentType', load.details -> 'equipmentType',
        'equipmentTypeOther', load.details -> 'equipmentTypeOther',
        'trailerDrop', load.details -> 'trailerDrop',
        'trailerDropNotes', load.details -> 'trailerDropNotes',
        'trailerPickup', load.details -> 'trailerPickup',
        'trailerPickupNotes', load.details -> 'trailerPickupNotes',
        'brokerName', load.details -> 'brokerName',
        'brokerPhone', load.details -> 'brokerPhone',
        'brokerEmail', load.details -> 'brokerEmail',
        'brokerLoadNumber', load.details -> 'brokerLoadNumber',
        'routeNumber', load.details -> 'routeNumber',
        'pickupNumber', load.details -> 'pickupNumber',
        'stopPay', load.details -> 'stopPay',
        'driver1AdditionalPay', load.details -> 'driver1AdditionalPay',
        'driver2AdditionalPay', load.details -> 'driver2AdditionalPay',
        'rateConfirmation', load.details -> 'rateConfirmation'
      ),
      'pickup_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'pickup',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'pickup-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'pickups', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'receiver_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'receiver',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'receiver-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'receivers', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'loaded_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegMiles', '')::numeric, nullif(load.details ->> 'loadedMiles', '')::numeric)
        else case when nullif(load.details ->> 'firstLegMiles', '') is null
          then nullif(load.details ->> 'loadedMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'loadedMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegMiles', '')::numeric) end end,
      'empty_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric,
          case when load.second_driver_id is null then nullif(load.details ->> 'emptyMiles', '')::numeric else null end)
        else case when nullif(load.details ->> 'firstLegEmptyMiles', '') is null
          then nullif(load.details ->> 'emptyMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric) end end,
      'gross', nullif(load.details ->> 'payGross', '')::numeric,
      'stop_pay', case when load.driver_id = dispatch_driver then coalesce(nullif(load.details ->> 'stopPay', '')::numeric, 0) else 0 end,
      'driver_slot', case when load.driver_id = dispatch_driver then 1 else 2 end,
      'pay_scale', (
        select jsonb_build_object(
          'driver_type', driver.driver_type,
          'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
          'split_percent', driver.split_percent,
          'mile_rate', driver.mile_rate,
          'empty_mile_rate', driver.empty_mile_rate
        )
        from public.fleet_dispatch_drivers driver
        where driver.id = dispatch_driver and driver.fleet_id = target_fleet
      ),
      'pay_entry', (
        select entry.value
        from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) entry(value)
        where entry.value ->> 'slot' = case when load.driver_id = dispatch_driver then '1' else '2' end
        limit 1
      ),
      'manual_pay', nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1Pay' else 'driver2Pay' end, '')::numeric,
      'additional_pay', coalesce(nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1AdditionalPay' else 'driver2AdditionalPay' end, '')::numeric, 0)
    ) order by load.updated_at desc)
    from public.fleet_dispatch_loads load
    left join fleet_internal.company_driver_settlement_lines line
      on line.fleet_id=load.fleet_id and line.load_id=load.id and line.driver_profile_id=target_profile
    left join fleet_internal.company_driver_settlements settlement
      on settlement.fleet_id=load.fleet_id and settlement.id=line.settlement_id
    where load.fleet_id = target_fleet
      and load.status = 'completed'
      and (settlement.id is not null or fleet_internal.load_ready_for_settlement(load))
      and (load.driver_id = dispatch_driver or load.second_driver_id = dispatch_driver)
  ), '[]'::jsonb);
end;
$function$;

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
      'period_start',draft.period_start,'period_end',draft.period_end,
      'load_count',draft.load_count,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'pro_number',line.pro_number,'is_return',load.return_of is not null,
          'pickup',coalesce(line.load_snapshot->'pickup',load.details#>'{pickups,0}'),
          'receiver',coalesce(line.load_snapshot->'receiver',load.details#>'{receivers,0}'),
          'delivered_on',coalesce(line.delivered_on,fleet_internal.statement_delivery_day(load)),
          'total_pay',line.total_pay,
          'lumper_reimbursement',fleet_internal.load_lumper_reimbursement(load,
            fleet_internal.workflow_driver(draft.driver_user_id,draft.fleet_id)),
          'has_signed_bol',fleet_internal.load_has_driver_bol(load),
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




create function fleet_internal.confirm_published_statement_period()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  starts_on date;
  ends_on date;
begin
  if new.settlement_id is null then return new; end if;
  select d.period_start,d.period_end into starts_on,ends_on
    from fleet_internal.company_driver_settlements d
    where d.id=new.settlement_id and d.fleet_id=new.fleet_id and d.driver_user_id=new.driver_id;
  if starts_on is not null and (new.period_start,new.period_end) is distinct from (starts_on,ends_on) then
    raise exception 'Use the pay period saved on the statement draft.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.confirm_published_statement_period() from public,anon,authenticated;
create trigger company_pay_file_statement_period before insert or update of settlement_id,period_start,period_end
  on fleet_internal.company_driver_pay_files for each row execute function fleet_internal.confirm_published_statement_period();
