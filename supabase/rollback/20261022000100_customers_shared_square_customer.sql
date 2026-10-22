-- Undo 20261022000100_customers_shared_square_customer.sql: make square_customer_id unique
-- again. It fails while two customers share a Square customer; unlink all but one of each
-- (update customers set square_customer_id = null where id = ...) first.
--
-- Run it in the SQL Editor. If the migration went in with `supabase db push`, afterwards
-- also run:
--   npx supabase migration repair --status reverted 20261022000100

drop index if exists public.customers_square_customer_id_idx;

create unique index customers_square_customer_id_key on public.customers (square_customer_id)
  where square_customer_id is not null;

comment on column public.customers.square_customer_id is 'Matching customer id in Square, once linked.';
