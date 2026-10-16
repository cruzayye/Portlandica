-- Lock the database: step 2 of 2.
--
-- APPLY ONLY AFTER THE TEAM-PASSWORD VERSION OF THE APP IS DEPLOYED, and someone has
-- signed in and changed an inventory count successfully. That version writes with the
-- secret key (the service role), which bypasses these policies and grants, so this step
-- doesn't affect it. The version live before it writes to inventory with the publishable
-- key and no signed-in user, so applying this first breaks its inventory and order
-- writes.
--
-- It stops with an error, changing nothing, unless step 1
-- (20261015120000_partner_access.sql) is applied. The partner list
-- (private.partner_emails) can stay empty: with the team password nobody signs in
-- through Supabase Auth.
--
-- inventory: drops the older insert, update and delete policies and anon's write grants,
--   so the publishable key can no longer change inventory. The only policy left that
--   allows changes is step 1's "Partners can manage inventory", which lets nobody in
--   while the partner list is empty.
--   KEEPS "public can read inventory": Paul's monthly-close script reads inventory with
--   the publishable key and no signed-in user.
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
