create policy fleet_driver_profile_files_self_read on storage.objects for select to authenticated
  using (
    bucket_id='fleet-driver-profile-files'
    and cardinality(string_to_array(name,'/'))=4
    and split_part(name,'/',3)='documents'
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

create function fleet_internal.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid)
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
      'id',draft.id,'settlement_number',draft.settlement_number,'created_at',draft.created_at,
      'load_count',draft.load_count,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'pro_number',line.pro_number,'is_return',load.return_of is not null,
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

create function public.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.company_payroll_saved_settlements(target_fleet,requested_settlement_id);
$$;
revoke all on function fleet_internal.company_payroll_saved_settlements(text,uuid),
  public.company_payroll_saved_settlements(text,uuid) from public, anon, authenticated;
grant execute on function fleet_internal.company_payroll_saved_settlements(text,uuid),
  public.company_payroll_saved_settlements(text,uuid) to authenticated;
