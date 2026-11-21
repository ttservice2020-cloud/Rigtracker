alter table public.fleet_employees
  add column office_is_official boolean not null default false,
  add column office_can_manage_profiles boolean not null default false;
update public.fleet_employees set office_is_official=true,office_can_manage_profiles=true
  where lower(btrim(office_role))='official';

create function fleet_internal.office_has_permission(target_fleet text, permission text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=(select auth.uid()))
    or exists(select 1 from public.fleet_employees e where e.fleet_id=target_fleet and e.user_id=(select auth.uid())
      and not e.password_required and (e.office_is_official or permission=any(e.office_permissions)));
$$;
revoke all on function fleet_internal.office_has_permission(text,text) from public,anon,authenticated;
grant execute on function fleet_internal.office_has_permission(text,text) to authenticated;

create policy fleet_dispatch_staff_read_drivers on public.fleet_dispatch_drivers
  for select to authenticated using (
    fleet_internal.office_has_permission(fleet_id,'drivers') or fleet_internal.office_has_permission(fleet_id,'dispatch')
  );
create policy fleet_dispatch_staff_add_drivers on public.fleet_dispatch_drivers
  for insert to authenticated with check (fleet_internal.office_has_permission(fleet_id,'drivers'));
create policy fleet_dispatch_staff_edit_availability on public.fleet_dispatch_drivers
  for update to authenticated using (fleet_internal.office_has_permission(fleet_id,'drivers'))
  with check (fleet_internal.office_has_permission(fleet_id,'drivers'));
