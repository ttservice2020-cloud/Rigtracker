create table public.owner_op_trucks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.rigtracker_profiles(user_id) on delete cascade,
  unit_number text not null check (unit_number = upper(btrim(unit_number)) and char_length(unit_number) between 1 and 40),
  vin text check (vin ~ '^[A-Z0-9]{1,25}$'),
  model_year integer check (model_year between 1900 and 2199),
  make text check (char_length(make) <= 80),
  model text check (char_length(model) <= 80),
  plate text check (char_length(plate) <= 20),
  unique (user_id, unit_number)
);

alter table public.owner_op_trucks enable row level security;
revoke all on table public.owner_op_trucks from public, anon, authenticated;
grant select, delete on table public.owner_op_trucks to authenticated;
grant insert (user_id, unit_number, vin, model_year, make, model, plate),
  update (unit_number, vin, model_year, make, model, plate) on table public.owner_op_trucks to authenticated;

create policy owner_op_trucks_own on public.owner_op_trucks
  for all to authenticated
  using (
    user_id = (select auth.uid()) and exists (
      select 1 from public.rigtracker_profiles
      where user_id = (select auth.uid()) and profile_type = 'driver' and not password_required
    )
  )
  with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.rigtracker_profiles
      where user_id = (select auth.uid()) and profile_type = 'driver' and not password_required
    )
  );

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('owner-op-documents', 'owner-op-documents', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif']);

create policy owner_op_documents_read on storage.objects
  for select to authenticated using (
    bucket_id = 'owner-op-documents' and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy owner_op_documents_upload on storage.objects
  for insert to authenticated with check (
    bucket_id = 'owner-op-documents' and split_part(name, '/', 1) = (select auth.uid())::text
    and array_length(string_to_array(name, '/'), 1) = 2
    and split_part(name, '/', 2) <> ''
    and exists (
      select 1 from public.rigtracker_profiles
      where user_id = (select auth.uid()) and profile_type = 'driver' and not password_required
    )
  );

create policy owner_op_documents_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'owner-op-documents' and split_part(name, '/', 1) = (select auth.uid())::text
  );
