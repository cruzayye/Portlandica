-- BLine: a delivery company that keeps a few pallets of our cans and delivers some local
-- orders from them. We still invoice the customer; BLine bills us for each delivery: a flat
-- $10 when the order is under $100, otherwise 10% of it.
--
-- Additive:
--   * 'bline' as a delivery type, and sales_orders.delivery_fee: what BLine charges for the
--     order, worked out by the app when the order is placed and kept as it was then.
--   * create_sales_order with one more optional argument, p_delivery_fee.
--   * bline_stock_moves: cans sent to BLine, brought back, or corrected after BLine counts.
--   * bline_stock: per batch, the cans BLine has left once every booked delivery is made
--     (what was sent, less the cans on live BLine orders), and what it should have on its
--     shelf today (cans for deliveries after today are still there).
--   * record_bline_move and set_bline_count, the only ways to write bline_stock_moves.
--
-- Batch counts don't change when cans go to BLine: a batch counts its cans wherever they
-- are, and a BLine order takes its cans out of its batch like any other order. So nothing
-- that reads inventory sees a difference.
-- Undo with supabase/rollback/20261109000100_bline_delivery.sql.

alter table public.sales_orders drop constraint sales_orders_delivery_type_valid;
alter table public.sales_orders
  add constraint sales_orders_delivery_type_valid
    check (delivery_type in ('drop', 'ship', 'pickup', 'bline'));

alter table public.sales_orders add column delivery_fee numeric(10, 2);

alter table public.sales_orders
  add constraint sales_orders_delivery_fee_valid
    check ((delivery_fee is not null) = (delivery_type = 'bline') and coalesce(delivery_fee, 0) >= 0);

comment on column public.sales_orders.delivery_fee is
  'What BLine charges to deliver this order, in dollars, as worked out when it was placed ($10 under $100, otherwise 10%). Set on BLine orders only.';

-- Same as before, plus p_delivery_fee.
drop function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean);

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
  p_new_customer boolean default false,
  p_delivery_fee numeric default null
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

  if (p_delivery_type = 'bline') <> (p_delivery_fee is not null) or p_delivery_fee < 0 then
    raise exception 'A BLine order needs its delivery fee, and only a BLine order has one'
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
    delivery_address, customer_email, new_customer, delivery_fee
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
    coalesce(p_new_customer, false),
    p_delivery_fee
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

revoke execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean, numeric)
  from public, anon;
grant execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text, text, text, boolean, numeric)
  to authenticated, service_role;

-- What BLine holds, as changes in cans per batch. Deliveries aren't recorded here: they are
-- the BLine orders themselves, so voiding one puts its cans back at BLine on its own.
create table public.bline_stock_moves (
  id bigint generated always as identity primary key,
  batch_id bigint not null references public.inventory (id) on delete restrict,
  cans integer not null,
  reason text not null,
  moved_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint bline_stock_moves_cans_nonzero check (cans <> 0),
  constraint bline_stock_moves_reason_valid check (reason in ('sent', 'returned', 'count')),
  constraint bline_stock_moves_direction check (
    (reason <> 'sent' or cans > 0) and (reason <> 'returned' or cans < 0)
  )
);

create index bline_stock_moves_batch_id_idx on public.bline_stock_moves (batch_id, id);

comment on table public.bline_stock_moves is
  'Cans moved to or from BLine, per batch: sent (+), returned (-), or count (BLine counted a different number). BLine orders take their cans off without a row here.';
comment on column public.bline_stock_moves.moved_on is 'When the cans went over or came back, or the day BLine counted. Never after today.';

-- Per batch: cans moved to BLine, cans on live BLine orders (and how many of those are for
-- deliveries after today), what BLine has left once every booked delivery is made, and what
-- it should have on its shelf today. A delivery dated today counts as made.
create view public.bline_stock
with (security_invoker = true)
as
with moved as (
  select m.batch_id, sum(m.cans)::integer as cans
  from public.bline_stock_moves m
  group by m.batch_id
),
booked as (
  select
    l.batch_id,
    sum(l.cans)::integer as cans,
    coalesce(
      sum(l.cans) filter (
        where coalesce(o.delivery_date, o.order_date) > (now() at time zone 'America/Los_Angeles')::date
      ),
      0
    )::integer as pending
  from public.sales_order_lines l
  join public.sales_orders o on o.id = l.order_id
  where o.delivery_type = 'bline' and o.voided_at is null
  group by l.batch_id
)
select
  i.id as batch_id,
  i.name,
  i."isStill" as is_still,
  coalesce(mv.cans, 0) as moved,
  coalesce(b.cans, 0) as booked,
  coalesce(b.pending, 0) as pending,
  coalesce(mv.cans, 0) - coalesce(b.cans, 0) as remaining,
  coalesce(mv.cans, 0) - coalesce(b.cans, 0) + coalesce(b.pending, 0) as on_hand
