create table fleet_internal.payroll_tax_profiles (
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_user_id uuid not null references auth.users(id) on delete cascade,
  effective_on date not null,
  settings jsonb not null,
  revision uuid not null default gen_random_uuid(),
  saved_by uuid not null,
  saved_at timestamptz not null default clock_timestamp(),
  primary key (fleet_id, employee_user_id, effective_on),
  check (effective_on between date '2020-01-01' and date '2100-12-31')
);
create index payroll_tax_profiles_employee_idx on fleet_internal.payroll_tax_profiles(employee_user_id);
alter table fleet_internal.payroll_tax_profiles enable row level security;
revoke all on table fleet_internal.payroll_tax_profiles from public, anon, authenticated;

-- Only structured payroll elections are accepted. Attachments and tax ID numbers
-- are handled outside this calculation settings table.
create function fleet_internal.validate_payroll_tax_settings(settings jsonb)
returns void language plpgsql immutable set search_path = ''
as $$
declare
  state_code text := settings->>'state';
  local_code text := settings->>'locality';
  field text;
  amount numeric;
  elections jsonb := settings->'elections';
begin
  if jsonb_typeof(settings) is distinct from 'object'
    or octet_length(settings::text) > 2600
    or settings - array['state','periods','federalForm','filingStatus','multipleJobs','legacyAllowances',
      'credits','otherIncome','deductions','federalExtra','federalExemptYear','stateTreatment','stateExemptYear',
      'stateExtra','locality','localityName','localExtra','elections'] <> '{}'::jsonb
    or not coalesce(state_code = any(string_to_array(
      'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY',' ')),false)
    or coalesce(settings->>'periods','') not in ('12','24','26','52')
    or coalesce(settings->>'federalForm','') not in ('current','legacy','exempt','special')
    or coalesce(settings->>'filingStatus','') not in ('single','married','head')
    or (settings->>'federalForm'='legacy' and settings->>'filingStatus'='head')
    or jsonb_typeof(settings->'multipleJobs') is distinct from 'boolean'
    or coalesce(settings->>'stateTreatment','') not in ('regular','exempt','review')
    or length(coalesce(settings->>'localityName','')) > 100
    or jsonb_typeof(elections) is distinct from 'object'
    or not coalesce(
      local_code in ('none','unverified')
      or (state_code='IN' and local_code ~ '^in:(0[1-9]|[1-8][0-9]|9[012])$')
      or (state_code='NY' and local_code='newYorkCity')
      or (state_code='KY' and local_code in ('louisvilleResident','louisvilleNonresident','lexington','elizabethtown','bardstown')),false) then
    raise exception 'Review the withholding elections and local jurisdiction.' using errcode='22023';
  end if;

  foreach field in array array['legacyAllowances','credits','otherIncome','deductions','federalExtra','stateExtra','localExtra',
    'federalExemptYear','stateExemptYear'] loop
    if jsonb_typeof(settings->field) is distinct from 'number' then
      raise exception 'Enter valid withholding amounts.' using errcode='22023';
    end if;
    amount := (settings->>field)::numeric;
    if amount < 0 or amount > 100000000 or amount <> round(amount,2)
      or (field = 'legacyAllowances' and (amount > 99 or amount <> trunc(amount)))
      or (field in ('federalExemptYear','stateExemptYear') and (amount <> trunc(amount) or amount not between 2020 and 2100)) then
      raise exception 'Enter valid withholding amounts.' using errcode='22023';
    end if;
  end loop;

  if elections - array['azRate','ilBase','ilAdditional','inPersonal','inDependent','inFirst','inAdopted',
    'ncStatus','ncAllowances','coStatus','coAllowance','miAllowances','moStatus','utStatus',
    'nyStatus','nyAllowances','nyCityAllowances','vaPersonal','vaAgeBlind','gaStatus','gaDependents',
    'iaStatus','iaLegacyCount','iaAllowance','maAllowances','maHead','maBlind'] <> '{}'::jsonb
    or (state_code='AZ' and coalesce(elections->>'azRate','') not in ('0','0.5','1','1.5','2','2.5','3','3.5'))
    or (state_code='NC' and coalesce(elections->>'ncStatus','') not in ('standard','head'))
    or (state_code='CO' and coalesce(elections->>'coStatus','') not in ('standard','joint','certificate'))
    or (state_code='MO' and coalesce(elections->>'moStatus','') not in ('single','joint','head'))
    or (state_code='NY' and coalesce(elections->>'nyStatus','') not in ('single','married'))
    or (state_code='GA' and coalesce(elections->>'gaStatus','') not in ('standard','joint'))
    or (state_code='IA' and coalesce(elections->>'iaStatus','') not in ('standard','head','joint','oldSingle','oldMarried'))
    or (state_code='MA' and (coalesce(elections->>'maHead','') not in ('0','1')
      or coalesce(elections->>'maBlind','') not in ('0','1','2')))
    or (state_code='UT' and coalesce(elections->>'utStatus','') not in ('single','married')) then
    raise exception 'Review the state withholding form elections.' using errcode='22023';
  end if;
  field := case state_code when 'CO' then 'coAllowance' when 'IA' then 'iaAllowance' end;
  if field is not null and (jsonb_typeof(elections->field) is distinct from 'number'
    or (elections->>field)::numeric not between 0 and 100000000
    or (elections->>field)::numeric <> round((elections->>field)::numeric,2)) then
    raise exception 'Review the annual withholding allowance.' using errcode='22023';
  end if;
  foreach field in array case state_code
    when 'IL' then array['ilBase','ilAdditional']
    when 'IN' then array['inPersonal','inDependent','inFirst','inAdopted']
    when 'NC' then array['ncAllowances'] when 'MI' then array['miAllowances']
    when 'NY' then array['nyAllowances','nyCityAllowances']
    when 'GA' then array['gaDependents'] when 'IA' then array['iaLegacyCount']
    when 'MA' then array['maAllowances','maHead','maBlind']
    when 'VA' then array['vaPersonal','vaAgeBlind'] else array[]::text[] end loop
    if jsonb_typeof(elections->field) is distinct from 'number' then
      raise exception 'Enter the number of allowances shown on the state form.' using errcode='22023';
    end if;
    amount := (elections->>field)::numeric;
    if amount < 0 or amount > 99 or amount <> trunc(amount) then
      raise exception 'Enter a whole number of allowances from 0 to 99.' using errcode='22023';
    end if;
  end loop;
