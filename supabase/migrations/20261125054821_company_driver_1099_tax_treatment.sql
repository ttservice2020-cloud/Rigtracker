create or replace function fleet_internal.payroll_tax_profile(
  action text, target_fleet text, target_kind text, target_reference text, as_of date,
  settings jsonb, expected_revision uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid := case when target_kind in ('hr_office','hr_driver')
    then fleet_internal.hr_tax_worker(target_fleet,target_kind,target_reference,true)
    else fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference) end;
  profile fleet_internal.payroll_tax_profiles%rowtype;
begin
  if as_of is null or as_of not between date '2020-01-01' and date '2100-12-31' then
    raise exception 'Choose a valid effective date.' using errcode='22023';
  end if;

  if action='read' then
    select t.* into profile from fleet_internal.payroll_tax_profiles t
    where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on<=as_of
    order by t.effective_on desc limit 1;
  elsif action='save' then
    -- Use the same lock as paid checks so a check cannot race a classification change.
    perform pg_advisory_xact_lock(hashtextextended(target_fleet || ':' || employee::text,0));
    if settings->>'taxTreatment'='1099_nec' then
      if target_kind<>'hr_driver'
        or settings is distinct from '{"taxTreatment":"1099_nec","classificationVerified":true}'::jsonb then
        raise exception 'Confirm independent contractor classification in the driver’s HR tax profile.'
          using errcode='22023';
      end if;
    else
      perform fleet_internal.validate_payroll_tax_settings(settings);
    end if;
    if expected_revision is null then
      insert into fleet_internal.payroll_tax_profiles as t(fleet_id,employee_user_id,effective_on,settings,saved_by)
      values(target_fleet,employee,as_of,settings,actor)
      on conflict(fleet_id,employee_user_id,effective_on) do nothing returning t.* into profile;
    else
      update fleet_internal.payroll_tax_profiles t
      set settings=payroll_tax_profile.settings, revision=gen_random_uuid(), saved_by=actor, saved_at=clock_timestamp()
      where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on=as_of
        and t.revision=expected_revision returning t.* into profile;
    end if;
    if not found then
      raise exception 'Tax settings changed for this date. Reopen Tax Information and try again.' using errcode='40001';
    end if;
  else
    raise exception 'Choose a tax profile action.' using errcode='22023';
  end if;

  if profile.revision is null then return null; end if;
  return jsonb_build_object('effective_on',profile.effective_on,'settings',profile.settings,'revision',profile.revision);
end;
$$;