from public.inventory i
left join moved mv on mv.batch_id = i.id
left join booked b on b.batch_id = i.id
where mv.batch_id is not null or b.batch_id is not null;

comment on view public.bline_stock is
  'Per batch: moved (sent, less returned, plus count corrections), booked (cans on live BLine orders), pending (booked for deliveries after today), remaining = moved - booked, on_hand = remaining + pending (what BLine should have today).';

-- Cans sent to BLine or brought back from it. p_cans is how many, always more than 0.
create function public.record_bline_move(
  p_batch_id bigint,
  p_cans integer,
  p_reason text,
  p_moved_on date default null,
  p_note text default null
)
returns public.bline_stock_moves
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_batch public.inventory;
  v_move public.bline_stock_moves;
begin
  perform private.ledger_require_partner();

  if p_reason is null or p_reason not in ('sent', 'returned') then
    raise exception 'Say whether the cans went to BLine or came back'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_cans is null or p_cans <= 0 then
    raise exception 'Enter how many cans, more than 0'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_moved_on > v_today then
    raise exception 'The date can''t be after today'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select * into v_batch from public.inventory where id = p_batch_id;
  if not found then
    raise exception 'Inventory batch % does not exist', p_batch_id
      using errcode = 'P0001', hint = 'batch_not_found';
  end if;
  if p_reason = 'sent' and v_batch.archived_at is not null then
    raise exception 'Inventory batch % (%) is archived; unarchive it first', p_batch_id, v_batch.name
      using errcode = 'P0001', hint = 'batch_archived';
  end if;

  insert into public.bline_stock_moves (batch_id, cans, reason, moved_on, note)
  values (
    p_batch_id,
    case when p_reason = 'sent' then p_cans else -p_cans end,
    p_reason,
    coalesce(p_moved_on, v_today),
    nullif(btrim(p_note), '')
  )
  returning * into v_move;

  return v_move;
end
$$;

comment on function public.record_bline_move is
  'Record cans sent to BLine (reason sent) or brought back (reason returned) from one batch.';

-- BLine counted their cans of a batch today. Records the difference from what they should
-- have on their shelf today (on_hand: cans for deliveries after today are still there) as a
-- count correction. p_expected_count, when given, must match that number, so an order booked
-- meanwhile isn't written off by mistake. Returns the correction, or no row when the count
-- already matches.
create function public.set_bline_count(
  p_batch_id bigint,
  p_counted integer,
  p_note text,
  p_expected_count integer default null
)
returns setof public.bline_stock_moves
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_on_hand integer;
  v_move public.bline_stock_moves;
begin
  perform private.ledger_require_partner();

  if nullif(btrim(p_note), '') is null then
    raise exception 'Say where the count came from'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'A count can''t be less than 0 cans'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  -- One count at a time per batch, so two can't both be measured against the same number.
  perform 1 from public.inventory where id = p_batch_id for update;
  if not found then
    raise exception 'Inventory batch % does not exist', p_batch_id
      using errcode = 'P0001', hint = 'batch_not_found';
  end if;

  select coalesce((select s.on_hand from public.bline_stock s where s.batch_id = p_batch_id), 0)
  into v_on_hand;

  if p_expected_count is not null and v_on_hand <> p_expected_count then
    raise exception 'BLine''s cans of batch % changed to % while you were editing', p_batch_id, v_on_hand
      using errcode = 'P0001', hint = 'count_changed';
  end if;
  if p_counted = v_on_hand then
    return;
  end if;

  insert into public.bline_stock_moves (batch_id, cans, reason, note)
  values (p_batch_id, p_counted - v_on_hand, 'count', btrim(p_note))
  returning * into v_move;

  return next v_move;
end
$$;

comment on function public.set_bline_count is
  'Set what BLine has of a batch on its shelf today to the number they counted, recording the difference as a count correction.';

alter table public.bline_stock_moves enable row level security;

create policy "Partners read BLine stock moves"
  on public.bline_stock_moves
  for select
  to authenticated
  using ((select public.is_partner()));

revoke all on table public.bline_stock_moves from anon, authenticated;
grant select on table public.bline_stock_moves to authenticated;

revoke all on table public.bline_stock from anon, authenticated;
grant select on table public.bline_stock to authenticated;

revoke execute on function public.record_bline_move(bigint, integer, text, date, text) from public, anon;
revoke execute on function public.set_bline_count(bigint, integer, text, integer) from public, anon;

grant execute on function public.record_bline_move(bigint, integer, text, date, text) to authenticated, service_role;
grant execute on function public.set_bline_count(bigint, integer, text, integer) to authenticated, service_role;
