create table fleet_internal.company_safety_reports (
  id uuid primary key,
  fleet_id text not null references public.fleets(id) on delete cascade,
  driver_id uuid not null,
  driver_name text not null,
  category text not null check (category in ('dot_inspection','ticket','accident','other')),
  incident_date date not null check (isfinite(incident_date)),
  notes text not null check (char_length(notes)<=3000),
  document text unique,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  check (notes<>'' or document is not null)
);
create index company_safety_fleet_reports on fleet_internal.company_safety_reports(fleet_id,created_at desc);
create index company_safety_driver_reports on fleet_internal.company_safety_reports(driver_id,created_at desc);
revoke all on fleet_internal.company_safety_reports from public,anon,authenticated;

create function fleet_internal.company_safety_file_access(object_key text, operation text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owning_fleet text := split_part(object_key,'/',1);
begin
  if actor is null then return false; end if;
  if operation='upload' then
    return object_key ~ '^[a-z0-9]{1,20}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$'
      and split_part(object_key,'/',2)=actor::text
      and fleet_internal.company_driver_is_linked(actor,owning_fleet);
  elsif operation='read' then
    return exists(select 1 from fleet_internal.company_safety_reports r where r.document=object_key and (
      'official'=any(fleet_internal.message_staff_scope(actor,r.fleet_id)) or
      (r.driver_id=actor and exists(select 1 from public.rigtracker_profiles p
       where p.user_id=actor and p.profile_type='company_driver' and not p.password_required))
    ));
  end if;
  return false;
end;
$$;
revoke all on function fleet_internal.company_safety_file_access(text,text) from public,anon,authenticated;
grant execute on function fleet_internal.company_safety_file_access(text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('company-safety-documents','company-safety-documents',false,10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']);

create policy company_safety_read_document on storage.objects for select to authenticated
  using (bucket_id='company-safety-documents' and fleet_internal.company_safety_file_access(name,'read'));

create policy company_safety_upload_document on storage.objects for insert to authenticated
  with check (bucket_id='company-safety-documents' and fleet_internal.company_safety_file_access(name,'upload'));

create function fleet_internal.company_safety(action text, report_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
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
      where e.user_id=actor and not e.password_required and lower(btrim(e.office_role))='official')
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
$$;

create function public.company_safety(action text, report_id uuid default null, payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.company_safety(action,report_id,payload); $$;

revoke all on function fleet_internal.company_safety(text,uuid,jsonb),public.company_safety(text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function fleet_internal.company_safety(text,uuid,jsonb),public.company_safety(text,uuid,jsonb)
  to authenticated;

alter table fleet_internal.company_message_threads
  drop constraint company_message_threads_kind_check,
  add constraint company_message_threads_kind_check check (kind in ('dispatch','maintenance','safety','private'));

create function fleet_internal.company_mechanic_is_linked(actor uuid, fleet text)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.rigtracker_fleet_links l
    join public.rigtracker_profiles p on p.user_id=l.profile_user_id
    where l.fleet_id=fleet and l.profile_user_id=actor and l.unlinked_at is null
      and p.profile_type='mechanic' and not p.password_required);
$$;
revoke all on function fleet_internal.company_mechanic_is_linked(uuid,text) from public,anon,authenticated;

create or replace function fleet_internal.message_staff_scope(actor uuid, fleet text)
returns text[] language sql stable set search_path = ''
as $$
  select case when exists(select 1 from public.fleets where id=fleet and admin_user_id=actor)
    then array['staff','official','dispatch','maintenance','safety']
    else coalesce((
      select array['staff']
        || case when lower(btrim(e.office_role))='official' then array['official'] else array[]::text[] end
        || case when lower(btrim(e.office_role))='official' or e.office_permissions && array['dispatch','messages','assets','policies']
          then array['dispatch','maintenance','safety'] else array[]::text[] end
      from public.fleet_employees e where e.fleet_id=fleet and e.user_id=actor and not e.password_required
    ),array[]::text[]) end;
$$;

CREATE OR REPLACE FUNCTION fleet_internal.message_thread_visible(t fleet_internal.company_message_threads, actor uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.rigtracker_profiles p where p.user_id=actor and p.user_id=t.driver_id
        and p.profile_type='company_driver' and not p.password_required)
    or (t.kind='private' and t.staff_id=actor and 'staff'=any(fleet_internal.message_staff_scope(actor,t.fleet_id)))
    or (t.kind<>'private' and t.kind=any(fleet_internal.message_staff_scope(actor,t.fleet_id)))
    or (t.kind<>'private' and fleet_internal.company_mechanic_is_linked(actor,t.fleet_id));
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.company_messaging(action text, fleet text, thread uuid, params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  history jsonb;
  last_seen_at timestamptz;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(
        jsonb_build_object('id',t.id,'fleet_id',t.fleet_id,'kind',t.kind,
         'profile_id',(select p.profile_id from public.rigtracker_profiles p where p.user_id=t.driver_id),
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
      'mechanic_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id)
        from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_mechanic_is_linked(actor,l.fleet_id)), '[]'::jsonb),
      'linked_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_driver_is_linked(actor,l.fleet_id)), '[]'::jsonb)
    );
  end if;
  if action='contacts' then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if not ('staff'=any(scope)) and not fleet_internal.company_mechanic_is_linked(actor,fleet) then
      raise exception 'Fleet team access is required.' using errcode='42501';
    end if;
    return jsonb_build_object(
      'drivers',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'dispatch_driver_id',l.dispatch_driver_id,'name',
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
    if 'staff'=any(scope) or fleet_internal.company_mechanic_is_linked(actor,fleet) then
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
    elsif coalesce(channel,'') not in ('dispatch','maintenance','safety') or ('staff'=any(scope) and not (channel=any(scope))) then
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
    select coalesce(jsonb_agg(to_jsonb(msg) - 'thread_id' order by msg.created_at,msg.id),'[]'::jsonb),
        max(msg.created_at)
      into history,last_seen_at
      from (select * from fleet_internal.company_messages where thread_id=chat.id
        order by created_at desc,id desc limit 150) msg;
    if params -> 'mark_read' = 'true'::jsonb and last_seen_at is not null then
      insert into fleet_internal.company_message_reads(thread_id,viewer_id,read_at)
        values(chat.id,actor,last_seen_at) on conflict(thread_id,viewer_id)
        do update set read_at=greatest(company_message_reads.read_at,excluded.read_at);
    end if;
    return jsonb_build_object(
      'can_send',fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
          and (chat.kind<>'private' or exists(select 1 from fleet_internal.driver_private_message_access
            where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)),
      'messages',history);
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
  elsif fleet_internal.company_mechanic_is_linked(actor,chat.fleet_id) then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name
      from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Maintenance');
  else
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.fleet_employees where user_id=actor;
    author_name := coalesce(author_name,'Fleet Admin');
  end if;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body)
    values(message_id,chat.id,actor,author_name,message_body) on conflict(id) do nothing;
  if found then update fleet_internal.company_message_threads set updated_at=clock_timestamp() where id=chat.id; end if;
  return '{}'::jsonb;
end;
$function$;
