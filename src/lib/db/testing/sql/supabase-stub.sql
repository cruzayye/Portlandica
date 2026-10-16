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

-- Supabase Auth users the tests sign in as. With the team password nobody signs in through
-- Supabase Auth; these exercise the dormant partner path (see testDb.ts).
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'paul@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'johnny@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'stranger@example.com');
