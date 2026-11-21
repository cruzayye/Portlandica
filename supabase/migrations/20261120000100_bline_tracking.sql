-- BLine delivery tracking: what findelivers.com (BLine's delivery software) says about each
-- BLine order, read from the Orders CSV our login there can download, and deliveries marked
-- by hand.
--
-- Additive:
--   * sales_orders.delivered_at: when the order was delivered, from findelivers or marked by
--     hand (then it's when someone marked it).
--   * sales_orders.bline_ref, bline_status, bline_problem, bline_checked_at: the order's
--     number in findelivers (BLine's "Shipper order ID", e.g. 261101.0007), its status there,
--     why its last attempt failed, and when an import last checked it. BLine orders only.
--   * record_bline_tracking, mark_bline_delivered and clear_bline_tracking, the only ways to
--     write them.
--   * bline_stock counts a BLine order's cans as still on BLine's shelf until it is
--     delivered. Once findelivers says delivered, or someone marks it, they are off the shelf
--     whatever its delivery date; while findelivers has it but hasn't delivered it, they are
--     on the shelf. An order nobody has tracked yet goes by its delivery date, as before.
-- Undo with supabase/rollback/20261120000100_bline_tracking.sql.

alter table public.sales_orders
  add column delivered_at timestamptz,
  add column bline_ref text,
  add column bline_status text,
  add column bline_problem text,
  add column bline_checked_at timestamptz;

alter table public.sales_orders
  add constraint sales_orders_bline_tracking_valid check (
    delivery_type = 'bline'
    or (
      delivered_at is null and bline_ref is null and bline_status is null
      and bline_problem is null and bline_checked_at is null
    )
  ),
  add constraint sales_orders_bline_ref_valid check (bline_ref ~ '^\S+$' and length(bline_ref) <= 64),
  add constraint sales_orders_bline_status_valid
    check (bline_status ~ '^[a-z][a-z0-9_]*$' and length(bline_status) <= 40),
  add constraint sales_orders_bline_seen_has_ref check ((bline_ref is null) = (bline_status is null));

-- One findelivers order per order, never shared.
create unique index sales_orders_bline_ref_key on public.sales_orders (bline_ref)
  where bline_ref is not null;

comment on column public.sales_orders.delivered_at is
  'When the order was delivered: findelivers'' delivery time, or when someone marked it delivered by hand. BLine orders only, for now.';
comment on column public.sales_orders.bline_ref is
  'The order''s number in findelivers (BLine''s "Shipper order ID", e.g. 261101.0007), once an import has matched it.';
comment on column public.sales_orders.bline_status is
  'Its status in findelivers at the last import, lower case (created, in_transit, delivered, failed_attempt, ...).';
comment on column public.sales_orders.bline_problem is
  'Why its last delivery attempt failed, from findelivers. Cleared once it is delivered.';
comment on column public.sales_orders.bline_checked_at is 'When a findelivers import last checked it.';

-- What a findelivers import found for one order: its number there, its status, when it was
-- delivered (status delivered only) and why the last attempt failed. A delivery stays
-- recorded when an older file says otherwise.
create function public.record_bline_tracking(
  p_order_id bigint,
  p_ref text,
  p_status text,
  p_delivered_at timestamptz default null,
  p_problem text default null
)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
  v_ref text := btrim(p_ref);
  v_status text := lower(btrim(p_status));
  v_problem text := nullif(btrim(p_problem), '');
  v_other bigint;
begin
  perform private.ledger_require_partner();

  if v_ref is null or v_ref !~ '^\S+$' or length(v_ref) > 64 then
    raise exception 'A findelivers order needs its number'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if v_status is null or v_status !~ '^[a-z][a-z0-9_]*$' or length(v_status) > 40 then
    raise exception 'Unknown findelivers status %', coalesce(p_status, 'null')
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_delivered_at is not null and v_status <> 'delivered' then
    raise exception 'Only a delivered order has a delivery time'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  -- A day's slack for clocks; findelivers can't have delivered it tomorrow.
  if p_delivered_at > now() + interval '1 day' then
    raise exception 'The delivery time can''t be in the future'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;
  if v_order.delivery_type <> 'bline' then
    raise exception 'Order % isn''t a BLine order', p_order_id
      using errcode = 'P0001', hint = 'not_bline';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Order % is void', p_order_id
      using errcode = 'P0001', hint = 'order_void';
  end if;

  select o.id into v_other from public.sales_orders o where o.bline_ref = v_ref and o.id <> p_order_id;
  if found then
    raise exception 'findelivers order % is already matched to order %', v_ref, v_other
      using errcode = 'P0001', hint = 'bline_ref_conflict';
  end if;

  -- On the right of each =, the columns are as they were before this update. A file from
  -- before the delivery says it isn't delivered yet; that doesn't take the delivery back.
  update public.sales_orders
  set
    bline_ref = v_ref,
    bline_status = case
      when bline_status = 'delivered' and v_status <> 'delivered' then 'delivered'
      else v_status
    end,
    delivered_at = case
      when v_status = 'delivered' then coalesce(p_delivered_at, delivered_at, now())
      else delivered_at
    end,
    bline_problem = case
      when v_status = 'delivered' or bline_status = 'delivered' then null
      else v_problem
    end,
    bline_checked_at = now()
  where id = p_order_id
  returning * into v_order;

  return v_order;
end
$$;

comment on function public.record_bline_tracking is
  'Record what findelivers says about a BLine order: its number there, status, delivery time and failed-attempt reason.';

-- Someone saw it delivered: delivered_at is now. Marking it again changes nothing.
create function public.mark_bline_delivered(p_order_id bigint)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
begin
  perform private.ledger_require_partner();

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;
  if v_order.delivery_type <> 'bline' then
    raise exception 'Order % isn''t a BLine order', p_order_id
      using errcode = 'P0001', hint = 'not_bline';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Order % is void', p_order_id
      using errcode = 'P0001', hint = 'order_void';
  end if;
  if v_order.delivered_at is not null then
    return v_order;
  end if;

  update public.sales_orders set delivered_at = now()
  where id = p_order_id
  returning * into v_order;

  return v_order;
end
$$;

comment on function public.mark_bline_delivered is 'Mark a BLine order delivered by hand, as of now.';

-- Forget what was recorded about a BLine order's delivery: a wrong match, or a delivery
-- marked by mistake. The next import matches it again.
create function public.clear_bline_tracking(p_order_id bigint)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
begin
  perform private.ledger_require_partner();

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;
  if v_order.delivery_type <> 'bline' then
    raise exception 'Order % isn''t a BLine order', p_order_id
      using errcode = 'P0001', hint = 'not_bline';
  end if;

  update public.sales_orders
  set delivered_at = null, bline_ref = null, bline_status = null, bline_problem = null,
      bline_checked_at = null
  where id = p_order_id
  returning * into v_order;

  return v_order;
end
$$;

comment on function public.clear_bline_tracking is
  'Clear a BLine order''s delivery and findelivers match, so it counts as not delivered.';

-- As 20261109000100 made it, except for what counts as still on the shelf (pending): cans on
-- live BLine orders that aren't delivered yet. An order is delivered once delivered_at is
-- set; one findelivers has but hasn't delivered is not; one nobody has tracked counts as
-- delivered from its delivery date (a delivery dated today counts as made).
create or replace view public.bline_stock
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
        where o.delivered_at is null
          and (
            o.bline_status is not null
            or coalesce(o.delivery_date, o.order_date) > (now() at time zone 'America/Los_Angeles')::date
          )
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
  'Per batch: moved (sent, less returned, plus count corrections), booked (cans on live BLine orders), pending (booked but not delivered yet: by findelivers or a hand mark, else by delivery date), remaining = moved - booked, on_hand = remaining + pending (what BLine should have today).';

revoke execute on function public.record_bline_tracking(bigint, text, text, timestamptz, text) from public, anon;
revoke execute on function public.mark_bline_delivered(bigint) from public, anon;
revoke execute on function public.clear_bline_tracking(bigint) from public, anon;

grant execute on function public.record_bline_tracking(bigint, text, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.mark_bline_delivered(bigint) to authenticated, service_role;
grant execute on function public.clear_bline_tracking(bigint) to authenticated, service_role;