create policy fleet_dispatch_staff_read_loads on public.fleet_dispatch_loads
  for select to authenticated using (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_staff_add_loads on public.fleet_dispatch_loads
  for insert to authenticated with check (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_staff_edit_loads on public.fleet_dispatch_loads
  for update to authenticated using (fleet_internal.office_has_permission(fleet_id,'dispatch'))
  with check (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_staff_read_fuel_rates on public.fleet_dispatch_fuel_rates
  for select to authenticated using (fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_dispatch_official_add_fuel_rates on public.fleet_dispatch_fuel_rates
  for insert to authenticated with check (fleet_internal.office_has_permission(fleet_id,'official'));
create policy fleet_dispatch_official_update_fuel_rates on public.fleet_dispatch_fuel_rates
  for update to authenticated using (fleet_internal.office_has_permission(fleet_id,'official'))
  with check (fleet_internal.office_has_permission(fleet_id,'official'));

create function fleet_internal.protect_dispatch_pay_profile()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or fleet_internal.office_has_permission(new.fleet_id,'official') then
    return new;
  end if;
  if tg_op='INSERT' then
    if new.driver_type is null and new.pay_method is null and new.split_percent is null and new.mile_rate is null then return new; end if;
  elsif (new.driver_type,new.pay_method,new.split_percent,new.mile_rate) is not distinct from
        (old.driver_type,old.pay_method,old.split_percent,old.mile_rate) then
    return new;
  end if;
  raise exception 'Only a Fleet Admin or Official can change a driver pay profile.' using errcode='42501';
end;
$$;
revoke all on function fleet_internal.protect_dispatch_pay_profile() from public,anon,authenticated;
create trigger protect_dispatch_pay_profile before insert or update of driver_type,pay_method,split_percent,mile_rate
  on public.fleet_dispatch_drivers for each row execute function fleet_internal.protect_dispatch_pay_profile();

CREATE OR REPLACE FUNCTION fleet_internal.add_employee_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  account auth.users%rowtype;
  employee_fleet_id text;
  employee_number text;
begin
  -- Auth sets administrator-supplied app metadata after its initial insert.
  select * into account from auth.users where id = new.id;
  employee_fleet_id := account.raw_app_meta_data ->> 'fleet_id';
  employee_number := account.raw_app_meta_data ->> 'employee_id';
  if account.raw_app_meta_data ->> 'account_type' = 'fleet_employee' then
    if employee_fleet_id is null or employee_fleet_id !~ '^[a-z0-9]{1,20}$'
      or employee_number is null or employee_number !~ '^[0-9]{1,6}$'
      or account.email is distinct from lower(employee_fleet_id || '-' || employee_number) || '@fleet-login.rigtrackerpro.com' then
      raise exception 'Invalid fleet employee account.';
    end if;
    insert into public.fleet_employees (
      user_id, fleet_id, employee_id, first_name, last_name, office_role, office_permissions, office_is_official, office_can_manage_profiles
    ) values (
      new.id, employee_fleet_id, employee_number,
      account.raw_user_meta_data ->> 'first_name',
      account.raw_user_meta_data ->> 'last_name',
      account.raw_app_meta_data ->> 'office_role',
      array(select jsonb_array_elements_text(coalesce(account.raw_app_meta_data -> 'office_permissions', '[]'::jsonb))),
      coalesce((account.raw_app_meta_data ->> 'office_is_official')::boolean,
        lower(btrim(account.raw_app_meta_data ->> 'office_role')) = 'official', false),
      coalesce((account.raw_app_meta_data ->> 'office_can_manage_profiles')::boolean,
        (account.raw_app_meta_data ->> 'office_is_official')::boolean,
        lower(btrim(account.raw_app_meta_data ->> 'office_role')) = 'official', false)
    );
  elsif lower(coalesce(account.email, '')) like '%@fleet-login.rigtrackerpro.com' then
    raise exception 'Fleet employee accounts must be created by the Fleet Admin.';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.message_staff_scope(actor uuid, fleet text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when exists(select 1 from public.fleets where id=fleet and admin_user_id=actor)
    then array['staff','official','dispatch','maintenance','safety']
    else coalesce((
      select array['staff']
        || case when e.office_is_official then array['official'] else array[]::text[] end
        || case when e.office_is_official or e.office_permissions && array['dispatch','messages','assets','policies']
          then array['dispatch','maintenance','safety'] else array[]::text[] end
      from public.fleet_employees e where e.fleet_id=fleet and e.user_id=actor and not e.password_required
    ),array[]::text[]) end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.company_safety(action text, report_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  driver_label text;
  staff_fleet text;
  target_fleet text := payload ->> 'fleet';
  incident_kind text := payload ->> 'category';
  notes_value text := coalesce(btrim(payload ->> 'notes'),'');
  incident_day date;
  attachment text := nullif(payload ->> 'document','');
begin
  if actor is null then raise exception 'Sign in to view safety reports.' using errcode='42501'; end if;

  select coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),'Company Driver')
    into driver_label from public.rigtracker_profiles p
    where p.user_id=actor and p.profile_type='company_driver' and not p.password_required;

  if driver_label is null then
    select f.id into staff_fleet from public.fleets f
    where f.admin_user_id=actor or f.id=(select e.fleet_id from public.fleet_employees e
      where e.user_id=actor and not e.password_required and e.office_is_official)
    order by (f.admin_user_id=actor) desc limit 1;
  end if;

  if action='access' then return coalesce(to_jsonb(staff_fleet),'null'::jsonb); end if;

  if driver_label is null and staff_fleet is null then
    raise exception 'Safety reports are available to Company Drivers and fleet Officials.' using errcode='42501';
  end if;

  if action='list' then
    return jsonb_build_object(
      'staff',staff_fleet is not null,
      'linked_fleets',coalesce((
        select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where driver_label is not null and l.profile_user_id=actor and l.unlinked_at is null
      ),'[]'::jsonb),
      'reports',coalesce((
        select jsonb_agg(to_jsonb(r) - 'driver_id' order by r.created_at desc)
        from (select * from fleet_internal.company_safety_reports
          where case when driver_label is not null then driver_id=actor else fleet_id=staff_fleet end
          order by created_at desc limit 200) r
      ),'[]'::jsonb)
    );
  end if;

  if action='review' and staff_fleet is not null then
    update fleet_internal.company_safety_reports set reviewed_at=coalesce(reviewed_at,clock_timestamp())
      where id=report_id and fleet_id=staff_fleet;
    if not found then raise exception 'This safety report is unavailable to your fleet.' using errcode='42501'; end if;
    return '{}'::jsonb;
  end if;

  if action<>'report' or driver_label is null or not fleet_internal.company_driver_is_linked(actor,target_fleet) then
    raise exception 'Choose a linked fleet to send your report.' using errcode='42501';
  end if;
  if report_id is null or incident_kind is null or incident_kind not in ('dot_inspection','ticket','accident','other')
    or not coalesce(pg_input_is_valid(payload ->> 'incident_date','date'),false)
    or coalesce(payload ->> 'incident_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or char_length(notes_value)>3000 or (notes_value='' and attachment is null) then
    raise exception 'Choose the report type and date, and add notes or a document.' using errcode='22023';
  end if;
  incident_day := (payload ->> 'incident_date')::date;
  if attachment is not null and (
    not fleet_internal.company_safety_file_access(attachment,'upload')
    or split_part(attachment,'/',1)<>target_fleet
    or split_part(split_part(attachment,'/',3),'.',1)<>report_id::text
    or not exists(select 1 from storage.objects where bucket_id='company-safety-documents' and name=attachment)
  ) then
    raise exception 'The attachment for this report is unavailable.' using errcode='22023';
  end if;
  insert into fleet_internal.company_safety_reports(id,fleet_id,driver_id,driver_name,category,incident_date,notes,document)
    values(report_id,target_fleet,actor,driver_label,incident_kind,incident_day,notes_value,attachment)
    on conflict (id) do nothing;
  if not found and not exists(
    select 1 from fleet_internal.company_safety_reports r where r.id=report_id and r.fleet_id=target_fleet and r.driver_id=actor
      and r.category=incident_kind and r.incident_date=incident_day and r.notes=notes_value and r.document is not distinct from attachment
  ) then
    raise exception 'A different report already uses this ID.' using errcode='22023';
  end if;
  return '{}'::jsonb;
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.reserve_dispatch_pro(requested_fleet_id text, requested_load_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  next_pro bigint;
begin
  if requested_load_id is null then
    raise exception 'A load reference is required.' using errcode = '22023';
  end if;

  -- The fleet row serializes allocation for this fleet, including retries.
  perform 1 from public.fleets
  where id = requested_fleet_id and fleet_internal.office_has_permission(requested_fleet_id,'dispatch')
  for update;
  if not found then
    raise exception 'Dispatch access is required to reserve a PRO number.' using errcode = '42501';
  end if;

  select pro_number into next_pro
  from fleet_internal.dispatch_pro_reservations
  where fleet_id = requested_fleet_id and load_id = requested_load_id;
  if found then
    return next_pro;
  end if;

  select coalesce(max(pro_number), 10000) + 1 into next_pro
  from fleet_internal.dispatch_pro_reservations
  where fleet_id = requested_fleet_id;

  insert into fleet_internal.dispatch_pro_reservations (fleet_id, load_id, pro_number)
  values (requested_fleet_id, requested_load_id, next_pro);
  return next_pro;
end;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_dispatch_driver_pay(requested_fleet_id text, first_driver_id uuid, second_driver_id uuid, requested_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  pickup_day date;
  pickup_week date;
  miles numeric;
  first_leg numeric;
  gross numeric;
  rate numeric;
  surcharge numeric;
  split_base numeric;
  combined_split numeric;
  driver_slot record;
  pay numeric;
  driver_miles numeric;
  pending text;
  drivers jsonb := '[]';
  has_pending boolean := false;
begin
  if current_user = 'authenticated' and not fleet_internal.office_has_permission(requested_fleet_id,'dispatch') then
    raise exception 'Dispatch access is required to calculate driver pay.' using errcode = '42501';
  end if;
  if requested_details #>> '{pickups,0,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_input_is_valid(requested_details #>> '{pickups,0,date}', 'date') then
    pickup_day := (requested_details #>> '{pickups,0,date}')::date;
    pickup_week := pickup_day - (extract(isodow from pickup_day)::integer - 1);
  end if;
  if requested_details ->> 'loadedMiles' ~ '^([0-9]{1,9}(\.[0-9]{0,4})?|\.[0-9]{1,4})$' then
    miles := (requested_details ->> 'loadedMiles')::numeric;
  end if;
  if requested_details ->> 'firstLegMiles' ~ '^([0-9]{1,9}(\.[0-9]{0,4})?|\.[0-9]{1,4})$' then
    first_leg := (requested_details ->> 'firstLegMiles')::numeric;
  end if;
  if requested_details ->> 'payGross' ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$' then
    gross := (requested_details ->> 'payGross')::numeric;
  end if;
  select cents_per_mile into rate from public.fleet_dispatch_fuel_rates
    where fleet_id = requested_fleet_id and week_start = pickup_week;
  surcharge := round(miles * rate / 100, 2);
  split_base := gross - surcharge;
  select coalesce(sum(split_percent), 0) into combined_split
    from public.fleet_dispatch_drivers
    where fleet_id = requested_fleet_id and id in (first_driver_id, second_driver_id)
      and pay_method = 'split';

  for driver_slot in
    select slots.slot, d.id, d.driver_type, d.pay_method, d.split_percent, d.mile_rate
    from (values (1, first_driver_id), (2, second_driver_id)) as slots(slot, driver_id)
    join public.fleet_dispatch_drivers d on d.fleet_id = requested_fleet_id and d.id = slots.driver_id
    order by slots.slot
  loop
    pay := null;
    pending := null;
    driver_miles := null;
    case driver_slot.pay_method
      when 'split' then
        pending := case
          when gross is null then 'Enter the gross load amount.'
          when miles is null then 'Enter route loaded miles.'
          when pickup_week is null then 'Enter the first pickup date.'
          when rate is null then 'Set the fuel surcharge for the pickup week.'
          when split_base < 0 then 'Gross is below the fuel surcharge.'
          when combined_split > 100 then 'The two driver splits exceed 100% of the load.'
        end;
        if pending is null then pay := round(split_base * driver_slot.split_percent / 100, 2); end if;
      when 'per_mile' then
        if second_driver_id is null then driver_miles := miles;
        elsif first_leg between 0 and miles then
          driver_miles := case when driver_slot.slot = 1 then first_leg else miles - first_leg end;
        end if;
        if miles is null then pending := 'Enter route loaded miles.';
        elsif driver_miles is null then pending := 'Enter Driver 1 leg miles in Split Load Details.';
        else pay := round(driver_miles * driver_slot.mile_rate, 2);
        end if;
      when 'hourly' then null;
      else null;
    end case;
    has_pending := has_pending or pending is not null;
    drivers := drivers || jsonb_build_array(jsonb_build_object(
      'slot', driver_slot.slot, 'driverId', driver_slot.id, 'type', driver_slot.driver_type,
      'method', driver_slot.pay_method, 'amount', pay, 'pending', pending,
      'splitPercent', driver_slot.split_percent, 'mileRate', driver_slot.mile_rate, 'miles', driver_miles
    ));
  end loop;

  return jsonb_build_object(
    'drivers', drivers, 'pending', has_pending, 'gross', gross, 'loadedMiles', miles,
    'weekStart', pickup_week, 'fuelRateCents', rate, 'fuelSurcharge', surcharge, 'splitBase', split_base
  );
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.record_dispatch_progress(requested_load_id uuid, expected_updated_at timestamp with time zone, requested_action text, requested_stop_key text, requested_arrival_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  load_row public.fleet_dispatch_loads%rowtype;
  next_key text;
  recorded jsonb;
  current_progress jsonb;
  occurred_at timestamptz := clock_timestamp();
  next_status text := 'current';
begin
  select loads.* into load_row
  from public.fleet_dispatch_loads loads
  join public.fleets fleets on fleets.id = loads.fleet_id
  where loads.id = requested_load_id and fleet_internal.office_has_permission(loads.fleet_id,'dispatch')
  for update of loads;
  if not found then raise exception 'Load unavailable to this account.' using errcode = '42501'; end if;
  if load_row.status <> 'current' or load_row.updated_at is distinct from expected_updated_at then
    raise exception 'This load changed. Refresh it before recording progress.' using errcode = '40001';
  end if;
  current_progress := load_row.progress;
  select stop_key into next_key
    from fleet_internal.dispatch_stop_keys(load_row.details)
    where current_progress #>> array['stops',stop_key,'completedAt'] is null
    order by stop_order limit 1;
  case requested_action
    when 'en_route' then
      if current_progress ? 'enRouteAt' or current_progress -> 'stops' <> '{}'::jsonb or next_key is null then
        raise exception 'The load has already started.' using errcode = '22023';
      end if;
      current_progress := current_progress || jsonb_build_object('enRouteAt', occurred_at);
    when 'arrive', 'depart' then
      if requested_stop_key is null or not exists (
        select 1 from fleet_internal.dispatch_stop_keys(load_row.details) where stop_key = requested_stop_key
      ) then
        raise exception 'Select a valid stop.' using errcode = '22023';
      end if;
      recorded := coalesce(current_progress #> array['stops', requested_stop_key], '{}'::jsonb);
      if requested_action = 'arrive' then
        if requested_stop_key is distinct from next_key and not (recorded ? 'arrivalAt') then
          raise exception 'Record the next scheduled stop first.' using errcode = '22023';
        end if;
        requested_arrival_at := coalesce(requested_arrival_at, occurred_at);
        if not isfinite(requested_arrival_at) or requested_arrival_at > occurred_at
          or requested_arrival_at > (recorded ->> 'completedAt')::timestamptz then
          raise exception 'Arrival must be at or before the current time and any recorded departure.' using errcode = '22023';
        end if;
        if recorded ? 'arrivalAt' and (recorded ->> 'arrivalAt')::timestamptz <> requested_arrival_at then
          recorded := recorded || jsonb_build_object('previousArrivalAt', recorded -> 'arrivalAt');
        end if;
        recorded := recorded || jsonb_build_object('arrivalAt', requested_arrival_at);
      else
        if requested_stop_key is distinct from next_key or not (recorded ? 'arrivalAt') or recorded ? 'completedAt' then
          raise exception 'Record an arrival for the next scheduled stop before completing it.' using errcode = '22023';
        end if;
        recorded := recorded || jsonb_build_object('completedAt', occurred_at);
      end if;
      current_progress := jsonb_set(current_progress, array['stops', requested_stop_key], recorded);
    when 'complete' then
      current_progress := current_progress || jsonb_build_object('completedAt', occurred_at);
      next_status := 'completed';
    else
      raise exception 'Unsupported progress action.' using errcode = '22023';
  end case;

  update public.fleet_dispatch_loads
  set progress = current_progress, status = next_status
  where id = load_row.id returning * into load_row;
  return to_jsonb(load_row);
end;
$function$;

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
begin
  if actor is null or not fleet_internal.office_has_permission(fleet,'dispatch') then
    raise exception 'Only this Fleet Admin can review driver activity.' using errcode='42501';
  end if;
  if action='list' then
    return jsonb_build_object(
      'returns',coalesce((
        select jsonb_agg(jsonb_build_object('id',q.id,'pro',q.pro_number,'driver',d.name,'shipper',q.details #>> '{pickups,0,company}',
          'receiver',q.details #>> '{receivers,0,company}','address',q.details #>> '{receivers,0,address}',
          'source_pro',source.pro_number) order by q.created_at)
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

CREATE OR REPLACE FUNCTION fleet_internal.driver_document_access(object_name text, writing boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  load_key text := split_part(object_name,'/',1);
  load_row public.fleet_dispatch_loads%rowtype;
  assigned uuid;
begin
  if actor is null or load_key !~ '^[0-9a-f-]{36}$'
    or load_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select * into load_row from public.fleet_dispatch_loads where id = load_key::uuid;
  if not found then return false; end if;
  if not writing and fleet_internal.office_has_permission(load_row.fleet_id,'dispatch') then return true; end if;
  assigned := fleet_internal.workflow_driver(actor,load_row.fleet_id);
  if assigned is null or (assigned is distinct from load_row.driver_id and assigned is distinct from load_row.second_driver_id) then
    return false;
  end if;
  if not writing then return load_row.status in ('current','completed') or load_row.return_review is not null; end if;
  return split_part(object_name,'/',2)=actor::text
    and (load_row.status='current' or load_row.return_review='pending')
    and coalesce(load_row.progress #>> array['driverResponses',assigned::text,'decision'],'')='accepted';
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.company_pay_staff(actor uuid, fleet text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.fleets where id=fleet and admin_user_id=actor) or exists(
    select 1 from public.fleet_employees e where e.user_id=actor and e.fleet_id=fleet
       and not e.password_required and (e.office_is_official or e.office_permissions && array['payroll','settlements']));
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.company_driver_files_access(object_key text, operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  target_fleet text := split_part(object_key,'/',1);
  profile_number text := split_part(object_key,'/',2);
  fleet_owner boolean;
begin
  if actor is null then return false; end if;
  fleet_owner := fleet_internal.company_pay_staff(actor,target_fleet);
  if operation = 'read' then
    return exists (
      select 1 from fleet_internal.company_driver_pay_files f
      where f.storage_key=object_key and (fleet_owner or (f.driver_id=actor and exists(
        select 1 from public.rigtracker_profiles where user_id=actor and profile_type='company_driver' and not password_required
      )))
    );
  end if;
  if not fleet_internal.office_has_permission(target_fleet,'payroll') or object_key !~ '^[a-z0-9]{1,20}/[0-9]{16}/[0-9a-f-]{36}\.(pdf|jpeg|png|webp)$' then return false; end if;
  return operation='upload' and exists (
    select 1 from public.rigtracker_fleet_links l join public.rigtracker_profiles p on p.user_id=l.profile_user_id
    where l.fleet_id=target_fleet and p.profile_id=profile_number and p.profile_type='company_driver'
  );
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
  title_value text := btrim(params ->> 'title');
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
        'documents',coalesce((select jsonb_agg(to_jsonb(f) - 'driver_id' order by f.period_end desc,f.published_at desc)
          from fleet_internal.company_driver_pay_files f where f.fleet_id=fleet and f.driver_id=target_driver),'[]'::jsonb));
    when 'set_clock' then
      if link.unlinked_at is not null or jsonb_typeof(params -> 'enabled') is distinct from 'boolean' then
        raise exception 'Choose an active Company Driver and a switch setting.' using errcode='22023';
      end if;
      update public.rigtracker_fleet_links set time_clock_enabled=(params ->> 'enabled')::boolean
        where fleet_id=fleet and profile_user_id=target_driver;
    when 'publish_pay' then
      if coalesce(char_length(title_value),0) not between 1 and 120
        or coalesce(object_key,'') not like fleet || '/' || profile_number || '/%'
        or not fleet_internal.company_driver_files_access(object_key,'upload') or not exists(
          select 1 from storage.objects where bucket_id='company-driver-pay' and name=object_key
        ) then raise exception 'Add a title and upload the statement file.' using errcode='22023'; end if;
      pay_start := (params ->> 'period_start')::date;
      pay_end := (params ->> 'period_end')::date;
      if pay_start is null or pay_end is null or not isfinite(pay_start) or not isfinite(pay_end) or pay_end < pay_start then
        raise exception 'Enter the start and end dates for the pay period.' using errcode='22023';
      end if;
      if exists(select 1 from fleet_internal.company_driver_pay_files
        where storage_key=object_key and fleet_id=fleet and driver_id=target_driver) then return '{}'::jsonb; end if;
      if replacement is not null then
        update fleet_internal.company_driver_pay_files set status='replaced'
          where storage_key=replacement and fleet_id=fleet and driver_id=target_driver and status='correction_requested';
        if not found then raise exception 'This statement is no longer awaiting a correction.' using errcode='22023'; end if;
      end if;
      insert into fleet_internal.company_driver_pay_files(storage_key,fleet_id,driver_id,title,period_start,period_end,replaces_key)
        values(object_key,fleet,target_driver,title_value,pay_start,pay_end,replacement);
    when 'submit_pay' then
      update fleet_internal.company_driver_pay_files set status='submitted',submitted_at=clock_timestamp()
        where storage_key=object_key and fleet_id=fleet and driver_id=target_driver and status='accepted';
      if not found then raise exception 'The driver must accept this statement before payroll can submit it.' using errcode='22023'; end if;
    else raise exception 'Unsupported driver document or clock action.' using errcode='22023';
  end case;
  return '{}'::jsonb;
end;
$function$;

-- Evaluate delegated profile management for the fleet and the target's current access.
create function fleet_internal.office_profile_manager(target_fleet text, actor uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=actor)
    or exists(select 1 from public.fleet_employees e where e.fleet_id=target_fleet and e.user_id=actor
      and not e.password_required and e.office_can_manage_profiles);
$$;

create function fleet_internal.office_can_edit_employee(account public.fleet_employees, actor uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=account.fleet_id and f.admin_user_id=actor)
    or (account.user_id<>actor and not account.office_is_official and not account.office_can_manage_profiles and exists(
      select 1 from public.fleet_employees e where e.fleet_id=account.fleet_id and e.user_id=actor
        and not e.password_required and e.office_can_manage_profiles
        and (e.office_is_official or account.office_permissions <@ e.office_permissions)
    ));
$$;
revoke all on function fleet_internal.office_profile_manager(text,uuid),
  fleet_internal.office_can_edit_employee(public.fleet_employees,uuid) from public,anon,authenticated;

create function fleet_internal.office_profiles(fleet text, action text, employee_number text, settings jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  fleet_admin boolean := exists (select 1 from public.fleets f where f.id=fleet and f.admin_user_id=actor);
  account public.fleet_employees%rowtype;
  selected_permissions text[];
  official_choice boolean;
  manage_profiles_choice boolean;
begin
  if actor is null or not fleet_internal.office_profile_manager(fleet,actor) then
    raise exception 'Manage Employee Profiles access is required.' using errcode='42501';
  end if;
  if action='list' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id',e.employee_id,'first_name',e.first_name,'last_name',e.last_name,
      'office_role',e.office_role,'office_is_official',e.office_is_official,'office_permissions',e.office_permissions,
      'office_can_manage_profiles',e.office_can_manage_profiles,'password_required',e.password_required,
      'can_edit',fleet_internal.office_can_edit_employee(e,actor)) order by e.created_at desc,e.employee_id)
      from public.fleet_employees e where e.fleet_id=fleet),'[]'::jsonb);
  end if;

  select * into account from public.fleet_employees e where e.fleet_id=fleet and e.employee_id=employee_number for update;
  if not found or not fleet_internal.office_can_edit_employee(account,actor) then
    raise exception 'You cannot manage this Office profile.' using errcode='42501';
  end if;
  if action='reset_target' then return jsonb_build_object('user_id',account.user_id); end if;
  if action is distinct from 'edit' or jsonb_typeof(settings -> 'permissions') is distinct from 'array' then
    raise exception 'Select valid Office access options.' using errcode='22023';
  end if;
  official_choice := account.office_is_official;
  manage_profiles_choice := account.office_can_manage_profiles;
  if settings ? 'is_official' or settings ? 'can_manage_profiles' then
    if not fleet_admin then raise exception 'Only the Fleet Admin can change designation or profile management access.' using errcode='42501'; end if;
    if jsonb_typeof(settings -> 'is_official') is distinct from 'boolean'
      or jsonb_typeof(settings -> 'can_manage_profiles') is distinct from 'boolean' then
      raise exception 'Choose Official or Unofficial and whether they can manage profiles.' using errcode='22023';
    end if;
    official_choice := (settings ->> 'is_official')::boolean;
    manage_profiles_choice := (settings ->> 'can_manage_profiles')::boolean;
  end if;
  select array(select distinct value from jsonb_array_elements_text(settings -> 'permissions') value where value is not null order by value)
    into selected_permissions;
  if not (selected_permissions <@ array['dispatch','drivers','assets','messages','hr','payroll','settlements','hourly','bank_ledger','payments','policies','activity']) then
    raise exception 'Select valid Office access options.' using errcode='22023';
  end if;
  if not fleet_admin and not exists(select 1 from public.fleet_employees e
    where e.user_id=actor and e.fleet_id=fleet and not e.password_required and e.office_can_manage_profiles
      and (e.office_is_official or selected_permissions <@ e.office_permissions)) then
    raise exception 'You can assign permissions within your own access.' using errcode='42501';
  end if;
  update public.fleet_employees e set office_is_official=official_choice,office_permissions=selected_permissions,
      office_can_manage_profiles=manage_profiles_choice where e.user_id=account.user_id and e.fleet_id=fleet;
  return '{}'::jsonb;
end;
$$;

create function public.office_profiles(fleet text, action text, employee_number text default null, settings jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.office_profiles(fleet,action,employee_number,settings); $$;

revoke all on function fleet_internal.office_profiles(text,text,text,jsonb),public.office_profiles(text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function fleet_internal.office_profiles(text,text,text,jsonb),public.office_profiles(text,text,text,jsonb)
  to authenticated;

-- Auth applies administrator-supplied password and app metadata in the same transaction.
-- A fresh reset marker restores the first-sign-in requirement after Auth updates the hash.
create function fleet_internal.require_temporary_office_password()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  account public.fleet_employees%rowtype;
  actor uuid;
begin
  if new.raw_app_meta_data ->> 'office_password_reset_id' is null or
     new.raw_app_meta_data ->> 'office_password_reset_id' is not distinct from old.raw_app_meta_data ->> 'office_password_reset_id' then
    return new;
  end if;
  actor := (new.raw_app_meta_data ->> 'office_password_reset_by')::uuid;
  select * into account from public.fleet_employees e where e.user_id=new.id for update;
  if not found or actor is null or not fleet_internal.office_can_edit_employee(account,actor) then
    raise exception 'You cannot reset this Office password.' using errcode='42501';
  end if;
  update public.fleet_employees set password_required=true,last_seen_at=null where user_id=new.id;
  return new;
end;
$$;
revoke all on function fleet_internal.require_temporary_office_password() from public,anon,authenticated;
create constraint trigger rigtracker_require_temporary_office_password
  after update of raw_app_meta_data on auth.users deferrable initially deferred
  for each row execute function fleet_internal.require_temporary_office_password();
