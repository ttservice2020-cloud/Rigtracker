create or replace function fleet_internal.payroll_withholding_fleets(employee uuid)
returns table(fleet_id text) language sql stable set search_path = ''
as $$
  select e.fleet_id from public.fleet_employees e
  where e.user_id=employee and not e.password_required
  union
  select l.fleet_id from public.rigtracker_fleet_links l
  join public.rigtracker_profiles p on p.user_id=l.profile_user_id
  where l.profile_user_id=employee and l.unlinked_at is null
    and p.profile_type in ('company_driver','driver') and not p.password_required;
$$;

create or replace function fleet_internal.payroll_withholding_file_access(object_name text, uploading boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parts text[] := string_to_array(object_name,'/');
  employee uuid;
  payroll_staff boolean;
begin
  if actor is null or cardinality(parts) is distinct from 4
    or parts[1]='' or parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or parts[3] not in ('w4','state','w9') or parts[4] !~ '^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$' then
    return false;
  end if;
  employee := parts[2]::uuid;
  payroll_staff := fleet_internal.office_has_permission(parts[1],'payroll');
  if parts[3]='w9' then
    if payroll_staff and not uploading then return true; end if;
    return (actor=employee or payroll_staff) and exists (
      select 1 from fleet_internal.payroll_withholding_fleets(employee) membership where membership.fleet_id=parts[1]
    );
  end if;

  payroll_staff := payroll_staff or (fleet_internal.office_has_permission(parts[1],'settlements')
    and fleet_internal.office_has_permission(parts[1],'driver_tax'));
  if not uploading then return actor=employee or payroll_staff; end if;
  return (actor=employee or payroll_staff) and (
    exists (select 1 from public.fleet_employees e
      where e.user_id=employee and e.fleet_id=parts[1] and not e.password_required)
    or exists (select 1 from public.rigtracker_fleet_links l
      join public.rigtracker_profiles p on p.user_id=l.profile_user_id
      where l.profile_user_id=employee and l.fleet_id=parts[1] and l.unlinked_at is null
        and p.profile_type='company_driver' and not p.password_required)
  );
end;
$$;

create or replace function fleet_internal.payroll_withholding_folders(target_fleet text, target_kind text, target_reference text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid;
begin
  if actor is null then raise exception 'Sign in to open tax forms.' using errcode='42501'; end if;
  if target_fleet is null and target_kind is null and target_reference is null then
    return coalesce((select jsonb_agg(jsonb_build_object('fleet',m.fleet_id,'folder',m.fleet_id||'/'||actor::text) order by m.fleet_id)
      from fleet_internal.payroll_withholding_fleets(actor) m),'[]'::jsonb);
  end if;
  if target_kind in ('contractor_driver','contractor_office') then
    if not fleet_internal.office_has_permission(target_fleet,'payroll') then
      raise exception 'Payroll access is required to open contractor tax forms.' using errcode='42501';
    end if;
    if target_kind='contractor_driver' then
      select l.profile_user_id into employee from public.rigtracker_fleet_links l
        join public.rigtracker_profiles p on p.user_id=l.profile_user_id
        where l.fleet_id=target_fleet and l.unlinked_at is null and p.profile_id=target_reference
          and p.profile_type in ('company_driver','driver');
    else
      select e.user_id into employee from public.fleet_employees e
        where e.fleet_id=target_fleet and e.employee_id=target_reference;
    end if;
    if employee is null then raise exception 'This recipient is unavailable in the selected fleet.' using errcode='42501'; end if;
  else
    employee := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  end if;
  return jsonb_build_array(jsonb_build_object('fleet',target_fleet,'folder',target_fleet||'/'||employee::text));
end;
$$;
