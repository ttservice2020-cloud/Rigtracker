alter table public.rigtracker_fleet_links
  add column time_clock_enabled boolean not null default false;

create table fleet_internal.company_driver_shifts (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz check (ended_at >= started_at)
);
create unique index one_open_company_driver_shift on fleet_internal.company_driver_shifts(fleet_id,driver_id) where ended_at is null;
create index company_driver_shifts_driver on fleet_internal.company_driver_shifts(driver_id,fleet_id,started_at desc);

create table fleet_internal.company_driver_pay_files (
  storage_key text primary key,
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  published_at timestamptz not null default clock_timestamp(),
  status text not null default 'awaiting_review'
    check (status in ('awaiting_review','correction_requested','accepted','submitted','replaced')),
  review_note text check (char_length(review_note) <= 1000),
  reviewed_at timestamptz,
  submitted_at timestamptz,
  replaces_key text unique references fleet_internal.company_driver_pay_files(storage_key),
  check (status <> 'submitted' or submitted_at is not null)
);
create index company_driver_pay_by_driver on fleet_internal.company_driver_pay_files(driver_id,period_end desc);
create index company_driver_pay_by_fleet on fleet_internal.company_driver_pay_files(fleet_id,driver_id,period_end desc);
revoke all on fleet_internal.company_driver_shifts, fleet_internal.company_driver_pay_files from public, anon, authenticated;

create function fleet_internal.company_pay_staff(actor uuid, fleet text)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.fleets where id=fleet and admin_user_id=actor) or exists(
    select 1 from public.fleet_employees e where e.user_id=actor and e.fleet_id=fleet
       and not e.password_required and e.office_permissions @> array['payroll']);
$$;