end;
$$;
revoke all on function fleet_internal.validate_payroll_tax_settings(jsonb) from public, anon, authenticated;

create function fleet_internal.payroll_tax_profile(
  action text, target_fleet text, target_kind text, target_reference text, as_of date,
  settings jsonb, expected_revision uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid;
  profile fleet_internal.payroll_tax_profiles%rowtype;
begin
  if actor is null or not (
    exists (select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=actor)
    or exists (select 1 from public.fleet_employees e where e.fleet_id=target_fleet and e.user_id=actor
      and not e.password_required
      and (e.office_is_official or 'payroll'=any(e.office_permissions)
        or e.office_permissions @> array['settlements','driver_tax']))
  ) then
    raise exception 'Payroll access is required.' using errcode='42501';
  end if;

  if target_kind in ('driver','settlement') then
    select link.profile_user_id into employee
    from public.rigtracker_fleet_links link
    join public.rigtracker_profiles p on p.user_id=link.profile_user_id and p.profile_type='company_driver'
    where link.fleet_id=target_fleet and link.unlinked_at is null
      and case when target_kind='driver' then p.profile_id=target_reference else exists (
        select 1 from fleet_internal.company_driver_settlements draft
        where draft.id=target_reference::uuid and draft.driver_user_id=p.user_id and draft.fleet_id=target_fleet
      ) end;
  elsif target_kind='office' then
    select e.user_id into employee from public.fleet_employees e
    where e.user_id=target_reference::uuid and e.fleet_id=target_fleet;
  end if;
  if employee is null then
    raise exception 'This employee is unavailable in the selected fleet.' using errcode='42501';
  end if;
  if as_of is null or as_of not between date '2020-01-01' and date '2100-12-31' then
    raise exception 'Choose a valid effective date.' using errcode='22023';
  end if;

  if action='read' then
    select t.* into profile from fleet_internal.payroll_tax_profiles t
    where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on<=as_of
    order by t.effective_on desc limit 1;
  elsif action='save' then
    perform fleet_internal.validate_payroll_tax_settings(settings);
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

create function public.payroll_tax_profile(
  action text, target_fleet text, target_kind text, target_reference text, as_of date,
  settings jsonb default null, expected_revision uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.payroll_tax_profile(action,target_fleet,target_kind,target_reference,as_of,settings,expected_revision);
$$;

revoke all on function fleet_internal.payroll_tax_profile(text,text,text,text,date,jsonb,uuid),
  public.payroll_tax_profile(text,text,text,text,date,jsonb,uuid) from public, anon, authenticated;
grant execute on function fleet_internal.payroll_tax_profile(text,text,text,text,date,jsonb,uuid),
  public.payroll_tax_profile(text,text,text,text,date,jsonb,uuid) to authenticated;
