-- Partner access to inventory: step 1 of 2.
--
-- DORMANT WITH THE TEAM PASSWORD. The app signs people in with one shared team password
-- and talks to the database from its server with the secret key (the service role),
-- which row level security doesn't apply to. Nobody signs in through Supabase Auth and
-- private.partner_emails stays empty, so public.is_partner() is false for every request
-- and the policy below lets nobody in. This file is kept as it is because the later
-- migrations and the eight ledger and order functions call public.is_partner(), and
-- step 2 checks that this step has been applied.
--
-- When: any time before step 2. It only adds objects; nothing that works today changes,
-- and the team-password app doesn't depend on it.
--
-- What it adds:
--   private.partner_emails          one row per partner (the allowlist); leave it empty
--   public.is_partner()             true when the signed-in user's email is on it
--   "Partners can manage inventory" one FOR ALL policy for signed-in partners
--
-- Later migrations call public.is_partner() in their own policies and
-- functions, so keep that name and signature.
--
-- Why an allowlist table instead of writing the emails into the policy with
-- auth.jwt() ->> 'email':
--   - this repository is public, and emails in a migration would be published
--     with it; the table's rows would be added in the SQL editor instead
--   - adding or removing a partner is one INSERT or DELETE, not a new migration
-- The table lives in the `private` schema, which the Data API does not expose,
-- and only its owner can read it. is_partner() is SECURITY DEFINER so it can
-- check the table on the caller's behalf. Signed-in users can also call it as
-- /rest/v1/rpc/is_partner, which only tells them whether their own email is
-- on the list. Supabase's Security Advisor shows that as warning 0029 ("callable
-- by signed-in users"); that is intended. Signed-out callers (anon) can't run it.
--
-- Step 2 (20261015120100_tighten_database_permissions.sql) goes AFTER the
-- team-password version of the app is deployed. See SETUP.md for the full order.

create schema if not exists private;

create table if not exists private.partner_emails (
  email text primary key,
  constraint partner_emails_lowercase check (email = lower(btrim(email)))
);

revoke all on table private.partner_emails from anon, authenticated;

create or replace function public.is_partner()
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

-- The app needs these as `authenticated`; RLS limits them to partners.
grant select, insert, update, delete on table public.inventory to authenticated;

drop policy if exists "Partners can manage inventory" on public.inventory;
-- (select ...) makes Postgres run the check once per query, not once per row.
create policy "Partners can manage inventory"
  on public.inventory
  for all
  to authenticated
  using ((select public.is_partner()))
  with check ((select public.is_partner()));
