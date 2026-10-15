-- Minimal stand-in for what Supabase provides, so the migrations can run in PGlite.
-- Roles, the auth schema helpers and default grants mirror a hosted project.

set timezone = 'UTC';

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text
);

create function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

-- Stand-in for the login migration's public.is_partner(): partners are the two test
-- users below. The real function decides membership its own way.
create function public.is_partner()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email' in ('paul@example.com', 'johnny@example.com'), false)
$$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'paul@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'johnny@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'stranger@example.com');
