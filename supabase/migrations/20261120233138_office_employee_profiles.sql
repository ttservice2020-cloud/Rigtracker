alter table public.fleet_employees
  add column first_name text,
  add column last_name text,
  add column office_role text,
  add column office_permissions text[] not null default '{}',
  add constraint fleet_employee_office_details_check check (
    (first_name is null and last_name is null and office_role is null and cardinality(office_permissions) = 0)
    or (
      coalesce(char_length(btrim(first_name)), 0) between 1 and 100
      and coalesce(char_length(btrim(last_name)), 0) between 1 and 100
      and coalesce(char_length(btrim(office_role)), 0) between 1 and 100
    )
  ),
  add constraint fleet_employee_office_permissions_check check (office_permissions <@ array['dispatch', 'drivers', 'assets', 'messages', 'hr', 'payroll', 'settlements', 'hourly', 'bank_ledger', 'payments', 'policies', 'activity']::text[]);

CREATE OR REPLACE FUNCTION fleet_internal.add_employee_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  employee_fleet_id text := new.raw_app_meta_data ->> 'fleet_id';
  employee_number text := new.raw_app_meta_data ->> 'employee_id';
begin
  if new.raw_app_meta_data ->> 'account_type' = 'fleet_employee' then
    if employee_fleet_id is null or employee_fleet_id !~ '^[a-z0-9]{1,20}$'
      or employee_number is null or employee_number !~ '^[0-9]{1,6}$'
      or new.email is distinct from lower(employee_fleet_id || '-' || employee_number) || '@fleet-login.rigtrackerpro.com' then
      raise exception 'Invalid fleet employee account.';
    end if;
    insert into public.fleet_employees (
      user_id, fleet_id, employee_id, first_name, last_name, office_role, office_permissions
    ) values (
      new.id, employee_fleet_id, employee_number,
      new.raw_user_meta_data ->> 'first_name',
      new.raw_user_meta_data ->> 'last_name',
      new.raw_app_meta_data ->> 'office_role',
      array(select jsonb_array_elements_text(coalesce(new.raw_app_meta_data -> 'office_permissions', '[]'::jsonb)))
    );
  elsif lower(coalesce(new.email, '')) like '%@fleet-login.rigtrackerpro.com' then
    raise exception 'Fleet employee accounts must be created by the Fleet Admin.';
  end if;
  return new;
end;
$function$;
