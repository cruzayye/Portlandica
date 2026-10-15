-- Inventory ledger: every change to a batch's count, with the reason and who made it.
--
-- The ledger and inventory.count always agree: for each batch, the sum of its movements
-- equals its count. The functions in the next migrations write a movement and the count
-- change together. Any other count change (the current Inventory tab, the dashboard, a
-- script) is caught by a trigger and recorded as an adjustment, so nothing goes unlogged.

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  batch_id bigint not null references public.inventory (id) on delete restrict,
  delta integer not null,
  reason text not null,
  order_id bigint references public.sales_orders (id) on delete restrict,
  order_line_id bigint references public.sales_order_lines (id) on delete restrict,
  note text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint inventory_movements_delta_nonzero check (delta <> 0),
  constraint inventory_movements_reason_valid
    check (reason in ('opening', 'fill', 'order', 'void', 'adjustment', 'archive')),
  -- Order and void movements belong to an order line; nothing else does.
  constraint inventory_movements_order_link check (
    (order_id is null) = (order_line_id is null)
    and (order_line_id is not null) = (reason in ('order', 'void'))
  ),
  constraint inventory_movements_direction check (
    (reason <> 'order' or delta < 0)
    and (reason <> 'void' or delta > 0)
    and (reason <> 'fill' or delta > 0)
  )
);

-- An order line is taken out of stock at most once and put back at most once.
create unique index inventory_movements_once_per_line
  on public.inventory_movements (order_line_id, reason)
  where order_line_id is not null;
create index inventory_movements_batch_id_idx on public.inventory_movements (batch_id, created_at);
create index inventory_movements_order_id_idx on public.inventory_movements (order_id)
  where order_id is not null;

comment on table public.inventory_movements is
  'Append-only ledger of inventory changes in cans. For every batch, sum(delta) = inventory.count.';
comment on column public.inventory_movements.reason is
  'opening (count when the ledger started), fill, order, void, adjustment or archive.';

-- Opening balance: the count each batch has right now.
insert into public.inventory_movements (batch_id, delta, reason, note)
select i.id, i.count::integer, 'opening', 'Count on hand when the ledger started'
from public.inventory i
where coalesce(i.count, 0) <> 0
order by i.id;

-- Record any count change that did not come through the ledger functions. Those
-- functions set portlandica.ledger_write for the duration of their own update.
create function private.ledger_record_direct_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta integer;
begin
  if current_setting('portlandica.ledger_write', true) = 'on' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_delta := coalesce(new.count, 0)::integer;
    if v_delta <> 0 then
      insert into public.inventory_movements (batch_id, delta, reason, note)
      values (
        new.id,
        v_delta,
        case when v_delta > 0 then 'fill' else 'adjustment' end,
        'Batch added directly, not through record_fill'
      );
    end if;
  else
    v_delta := (coalesce(new.count, 0) - coalesce(old.count, 0))::integer;
    if v_delta <> 0 then
      insert into public.inventory_movements (batch_id, delta, reason, note)
      values (new.id, v_delta, 'adjustment', 'Count edited directly, not through adjust_batch');
    end if;
  end if;

  return null;
end
$$;

revoke execute on function private.ledger_record_direct_change() from public;

create trigger inventory_ledger_direct_change
  after insert or update of count on public.inventory
  for each row execute function private.ledger_record_direct_change();

-- Batches with history are archived, never deleted.
create function private.ledger_block_batch_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.inventory_movements m where m.batch_id = old.id) then
    raise exception 'Inventory batch % has history and cannot be deleted; archive it instead', old.id
      using errcode = 'P0001', hint = 'batch_has_history';
  end if;
  return old;
end
$$;

revoke execute on function private.ledger_block_batch_delete() from public;

create trigger inventory_block_delete_with_history
  before delete on public.inventory
  for each row execute function private.ledger_block_batch_delete();

-- Reconciliation: difference should be 0 for every batch.
create view public.inventory_ledger_check
with (security_invoker = true)
as
select
  i.id as batch_id,
  i.name,
  coalesce(i.count, 0)::integer as count,
  coalesce(sum(m.delta), 0)::integer as ledger_total,
  (coalesce(i.count, 0) - coalesce(sum(m.delta), 0))::integer as difference
from public.inventory i
left join public.inventory_movements m on m.batch_id = i.id
group by i.id, i.name, i.count;

comment on view public.inventory_ledger_check is
  'Per batch: count vs. the sum of its ledger movements. Any row with difference <> 0 needs a look.';

-- Shared guard for the ledger and order functions. API callers must be partners (or use
-- the service role); direct database sessions such as the SQL editor carry no JWT claims
-- and are trusted.
create function private.ledger_require_partner()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if v_claims is null or v_claims ->> 'role' = 'service_role' then
    return;
  end if;
  if coalesce(public.is_partner(), false) then
    return;
  end if;
  raise exception 'Only Portlandica partners can change orders or inventory'
    using errcode = '42501', hint = 'not_partner';
end
$$;

revoke execute on function private.ledger_require_partner() from public;

alter table public.inventory_movements enable row level security;

create policy "Partners read inventory movements"
  on public.inventory_movements
  for select
  to authenticated
  using ((select public.is_partner()));

revoke all on table public.inventory_movements from anon, authenticated;
grant select on table public.inventory_movements to authenticated;

revoke all on table public.inventory_ledger_check from anon, authenticated;
grant select on table public.inventory_ledger_check to authenticated;
