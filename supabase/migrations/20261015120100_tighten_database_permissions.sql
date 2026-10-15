-- Partner-only inventory changes: step 2 of 2.
--
-- APPLY ONLY AFTER THE SIGN-IN VERSION OF THE APP IS DEPLOYED, and partners
-- have signed in and changed an inventory count successfully. The app
-- version live today writes to inventory without a signed-in user, so
-- applying this before the deploy breaks its inventory and order writes.
--
-- It stops with an error, changing nothing, unless step 1
-- (20261015120000_partner_access.sql) is applied and private.partner_emails
-- has at least one row. The partner-list check is skipped when inventory is
-- empty, so a fresh database (such as `supabase db reset`, which runs
-- migrations before seed.sql) can still be built.
--
-- inventory: drops the older insert, update and delete policies, so only the
--   "Partners can manage inventory" policy from step 1 allows changes.
--   KEEPS "public can read inventory": the monthly-close script reads
--   inventory with the publishable key and no signed-in user.
-- orders (legacy table, not used by the app): drops both policies, so the
--   Data API can no longer read or write it. The rows stay.
--
-- Before applying, save the current policies so they can be restored exactly
-- if needed:
--   select * from pg_policies
--   where schemaname = 'public' and tablename in ('inventory', 'orders');
-- To roll back, re-create the dropped policies from that output and
-- re-grant insert, update, delete on public.inventory to anon.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory'
      and policyname = 'Partners can manage inventory'
  ) then
    raise exception 'Apply 20261015120000_partner_access.sql first.';
  end if;

  -- Only insist on partners when there is inventory to protect. The live
  -- database always has rows; a freshly built one has none yet.
  if exists (select 1 from public.inventory)
     and not exists (select 1 from private.partner_emails) then
    raise exception 'private.partner_emails is empty. Add the partner emails first, or nobody will be able to change inventory.';
  end if;
end
$$;

drop policy if exists "Allow insert inventory" on public.inventory;
drop policy if exists "Allow update inventory" on public.inventory;
drop policy if exists "Allow delete inventory" on public.inventory;
revoke insert, update, delete on table public.inventory from anon;

drop policy if exists "Anyone can create orders" on public.orders;
drop policy if exists "public can read order" on public.orders;

-- Check afterwards. inventory should list exactly:
--   Partners can manage inventory | ALL    | {authenticated}
--   public can read inventory     | SELECT | {anon}
-- and orders should list nothing:
--   select tablename, policyname, cmd, roles from pg_policies
--   where schemaname = 'public' and tablename in ('inventory', 'orders')
--   order by tablename, policyname;
