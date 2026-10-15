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

-- What the sign-in branch's 20261015120000_partner_access.sql sets up: a partner allowlist
-- and public.is_partner(). Mirrored here so these tests also pass once that migration sits
-- in the same folder (it runs after this stub and leaves the same definitions in place).
create schema private;

create table private.partner_emails (
  email text primary key,
  constraint partner_emails_lowercase check (email = lower(btrim(email)))
);

revoke all on table private.partner_emails from anon, authenticated;

insert into private.partner_emails (email) values ('paul@example.com'), ('johnny@example.com');

create function public.is_partner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.partner_emails
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.is_partner() from public, anon;
grant execute on function public.is_partner() to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'paul@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'johnny@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'stranger@example.com');