create or replace function fleet_internal.payroll_paid_check_history(
  action text, target_fleet text, target_kind text, target_reference text, pay_date date,
  state_ui text, payment_reference text, expected_revision text, check_data jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  employee uuid := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  driver_settlement uuid := case when target_kind='settlement' then target_reference::uuid end;
  ref text := lower(nullif(btrim(payment_reference),''));
  pay_year_start date := date_trunc('year',pay_date::timestamp)::date;
  receipt fleet_internal.payroll_paid_checks%rowtype;
  latest fleet_internal.payroll_paid_checks%rowtype;
  treatment text;
  totals jsonb;
  line_totals jsonb;
  prior jsonb := check_data->'prior';
  current_amounts jsonb := check_data->'amounts';
  details jsonb := check_data->'statement';
  fields constant text[] := array['gross','deductions','socialSecurityYtd','medicareYtd','supplementalYtd','futaYtd','sutaYtd','federalWages'];
begin
  if target_kind not in ('office','settlement') or pay_date is null
    or pay_date not between date '2020-01-01' and date '2100-12-31'
    or (state_ui is not null and state_ui !~ '^[A-Z]{2}$') then
    raise exception 'Choose a valid pay date and state unemployment jurisdiction.' using errcode='22023';
  end if;

  if action='record' then
    perform pg_advisory_xact_lock(hashtextextended(target_fleet || ':' || employee::text,0));
  elsif action is distinct from 'read' then
    raise exception 'Choose a payroll history action.' using errcode='22023';
  end if;

  if driver_settlement is not null then
    ref := 'settlement:' || driver_settlement::text;
    select c.* into receipt from fleet_internal.payroll_paid_checks c
    where c.settlement_id=driver_settlement and c.fleet_id=target_fleet and c.employee_user_id=employee;
  elsif ref is not null then
    select c.* into receipt from fleet_internal.payroll_paid_checks c
    where c.fleet_id=target_fleet and c.employee_user_id=employee
      and c.pay_year=extract(year from pay_date)::integer and c.check_ref=ref;
  end if;

  select c.* into latest from fleet_internal.payroll_paid_checks c
  where c.fleet_id=target_fleet and c.employee_user_id=employee
    and c.paid_on>=pay_year_start and c.paid_on<pay_year_start+interval '1 year'
  order by c.paid_on desc,c.id desc limit 1;

  if receipt.id is not null then
    if action='record' then
      raise exception 'This payment is already recorded.' using errcode='23505';
    end if;
    select jsonb_object_agg(key,
      case when receipt.prior_totals->>key is not null and receipt.amounts->>key is not null
        then (receipt.prior_totals->>key)::numeric+(receipt.amounts->>key)::numeric end)
      into totals from unnest(fields) as key;
    return jsonb_build_object('before',receipt.prior_totals,'through',totals,
      'paid_on',receipt.paid_on,'statement',receipt.statement,'amounts',receipt.amounts,'ui_state',receipt.ui_state);
  end if;

  select coalesce(profile.settings->>'taxTreatment','w2') into treatment
  from fleet_internal.payroll_tax_profiles profile
  where profile.fleet_id=target_fleet and profile.employee_user_id=employee and profile.effective_on<=pay_date
  order by profile.effective_on desc limit 1;
  treatment := coalesce(treatment,'w2');

  -- An opening balance and its later checks must have the same tax treatment.
  -- The latest verified opening balance anchors each category. A missing check amount
  -- after that anchor makes the total unknown until payroll verifies a new balance.
  select jsonb_object_agg(key,
    case when coalesce(balance.missing,0)=0 then balance.total end) into totals
  from unnest(fields) as key
  cross join lateral (
    select count(*) filter (where c.amounts->>key is null) as missing,
      anchor.opening+sum((c.amounts->>key)::numeric) as total
    from (
      select a.paid_on,a.id,(a.prior_totals->>key)::numeric as opening
      from fleet_internal.payroll_paid_checks a
      where a.fleet_id=target_fleet and a.employee_user_id=employee
        and a.paid_on between pay_year_start and pay_date and a.prior_totals->>key is not null
        and coalesce(a.statement->>'taxTreatment','w2')=treatment
        and (key<>'sutaYtd' or a.ui_state=state_ui)
      order by a.paid_on desc,a.id desc limit 1
    ) anchor
    join fleet_internal.payroll_paid_checks c on c.fleet_id=target_fleet and c.employee_user_id=employee
      and c.paid_on between anchor.paid_on and pay_date and (c.paid_on,c.id)>=(anchor.paid_on,anchor.id)
      and coalesce(c.statement->>'taxTreatment','w2')=treatment
      and (key<>'sutaYtd' or c.ui_state=state_ui or c.ui_state is null)
    group by anchor.opening
  ) balance;

  if action='record' then
    if coalesce(details->>'taxTreatment','w2') is distinct from treatment then
      raise exception 'The driver’s tax form changed. Reopen the statement before recording payment.' using errcode='40001';
    end if;
    if expected_revision is distinct from coalesce(latest.id::text,'0') then
      raise exception 'Payroll history changed. Reopen the estimate before recording this payment.' using errcode='40001';
    end if;
    if pay_date>current_date or ref is null or length(ref)>100
      or (driver_settlement is null and ref like 'settlement:%') then
      raise exception 'Enter an issued pay date and a unique payment reference.' using errcode='22023';
    end if;
    if latest.paid_on>pay_date then
      raise exception 'Record payments in pay-date order within each year. Use verified prior totals for earlier payroll.' using errcode='22023';
    end if;
    if jsonb_typeof(prior) is distinct from 'object' or jsonb_typeof(current_amounts) is distinct from 'object'
      or jsonb_typeof(details) is distinct from 'object' or octet_length(check_data::text)>16000
      or array(select jsonb_object_keys(prior)) <@ fields is not true
      or array(select jsonb_object_keys(current_amounts)) <@ fields is not true
      or exists (
        select 1 from (select * from jsonb_each(prior) union all select * from jsonb_each(current_amounts)) item
        where case when jsonb_typeof(value)='null' then false
          when jsonb_typeof(value)='number' then (value::text)::numeric not between 0 and 100000000
            or (value::text)::numeric <> round((value::text)::numeric,2)
          else true end
      )
      or exists (select 1 from unnest(fields[1:4]) key where prior->>key is null or current_amounts->>key is null)
      or (current_amounts->>'deductions')::numeric>(current_amounts->>'gross')::numeric
      or (prior->>'deductions')::numeric>(prior->>'gross')::numeric then
      raise exception 'Enter valid verified year-to-date totals and check amounts.' using errcode='22023';
    end if;
    if treatment='1099_nec' and (state_ui is not null or exists (
      select 1 from unnest(fields[3:]) key
      where coalesce((prior->>key)::numeric,0)<>0 or coalesce((current_amounts->>key)::numeric,0)<>0
    )) then
      raise exception 'Contractor payments cannot be recorded as employee wages.' using errcode='22023';
    end if;
    if treatment='1099_nec' and (case when jsonb_typeof(details->'nonemployeeCompensation')='number' then
      (details->>'nonemployeeCompensation')::numeric not between 0 and (current_amounts->>'gross')::numeric
      or (details->>'nonemployeeCompensation')::numeric<>round((details->>'nonemployeeCompensation')::numeric,2)
      else true end) then
      raise exception 'Enter valid nonemployee compensation for this payment.' using errcode='22023';
    end if;
    if exists (
      select 1 from unnest(array['earnings','taxes','deductions']) key
      where jsonb_typeof(details->key) is distinct from 'array'
    ) or jsonb_typeof(details->'taxTotal') is distinct from 'number' then
      raise exception 'The settlement requires an itemized pay and tax breakdown.' using errcode='22023';
    end if;
    if exists (
      select 1 from unnest(array['earnings','taxes','deductions']) as key
      cross join lateral jsonb_array_elements(details->key) line
      where jsonb_typeof(line->'name') is distinct from 'string' or length(btrim(line->>'name')) not between 1 and 180
        or case when jsonb_typeof(line->'amount')='number'
          then (line->>'amount')::numeric not between 0 and 100000000
            or (line->>'amount')::numeric <> round((line->>'amount')::numeric,2)
          else true end
    ) then
      raise exception 'Enter a description and valid amount for each settlement line.' using errcode='22023';
    end if;
    select jsonb_object_agg(key,subtotal) into line_totals
    from unnest(array['earnings','taxes','deductions']) as key
    cross join lateral (select coalesce(sum((line->>'amount')::numeric),0) subtotal
      from jsonb_array_elements(details->key) line) lines;
    if (line_totals->>'earnings')::numeric <> (current_amounts->>'gross')::numeric
      or (line_totals->>'taxes')::numeric <> (details->>'taxTotal')::numeric
      or (line_totals->>'taxes')::numeric+(line_totals->>'deductions')::numeric
        <> (current_amounts->>'deductions')::numeric then
      raise exception 'The settlement line amounts must match the gross pay, taxes and deductions.' using errcode='22023';
    end if;
    insert into fleet_internal.payroll_paid_checks
      (fleet_id,employee_user_id,paid_on,check_ref,settlement_id,ui_state,prior_totals,amounts,statement,recorded_by)
    values (target_fleet,employee,pay_date,ref,driver_settlement,state_ui,prior,current_amounts,details,auth.uid());
    return fleet_internal.payroll_paid_check_history('read',target_fleet,target_kind,target_reference,pay_date,
      state_ui,payment_reference,null,null);
  end if;

  return jsonb_build_object('before',coalesce(totals,'{}'::jsonb),'revision',coalesce(latest.id::text,'0'),
    'tax_treatment',treatment);
end;
$$;

