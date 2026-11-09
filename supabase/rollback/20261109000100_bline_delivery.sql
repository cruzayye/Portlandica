-- Undo 20261109000100_bline_delivery.sql: drop BLine's stock log, its view and functions,
-- put create_sales_order back as 20261017000700 made it, and drop the delivery_fee column
-- and the 'bline' delivery type.
--
-- Run it in the SQL Editor as one script. It stops, changing nothing, while any order is a
-- BLine order, since those can't keep their delivery type. To undo anyway, first make them
-- drops (their fees are lost):
--   update public.sales_orders set delivery_type = 'drop', delivery_fee = null
--   where delivery_type = 'bline';
-- The cans recorded at BLine are lost too; batch counts don't change. If the migration went
-- in with `supabase db push`, afterwards also run:
--   npx supabase migration repair --status reverted 20261109000100

begin;

do $$
begin
  if exists (select 1 from public.sales_orders where delivery_type = 'bline') then
    raise exception 'Some orders are BLine orders; make them drops first (see the top of this file)';
  end if;
end
$$;

drop function public.set_bline_count(bigint, integer, text, integer);
drop function public.record_bline_move(bigint, integer, text, date, text);
drop view public.bline_stock;
drop table public.bline_stock_moves;

drop function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean, numeric);

create function public.create_sales_order(
  p_idempotency_key text,
  p_delivery_type text,
  p_lines jsonb,
  p_customer_id bigint default null,
  p_customer_name text default null,
  p_type text default null,
  p_delivery_date date default null,
  p_notes text default null,
  p_total_price numeric default null,
  p_is_paid boolean default false,
  p_create_invoice boolean default false,
  p_is_donation boolean default false,
  p_order_date date default null,
  p_po_number text default null,
  p_delivery_address text default null,
  p_customer_email text default null,
  p_new_customer boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id bigint;
  v_customer public.customers;
  v_name text;
begin
  perform private.ledger_require_partner();

  if p_idempotency_key is null or p_idempotency_key !~ '^\S+$' then
    raise exception 'Every order needs an idempotency key'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select o.id into v_order_id from public.sales_orders o where o.idempotency_key = p_idempotency_key;
  if found then
    return private.orders_snapshot(v_order_id, false);
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An order needs at least one line'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  if p_customer_id is not null then
    select * into v_customer from public.customers c where c.id = p_customer_id;
    if not found then
      raise exception 'Customer % does not exist', p_customer_id
        using errcode = 'P0001', hint = 'customer_not_found';
    end if;
  end if;

  v_name := coalesce(nullif(btrim(p_customer_name), ''), v_customer.name);
  if v_name is null then
    raise exception 'An order needs a customer name'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  insert into public.sales_orders (
    idempotency_key, order_date, customer_id, customer_name, type, delivery_type, delivery_date,
    po_number, notes, is_paid, create_invoice, is_donation, square_status,
    delivery_address, customer_email, new_customer
  )
  values (
    p_idempotency_key,
    coalesce(p_order_date, (now() at time zone 'America/Los_Angeles')::date),
    p_customer_id,
    v_name,
    coalesce(p_type, v_customer.type, 'business'),
    p_delivery_type,
    p_delivery_date,
    nullif(btrim(p_po_number), ''),
    nullif(btrim(p_notes), ''),
    coalesce(p_is_paid, false),
    coalesce(p_create_invoice, false),
    coalesce(p_is_donation, false),
    case when coalesce(p_create_invoice, false) then 'pending' else 'skipped' end,
    nullif(btrim(p_delivery_address), ''),
    nullif(lower(btrim(p_customer_email)), ''),
    coalesce(p_new_customer, false)
  )
  on conflict (idempotency_key) do nothing
  returning id into v_order_id;

  if not found then
    -- An identical submission won the race; return that one.
    select o.id into v_order_id from public.sales_orders o where o.idempotency_key = p_idempotency_key;
    return private.orders_snapshot(v_order_id, false);
  end if;

  insert into public.sales_order_lines (order_id, product, cans, batch_id, unit_price)
  select
    v_order_id,
    line.value ->> 'product',
    (line.value ->> 'cans')::integer,
    (line.value ->> 'batch_id')::bigint,
    (line.value ->> 'unit_price')::numeric
  from jsonb_array_elements(p_lines) with ordinality as line (value, position)
  order by line.position;

  update public.sales_orders o
  set
    total_cans = totals.cans,
    total_price = coalesce(p_total_price, totals.price)
  from (
    select sum(l.cans)::integer as cans, sum(l.line_total) as price
    from public.sales_order_lines l
    where l.order_id = v_order_id
  ) totals
  where o.id = v_order_id;

  return private.orders_snapshot(v_order_id, true);
end
$$;

comment on function public.create_sales_order is
  'Create an order and its lines atomically. Same idempotency key again returns the existing order (created = false).';

revoke execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean)
  from public, anon;
grant execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean)
  to authenticated, service_role;

alter table public.sales_orders drop constraint sales_orders_delivery_fee_valid;
alter table public.sales_orders drop column delivery_fee;

alter table public.sales_orders drop constraint sales_orders_delivery_type_valid;
alter table public.sales_orders
  add constraint sales_orders_delivery_type_valid check (delivery_type in ('drop', 'ship', 'pickup'));

commit;
