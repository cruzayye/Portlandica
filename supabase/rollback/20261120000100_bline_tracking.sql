-- Undo 20261120000100_bline_tracking.sql: drop the tracking functions, put bline_stock back
-- as 20261109000100 made it (a BLine order's cans leave BLine's shelf on its delivery date),
-- and drop the delivered_at and bline_* columns. What was recorded from findelivers and the
-- deliveries marked by hand are lost; nothing else changes.
--
-- Run it in the SQL Editor as one script. If the migration went in with `supabase db push`,
-- afterwards also run:
--   npx supabase migration repair --status reverted 20261120000100

begin;

drop function public.clear_bline_tracking(bigint);
drop function public.mark_bline_delivered(bigint);
drop function public.record_bline_tracking(bigint, text, text, timestamptz, text);

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

drop index public.sales_orders_bline_ref_key;

alter table public.sales_orders
  drop constraint sales_orders_bline_tracking_valid,
  drop constraint sales_orders_bline_ref_valid,
  drop constraint sales_orders_bline_status_valid,
  drop constraint sales_orders_bline_seen_has_ref,
  drop column delivered_at,
  drop column bline_ref,
  drop column bline_status,
  drop column bline_problem,
  drop column bline_checked_at;

commit;
