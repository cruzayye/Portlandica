-- Chain locations (Ben Bridge, Elephants Delicatessen, Moberi, The Whole Bowl and so on) are
-- billed through one Square customer, usually the head office's accounts-payable contact, so
-- several customers may now share a square_customer_id. A plain index keeps lookups fast.
drop index if exists public.customers_square_customer_id_key;

create index if not exists customers_square_customer_id_idx on public.customers (square_customer_id)
  where square_customer_id is not null;

comment on column public.customers.square_customer_id is
  'Matching customer id in Square, once linked. Chain locations may share their head office''s Square customer.';
