-- Undo the data-foundation migrations (20261017000100 to 20261017000600).
--
-- Only for use right after applying them, before real customers or orders are entered:
-- it deletes the new tables and everything in them. Inventory rows and counts stay as
-- they are; only the two added columns go. Run it in the SQL Editor as one script.
-- If the migrations went in with `supabase db push`, afterwards also run:
--   npx supabase migration repair --status reverted 20261017000100 20261017000200 \
--     20261017000300 20261017000400 20261017000500 20261017000600

begin;

drop function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text);
drop function public.apply_order_inventory(bigint, boolean);
drop function public.void_order(bigint, text);
drop function public.record_order_step(bigint, text, text, text, text);
drop function private.orders_snapshot(bigint, boolean);

drop function public.record_fill(integer, boolean, date, text, bigint, text, numeric, text, text);
drop function public.adjust_batch(bigint, integer, text, integer);
drop function public.archive_batch(bigint, text);
drop function public.unarchive_batch(bigint, text);

drop view public.inventory_ledger_check;
drop trigger inventory_ledger_direct_change on public.inventory;
drop trigger inventory_block_delete_with_history on public.inventory;
drop table public.inventory_movements;
drop function private.ledger_record_direct_change();
drop function private.ledger_block_batch_delete();
drop function private.ledger_require_partner();

drop table public.sales_order_lines;
drop table public.sales_orders;
drop function private.orders_line_from_batch();

drop trigger inventory_trim_name on public.inventory;
drop function private.inventory_trim_name();
alter table public.inventory
  drop column customer_id,
  drop column archived_at;

drop table public.customers;
drop function private.touch_updated_at();

commit;
