-- Undo 20261022000200_customers_invoiced_outside_square.sql: drop the column. Orders for
-- those customers then make Square drafts again whenever Create Invoice is on.
--
-- Run it in the SQL Editor. If the migration went in with `supabase db push`, afterwards
-- also run:
--   npx supabase migration repair --status reverted 20261022000200

alter table public.customers drop column invoiced_outside_square;