create function fleet_internal.company_driver_files_access(object_key text, operation text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
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
  if not fleet_owner or object_key !~ '^[a-z0-9]{1,20}/[0-9]{16}/[0-9a-f-]{36}\.(pdf|jpeg|png|webp)$' then return false; end if;
  return operation='upload' and exists (
    select 1 from public.rigtracker_fleet_links l join public.rigtracker_profiles p on p.user_id=l.profile_user_id
    where l.fleet_id=target_fleet and p.profile_id=profile_number and p.profile_type='company_driver'
  );
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('company-driver-pay','company-driver-pay',false,10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']);
create policy company_driver_pay_read on storage.objects for select to authenticated
  using (bucket_id='company-driver-pay' and fleet_internal.company_driver_files_access(name,'read'));
create policy company_driver_pay_upload on storage.objects for insert to authenticated
  with check (bucket_id='company-driver-pay' and fleet_internal.company_driver_files_access(name,'upload'));

create function fleet_internal.company_driver_resources(action text, fleet text, profile_number text, params jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
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
$$;

-- A re-linked driver must be explicitly enabled again by that fleet.
create function fleet_internal.disable_unlinked_company_clock()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if new.unlinked_at is not null then new.time_clock_enabled := false; end if;
  return new;
end;
$$;
create trigger disable_unlinked_company_clock
  before update of unlinked_at on public.rigtracker_fleet_links
  for each row execute function fleet_internal.disable_unlinked_company_clock();

create function public.company_driver_resources(action text, fleet text default null,
  profile_number text default null, params jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.company_driver_resources(action,fleet,profile_number,params); $$;

revoke all on function fleet_internal.company_pay_staff(uuid,text), fleet_internal.company_driver_files_access(text,text),
  fleet_internal.company_driver_resources(text,text,text,jsonb), fleet_internal.disable_unlinked_company_clock(),
  public.company_driver_resources(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.company_driver_files_access(text,text),
  fleet_internal.company_driver_resources(text,text,text,jsonb),
  public.company_driver_resources(text,text,text,jsonb) to authenticated;

create table fleet_internal.driver_private_message_access (
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_id uuid not null,
  staff_id uuid not null,
  granted_by uuid not null,
  granted_at timestamptz not null default clock_timestamp(),
  primary key (fleet_id,driver_id,staff_id)
);
create index driver_private_message_staff on fleet_internal.driver_private_message_access(staff_id,fleet_id);

create table fleet_internal.company_message_threads (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_id uuid not null,
  kind text not null check (kind in ('dispatch','maintenance','private')),
  staff_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  check ((kind='private') = (staff_id is not null)),
  unique nulls not distinct (fleet_id,driver_id,kind,staff_id)
);
create index company_message_threads_driver on fleet_internal.company_message_threads(driver_id,updated_at desc);
create index company_message_threads_fleet on fleet_internal.company_message_threads(fleet_id,updated_at desc);
create table fleet_internal.company_messages (
  id uuid primary key,
  thread_id uuid not null references fleet_internal.company_message_threads(id) on delete cascade,
  sender_id uuid not null,
  sender_name text not null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);
create index company_message_history on fleet_internal.company_messages(thread_id,created_at,id);
create table fleet_internal.company_message_reads (
  thread_id uuid not null references fleet_internal.company_message_threads(id) on delete cascade,
  viewer_id uuid not null,
  read_at timestamptz not null,
  primary key (thread_id,viewer_id)
);
revoke all on fleet_internal.company_message_reads from public, anon, authenticated;
revoke all on fleet_internal.driver_private_message_access, fleet_internal.company_message_threads,
  fleet_internal.company_messages from public, anon, authenticated;

-- Office roles are assigned by the Fleet Admin and stored on fleet membership.
create function fleet_internal.message_staff_scope(actor uuid, fleet text)
returns text[] language sql stable set search_path = ''
as $$
  select case when exists(select 1 from public.fleets where id=fleet and admin_user_id=actor)
    then array['staff','official','dispatch','maintenance']
    else coalesce((
      select array_remove(array[
        'staff',
        case when lower(btrim(e.office_role))='official' then 'official' end,
        case when lower(btrim(e.office_role))='official' or e.office_permissions && array['dispatch','messages'] then 'dispatch' end,
        case when lower(btrim(e.office_role))='official' or e.office_permissions @> array['assets'] then 'maintenance' end
      ],null) from public.fleet_employees e where e.fleet_id=fleet and e.user_id=actor and not e.password_required
    ),array[]::text[]) end;
$$;

create function fleet_internal.company_driver_is_linked(actor uuid, fleet text)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.rigtracker_fleet_links l
    join public.rigtracker_profiles p on p.user_id=l.profile_user_id
    where l.fleet_id=fleet and l.profile_user_id=actor and l.unlinked_at is null
      and p.profile_type='company_driver' and not p.password_required);
$$;

create function fleet_internal.message_thread_visible(t fleet_internal.company_message_threads, actor uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.rigtracker_profiles p where p.user_id=actor and p.user_id=t.driver_id
        and p.profile_type='company_driver' and not p.password_required)
    or (t.kind='private' and t.staff_id=actor and 'staff'=any(fleet_internal.message_staff_scope(actor,t.fleet_id)))
    or (t.kind<>'private' and t.kind=any(fleet_internal.message_staff_scope(actor,t.fleet_id)));
$$;

create function fleet_internal.company_messaging(action text, fleet text, thread uuid, params jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  scope text[];
  target_driver uuid;
  target_staff uuid;
  chat fleet_internal.company_message_threads%rowtype;
  channel text := params ->> 'kind';
  message_body text := btrim(params ->> 'body');
  message_id uuid;
  author_name text;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(
        jsonb_build_object('id',t.id,'fleet_id',t.fleet_id,'kind',t.kind,
         'contact',case when t.driver_id=actor then case when t.kind='private' then coalesce(
              (select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.fleet_employees where user_id=t.staff_id),
              'Fleet Official') else initcap(t.kind) end
            else coalesce((select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.rigtracker_profiles where user_id=t.driver_id),'Company Driver') end,
         'unread',exists(select 1 from fleet_internal.company_messages pending
            where pending.thread_id=t.id and pending.sender_id<>actor and pending.created_at>coalesce(
              (select r.read_at from fleet_internal.company_message_reads r where r.thread_id=t.id and r.viewer_id=actor),
              '-infinity'::timestamptz)),
         'last_message',(select jsonb_build_object('id',m.id,'sender_id',m.sender_id,'body',left(m.body,140),'created_at',m.created_at)
           from fleet_internal.company_messages m where m.thread_id=t.id order by m.created_at desc,m.id desc limit 1))
          order by t.updated_at desc) from (
            select * from fleet_internal.company_message_threads t
             where fleet_internal.message_thread_visible(t,actor) order by t.updated_at desc limit 150
          ) t),'[]'::jsonb),
      'staff_fleet',(select jsonb_build_object('id',f.id,'scope',fleet_internal.message_staff_scope(actor,f.id))
        from public.fleets f where f.admin_user_id=actor
          or f.id=(select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required)
        order by (f.admin_user_id=actor) desc limit 1),
      'linked_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_driver_is_linked(actor,l.fleet_id)), '[]'::jsonb)
    );
  end if;
  if action='contacts' then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if not ('staff'=any(scope)) then raise exception 'Staff access is required.' using errcode='42501'; end if;
    return jsonb_build_object(
      'drivers',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'name',
           coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),'Company Driver'),
           'private_enabled',exists(select 1 from fleet_internal.driver_private_message_access x
             where x.fleet_id=fleet and x.driver_id=p.user_id and x.staff_id=actor)) order by p.last_name,p.first_name)
        from public.rigtracker_profiles p join public.rigtracker_fleet_links l on l.profile_user_id=p.user_id
        where l.fleet_id=fleet and l.unlinked_at is null and p.profile_type='company_driver'), '[]'::jsonb),
      'staff', case when 'official'=any(scope) then coalesce((
        select jsonb_agg(staff_member order by name) from (
          select 'Fleet Admin' as name, jsonb_build_object('id',admin_user_id,'name','Fleet Admin') as staff_member
          from public.fleets where id=fleet
          union all
          select btrim(concat_ws(' ',first_name,last_name)),jsonb_build_object('id',user_id,'name',
            coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),fleet_id || '-' || employee_id))
          from public.fleet_employees where fleet_id=fleet
        ) staff_rows
      ),'[]'::jsonb) else '[]'::jsonb end,
      'grants',case when 'official'=any(scope) then coalesce((
        select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'staff_id',x.staff_id))
        from fleet_internal.driver_private_message_access x join public.rigtracker_profiles p on p.user_id=x.driver_id
        where x.fleet_id=fleet
      ),'[]'::jsonb) else '[]'::jsonb end);
  end if;
  if action in ('start','set_private_access') then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if 'staff'=any(scope) then
      select p.user_id into target_driver from public.rigtracker_profiles p
      where p.profile_id=params ->> 'profile_id' and p.profile_type='company_driver';
    else
      target_driver := actor;
    end if;
    if target_driver is null or not fleet_internal.company_driver_is_linked(target_driver,fleet) then
      raise exception 'Choose an active Company Driver in this fleet.' using errcode='42501';
    end if;
    if action='set_private_access' then
      if not ('official'=any(scope)) or jsonb_typeof(params -> 'enabled') is distinct from 'boolean' then
        raise exception 'Only an Official can change private messaging access.' using errcode='42501';
      end if;
      target_staff := (params ->> 'staff_id')::uuid;
      if not exists(select 1 from public.fleets where id=fleet and admin_user_id=target_staff)
        and not exists(select 1 from public.fleet_employees where fleet_id=fleet and user_id=target_staff) then
        raise exception 'Choose a member of this fleet’s staff.' using errcode='42501';
      end if;
      if (params ->> 'enabled')::boolean then
        insert into fleet_internal.driver_private_message_access(fleet_id,driver_id,staff_id,granted_by)
          values(fleet,target_driver,target_staff,actor) on conflict do nothing;
      else
        delete from fleet_internal.driver_private_message_access
          where fleet_id=fleet and driver_id=target_driver and staff_id=target_staff;
      end if;
      return '{}'::jsonb;
    end if;
    if channel='private' then
      if not ('staff'=any(scope)) or not exists(select 1 from fleet_internal.driver_private_message_access
        where fleet_id=fleet and driver_id=target_driver and staff_id=actor) then
        raise exception 'An Official must grant you private messaging for this driver.' using errcode='42501';
      end if;
      target_staff := actor;
    elsif coalesce(channel,'') not in ('dispatch','maintenance') or ('staff'=any(scope) and not (channel=any(scope))) then
      raise exception 'You do not have access to this team conversation.' using errcode='42501';
    end if;
    insert into fleet_internal.company_message_threads(fleet_id,driver_id,kind,staff_id)
      values(fleet,target_driver,channel,target_staff)
      on conflict(fleet_id,driver_id,kind,staff_id) do nothing returning * into chat;
    if not found then
      select * into chat from fleet_internal.company_message_threads
        where fleet_id=fleet and driver_id=target_driver and kind=channel and staff_id is not distinct from target_staff;
    end if;
    return jsonb_build_object('id',chat.id);
  end if;

  select * into chat from fleet_internal.company_message_threads where id=thread;
  if not found or not fleet_internal.message_thread_visible(chat,actor) then
    raise exception 'Conversation unavailable to this account.' using errcode='42501';
  end if;
  if action='thread' then
    if params -> 'mark_read' = 'true'::jsonb then
      insert into fleet_internal.company_message_reads(thread_id,viewer_id,read_at)
        values(chat.id,actor,statement_timestamp()) on conflict(thread_id,viewer_id)
        do update set read_at=greatest(company_message_reads.read_at,excluded.read_at);
    end if;
    return jsonb_build_object(
      'can_send',fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
          and (chat.kind<>'private' or exists(select 1 from fleet_internal.driver_private_message_access
            where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)),
      'messages',coalesce((select jsonb_agg(to_jsonb(msg) - 'thread_id' order by msg.created_at,msg.id) from (
        select * from fleet_internal.company_messages where thread_id=chat.id order by created_at desc,id desc limit 150
      ) msg),'[]'::jsonb));
  end if;
  if action<>'send' then raise exception 'Unsupported messaging action.' using errcode='22023'; end if;
  if not fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
    or (chat.kind='private' and not exists(select 1 from fleet_internal.driver_private_message_access
      where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)) then
    raise exception 'This conversation is closed for new messages.' using errcode='42501';
  end if;
  if coalesce(char_length(message_body),0) not between 1 and 4000 then
    raise exception 'Enter a message up to 4,000 characters.' using errcode='22023';
  end if;
  message_id := (params ->> 'message_id')::uuid;
  if message_id is null then raise exception 'Message ID is missing.' using errcode='22023'; end if;
  if actor=chat.driver_id then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Company Driver');
  else
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.fleet_employees where user_id=actor;
    author_name := coalesce(author_name,'Fleet Admin');
  end if;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body)
    values(message_id,chat.id,actor,author_name,message_body) on conflict(id) do nothing;
  if found then update fleet_internal.company_message_threads set updated_at=clock_timestamp() where id=chat.id; end if;
  return '{}'::jsonb;
end;
$$;

create function public.company_messaging(action text, fleet text default null, thread uuid default null, params jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.company_messaging(action,fleet,thread,params); $$;
revoke all on function fleet_internal.message_staff_scope(uuid,text), fleet_internal.company_driver_is_linked(uuid,text),
  fleet_internal.message_thread_visible(fleet_internal.company_message_threads,uuid),
  fleet_internal.company_messaging(text,text,uuid,jsonb), public.company_messaging(text,text,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function fleet_internal.company_messaging(text,text,uuid,jsonb), public.company_messaging(text,text,uuid,jsonb) to authenticated;
