create or replace function fleet_internal.driver_profile_access(target_fleet text, permission text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=(select auth.uid()))
    or exists(select 1 from public.fleet_employees e
      where e.fleet_id=target_fleet and e.user_id=(select auth.uid()) and not e.password_required
        and (e.office_is_official or e.office_permissions && array['dispatch','drivers','payroll','settlements'])
        and (permission is null or permission=any(e.office_permissions)
          or (e.office_is_official and permission in ('driver_documents','driver_pay_settlements','driver_tax'))));
$$;

alter policy fleet_driver_profile_files_self_read on storage.objects
  using (
    bucket_id='fleet-driver-profile-files'
    and cardinality(string_to_array(name,'/'))=4
    and split_part(name,'/',3) in ('documents','tax')
    and split_part(name,'/',4)<>''
    and exists (
      select 1
      from public.rigtracker_fleet_links link
      join public.rigtracker_profiles profile on profile.user_id=link.profile_user_id
      where link.profile_user_id=(select auth.uid())
        and link.unlinked_at is null
        and profile.profile_type in ('company_driver','driver')
        and not profile.password_required
        and link.fleet_id=split_part(name,'/',1)
        and link.dispatch_driver_id::text=split_part(name,'/',2)
    )
  );
