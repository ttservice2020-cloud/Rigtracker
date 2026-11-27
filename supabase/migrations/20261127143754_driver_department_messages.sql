-- New driver conversations use the three departments. Existing private history remains readable by its participants.
create function fleet_internal.message_driver_is_linked(actor uuid, fleet text, channel text)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select 1 from public.rigtracker_fleet_links link
    join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
    where link.fleet_id = fleet and link.profile_user_id = actor and link.unlinked_at is null
      and not profile.password_required and profile.profile_type in ('company_driver','driver')
      and channel in ('dispatch','safety','maintenance')
  );
$$;

revoke all on function fleet_internal.message_driver_is_linked(uuid,text,text) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION fleet_internal.message_thread_visible(t fleet_internal.company_message_threads, actor uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select exists(select 1 from public.rigtracker_profiles p where p.user_id=actor and p.user_id=t.driver_id
        and (p.profile_type='company_driver' or (p.profile_type='driver' and t.kind<>'private'))
        and not p.password_required)
    or (t.kind='private' and t.staff_id=actor and 'staff'=any(fleet_internal.message_staff_scope(actor,t.fleet_id)))
    or (t.kind<>'private' and t.kind=any(fleet_internal.message_staff_scope(actor,t.fleet_id)))
    or (t.kind<>'private' and fleet_internal.company_mechanic_is_linked(actor,t.fleet_id));
$function$;

create or replace function fleet_internal.company_message_image_access(object_name text, writing boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  chat fleet_internal.company_message_threads%rowtype;
begin
  if actor is null or object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|gif|heic|heif)$'
    or split_part(object_name,'/',1) !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
  select * into chat from fleet_internal.company_message_threads where id=split_part(object_name,'/',1)::uuid;
  if not found or not fleet_internal.message_thread_visible(chat,actor) then return false; end if;
  if writing then
    return split_part(object_name,'/',2)=actor::text
      and fleet_internal.message_driver_is_linked(chat.driver_id,chat.fleet_id,chat.kind);
  end if;
  return exists(select 1 from fleet_internal.company_messages msg where msg.thread_id=chat.id and msg.image_path=object_name);
end;
$$;

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
  chat fleet_internal.company_message_threads%rowtype;
  channel text := params ->> 'kind';
  message_body text := coalesce(btrim(params ->> 'body'),'');
  attachment_path text := nullif(params ->> 'image_path','');
  message_id uuid;
  author_name text;
  history jsonb;
  last_seen_at timestamptz;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(
        jsonb_build_object('id',t.id,'fleet_id',t.fleet_id,'kind',t.kind,'mine',t.driver_id=actor,
         'profile_id',(select p.profile_id from public.rigtracker_profiles p where p.user_id=t.driver_id),
         'contact',case when t.driver_id=actor then case when t.kind='private' then coalesce(
              (select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.fleet_employees where user_id=t.staff_id),
              'Fleet Official') else initcap(t.kind) end
            else coalesce((select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.rigtracker_profiles where user_id=t.driver_id),'Company Driver') end,
         'unread',exists(select 1 from fleet_internal.company_messages pending
            where pending.thread_id=t.id and pending.sender_id<>actor and pending.created_at>coalesce(
              (select r.read_at from fleet_internal.company_message_reads r where r.thread_id=t.id and r.viewer_id=actor),
              '-infinity'::timestamptz)),
         'last_message',(select jsonb_build_object('id',m.id,'sender_id',m.sender_id,'body',case when m.body='' and m.image_path is not null then 'Photo' else left(m.body,140) end,'created_at',m.created_at)
           from fleet_internal.company_messages m where m.thread_id=t.id order by m.created_at desc,m.id desc limit 1))
          order by t.updated_at desc) from (
            select * from fleet_internal.company_message_threads t
             where t.kind<>'private' and fleet_internal.message_thread_visible(t,actor) order by t.updated_at desc limit 150
          ) t),'[]'::jsonb),
      'staff_fleet',(select jsonb_build_object('id',f.id,'scope',fleet_internal.message_staff_scope(actor,f.id))
        from public.fleets f where f.admin_user_id=actor
          or f.id=(select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required)
        order by (f.admin_user_id=actor) desc limit 1),
      'mechanic_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id)
        from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_mechanic_is_linked(actor,l.fleet_id)), '[]'::jsonb),
      'linked_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.message_driver_is_linked(actor,l.fleet_id,'dispatch')), '[]'::jsonb)
    );
  end if;
  if action='contacts' then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if not ('staff'=any(scope)) and not fleet_internal.company_mechanic_is_linked(actor,fleet) then
      raise exception 'Fleet team access is required.' using errcode='42501';
    end if;
    return jsonb_build_object(
      'drivers',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'dispatch_driver_id',l.dispatch_driver_id,'profile_type',p.profile_type,'name',
           coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),case p.profile_type when 'driver' then 'Owner Op' else 'Company Driver' end))
           order by p.last_name,p.first_name)
        from public.rigtracker_profiles p join public.rigtracker_fleet_links l on l.profile_user_id=p.user_id
        where l.fleet_id=fleet and l.unlinked_at is null and p.profile_type in ('company_driver','driver') and not p.password_required), '[]'::jsonb),
      -- The previous frontend reads these arrays while the new site is deploying.
      'staff','[]'::jsonb, 'grants','[]'::jsonb);
  end if;
  if action='start' then
    if coalesce(channel,'') not in ('dispatch','safety','maintenance') then
      raise exception 'Choose Dispatch, Safety, or Maintenance.' using errcode='42501';
    end if;
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if 'staff'=any(scope) or fleet_internal.company_mechanic_is_linked(actor,fleet) then
      select p.user_id into target_driver from public.rigtracker_profiles p
      where p.profile_id=params ->> 'profile_id' and p.profile_type in ('company_driver','driver');
    else
      target_driver := actor;
    end if;
    if target_driver is null or not fleet_internal.message_driver_is_linked(target_driver,fleet,channel) then
      raise exception 'Choose an active linked driver in this fleet.' using errcode='42501';
    end if;
    if 'staff'=any(scope) and not (channel=any(scope)) then
      raise exception 'You do not have access to this team conversation.' using errcode='42501';
    end if;
    insert into fleet_internal.company_message_threads(fleet_id,driver_id,kind)
      values(fleet,target_driver,channel)
      on conflict(fleet_id,driver_id,kind,staff_id) do nothing returning * into chat;
    if not found then
      select * into chat from fleet_internal.company_message_threads
        where fleet_id=fleet and driver_id=target_driver and kind=channel and staff_id is null;
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
      'can_send',fleet_internal.message_driver_is_linked(chat.driver_id,chat.fleet_id,chat.kind),
      'messages',history);
  end if;
  if action<>'send' then raise exception 'Unsupported messaging action.' using errcode='22023'; end if;
  if not fleet_internal.message_driver_is_linked(chat.driver_id,chat.fleet_id,chat.kind) then
    raise exception 'This conversation is closed for new messages.' using errcode='42501';
  end if;
  if char_length(message_body)>4000 or (message_body='' and attachment_path is null) then
    raise exception 'Enter a message up to 4,000 characters or attach a photo.' using errcode='22023';
  end if;
  message_id := (params ->> 'message_id')::uuid;
  if message_id is null then raise exception 'Message ID is missing.' using errcode='22023'; end if;
  if attachment_path is not null and (
    attachment_path !~ ('^'||chat.id||'/'||actor||'/'||message_id||'[.](jpg|png|webp|gif|heic|heif)$')
    or not exists(select 1 from storage.objects where bucket_id='company-message-images' and name=attachment_path)
  ) then raise exception 'Upload the photo to this conversation first.' using errcode='22023'; end if;
  if actor=chat.driver_id then
    select coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),case profile_type when 'driver' then 'Owner Op' else 'Company Driver' end)
      into author_name from public.rigtracker_profiles where user_id=actor;
  elsif fleet_internal.company_mechanic_is_linked(actor,chat.fleet_id) then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name
      from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Maintenance');
  else
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.fleet_employees where user_id=actor;
    author_name := coalesce(author_name,'Fleet Admin');
  end if;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body,image_path)
    values(message_id,chat.id,actor,author_name,message_body,attachment_path) on conflict(id) do nothing;
  if found then update fleet_internal.company_message_threads set updated_at=clock_timestamp() where id=chat.id; end if;
  return '{}'::jsonb;
end;
$function$;
