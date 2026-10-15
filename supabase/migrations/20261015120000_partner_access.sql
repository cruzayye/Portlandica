-- Partner access to inventory: step 1 of 2.
--
-- APPLY THIS BEFORE DEPLOYING THE SIGN-IN VERSION OF THE APP. It only adds
-- objects; nothing that works today changes.
--
-- Why it has to come first: once partners sign in, the app queries Supabase
-- as the `authenticated` role instead of `anon`. Without this policy the
-- signed-in app would see an empty inventory and orders would fail after the
-- sheet row is written.
--
-- What it adds:
--   private.partner_emails          one row per partner (the allowlist)
--   private.is_partner()            true when the signed-in user's email is on it
--   "Partners can manage inventory" one FOR ALL policy for signed-in partners
--
-- Why an allowlist table instead of writing the emails into the policy with
-- auth.jwt() ->> 'email':
--   - this repository is public, and emails in a migration would be published
--     with it; the table's rows are added in the SQL editor instead
--   - adding or removing a partner is one INSERT or DELETE, not a new migration
-- The table lives in the `private` schema, which the Data API does not expose,
-- so the publishable key can't read it. is_partner() is SECURITY DEFINER so
-- the policy can check the table without giving `authenticated` access to it.
--
-- Right after applying, add the partners (lower case, the same list as the
-- ALLOWED_EMAILS env var in Vercel):
--   insert into private.partner_emails (email) values
--     ('partner-one@example.com'),
--     ('partner-two@example.com');
--
-- Step 2 (20261015120100_tighten_database_permissions.sql) goes AFTER the
-- deploy. See SETUP.md for the full order.

create schema if not exists private;

create table if not exists private.partner_emails (
  email text primary key,
  constraint partner_emails_lowercase check (email = lower(btrim(email)))
);

revoke all on table private.partner_emails from anon, authenticated;

create or replace function private.is_partner()
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

revoke all on function private.is_partner() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_partner() to authenticated;

-- The app needs these as `authenticated`; RLS limits them to partners.
grant select, insert, update, delete on table public.inventory to authenticated;

drop policy if exists "Partners can manage inventory" on public.inventory;
-- (select ...) makes Postgres run the check once per query, not once per row.
create policy "Partners can manage inventory"
  on public.inventory
  for all
  to authenticated
  using ((select private.is_partner()))
  with check ((select private.is_partner()));
