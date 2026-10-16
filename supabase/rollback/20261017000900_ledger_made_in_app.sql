-- Undo 20261017000900_ledger_made_in_app.sql: drop the made_in_app column. The Inventory
-- tab then shows every change without a user id, the app's included, as "System".
--
-- Run it in the SQL Editor, first if you are also undoing the order flow and the data
-- foundation (supabase/rollback/20261017000700_order_flow.sql, then
-- supabase/rollback/20261017_data_foundation.sql). If the migration went in with
-- `supabase db push`, afterwards also run:
--   npx supabase migration repair --status reverted 20261017000900

alter table public.inventory_movements drop column made_in_app;
