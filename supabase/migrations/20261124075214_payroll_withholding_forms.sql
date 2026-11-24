insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('payroll-withholding-forms','payroll-withholding-forms',false,10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']);

create function fleet_internal.payroll_withholding_fleets(employee uuid)
returns table(fleet_id text) language sql stable set search_path = ''
as $$
  select e.fleet_id from public.fleet_employees e
  where e.user_id=employee and not e.password_required
  union
  select l.fleet_id from public.rigtracker_fleet_links l
  join public.rigtracker_profiles p on p.user_id=l.profile_user_id
  where l.profile_user_id=employee and l.unlinked_at is null
    and p.profile_type='company_driver' and not p.password_required;
$$;
revoke all on function fleet_internal.payroll_withholding_fleets(uuid) from public,anon,authenticated;

create function fleet_internal.payroll_withholding_file_access(object_name text, uploading boolean)
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
    or parts[3] not in ('w4','state') or parts[4] !~ '^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$' then
    return false;
  end if;
  employee := parts[2]::uuid;
  payroll_staff := fleet_internal.office_has_permission(parts[1],'payroll')
    or (fleet_internal.office_has_permission(parts[1],'settlements')
      and fleet_internal.office_has_permission(parts[1],'driver_tax'));
  if not uploading then return actor=employee or payroll_staff; end if;
  return (actor=employee or payroll_staff) and exists (
    select 1 from fleet_internal.payroll_withholding_fleets(employee) membership where membership.fleet_id=parts[1]
  );
end;
$$;
revoke all on function fleet_internal.payroll_withholding_file_access(text,boolean) from public,anon,authenticated;
grant execute on function fleet_internal.payroll_withholding_file_access(text,boolean) to authenticated;

create function fleet_internal.valid_withholding_elections(elections jsonb)
returns boolean language plpgsql immutable set search_path = ''
as $$
declare
  field text;
  amount numeric;
begin
  if elections is null then return true; end if;
  if jsonb_typeof(elections) is distinct from 'object'
    or elections - array['filingStatus','multipleJobs','credits','otherIncome','deductions','federalExtra','exemptYear'] <> '{}'::jsonb
    or coalesce(elections->>'filingStatus','') not in ('single','married','head','exempt')
    or jsonb_typeof(elections->'multipleJobs') is distinct from 'boolean' then return false; end if;
  foreach field in array array['credits','otherIncome','deductions','federalExtra','exemptYear'] loop
    if jsonb_typeof(elections->field) is distinct from 'number' then return false; end if;
    amount := (elections->>field)::numeric;
    if amount < 0 or amount > 100000000 or amount <> round(amount,2)
      or (field='exemptYear' and (amount <> trunc(amount) or amount not between 2020 and 2100)) then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function fleet_internal.valid_withholding_elections(jsonb) from public,anon,authenticated;
grant execute on function fleet_internal.valid_withholding_elections(jsonb) to authenticated;

create policy payroll_withholding_forms_read on storage.objects for select to authenticated
  using(bucket_id='payroll-withholding-forms' and fleet_internal.payroll_withholding_file_access(name,false));
create policy payroll_withholding_forms_upload on storage.objects for insert to authenticated
  with check(bucket_id='payroll-withholding-forms' and fleet_internal.payroll_withholding_file_access(name,true)
    and (user_metadata is null or user_metadata - 'w4'='{}'::jsonb)
    and (user_metadata->'w4' is null or (split_part(name,'/',3)='w4'
      and fleet_internal.valid_withholding_elections(user_metadata->'w4'))));

create function public.payroll_withholding_submissions(target_folder text)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(rec) order by rec.created_at desc,rec.path),'[]'::jsonb)
  from (
    select o.name as path, o.created_at, split_part(o.name,'/',3) as kind, o.user_metadata->'w4' as elections
    from storage.objects o
    where o.bucket_id='payroll-withholding-forms' and o.name like target_folder||'/%'
      and split_part(o.name,'/',1)||'/'||split_part(o.name,'/',2)=target_folder
      and fleet_internal.payroll_withholding_file_access(o.name,false)
    order by o.created_at desc,o.name limit 100
  ) rec;
$$;
revoke all on function public.payroll_withholding_submissions(text) from public,anon,authenticated;
grant execute on function public.payroll_withholding_submissions(text) to authenticated;

create function fleet_internal.payroll_withholding_folders(target_fleet text, target_kind text, target_reference text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid;
begin
  if actor is null then raise exception 'Sign in to open withholding forms.' using errcode='42501'; end if;
  if target_fleet is null and target_kind is null and target_reference is null then
    return coalesce((select jsonb_agg(jsonb_build_object('fleet',m.fleet_id,'folder',m.fleet_id||'/'||actor::text) order by m.fleet_id)
      from fleet_internal.payroll_withholding_fleets(actor) m),'[]'::jsonb);
  end if;
  employee := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  return jsonb_build_array(jsonb_build_object('fleet',target_fleet,'folder',target_fleet||'/'||employee::text));
end;
$$;

create function public.payroll_withholding_folders(target_fleet text default null, target_kind text default null, target_reference text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.payroll_withholding_folders(target_fleet,target_kind,target_reference);
$$;

revoke all on function fleet_internal.payroll_withholding_folders(text,text,text),
  public.payroll_withholding_folders(text,text,text) from public,anon,authenticated;
grant execute on function fleet_internal.payroll_withholding_folders(text,text,text),
  public.payroll_withholding_folders(text,text,text) to authenticated;
