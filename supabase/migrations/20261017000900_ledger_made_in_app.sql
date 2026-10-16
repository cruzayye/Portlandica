-- Mark the inventory ledger movements that came through the app.
--
-- With the team password the app's server reaches the database with the secret key (the
-- service role), so the movements it writes carry no user id: created_by stays NULL, just
-- as it does for the opening balances and for changes made in the SQL Editor or the
-- Supabase dashboard. This column tells them apart, so the Inventory tab can say "Team"
-- for changes made in the app and "System" for the rest.
--
-- made_in_app is true when the movement was written during a Data API request. PostgREST
-- marks every request by setting request.jwt.claims, and the app's server is the only
-- thing that changes stock through the Data API. Direct database sessions, such as the
-- SQL Editor, the dashboard and migrations, have no claims, so their movements get false,
-- and so does every movement already in the ledger unless a signed-in user made it.
-- private.ledger_require_partner() tells the two apart the same way.
--
-- Only adds a column; nothing that reads the ledger today changes.
-- Undo: supabase/rollback/20261017000900_ledger_made_in_app.sql.

alter table public.inventory_movements
  add column made_in_app boolean not null
  default (nullif(current_setting('request.jwt.claims', true), '') is not null);

-- Movements made before this column existed by a signed-in user came through the app too.
update public.inventory_movements set made_in_app = true where created_by is not null;

comment on column public.inventory_movements.made_in_app is
  'True when the movement came through the Data API (the app); false for the SQL Editor, the dashboard and migrations.';
