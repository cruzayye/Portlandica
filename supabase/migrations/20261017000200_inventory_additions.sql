-- Inventory additions: link custom batches to customers, and archive instead of delete.
-- A batch is still or sparkling, from "isStill"; there is no other product. "Portlandica
-- Dog water" is a batch name: house still stock like any other.
--
-- Additive only. Existing columns keep their names because other tools (the monthly
-- close script) read them.

alter table public.inventory
  add column customer_id bigint references public.customers (id) on delete restrict,
  add column archived_at timestamptz;

alter table public.inventory
  add constraint inventory_customer_batches_are_custom
    check (customer_id is null or coalesce("isCustom", false));

create index inventory_customer_id_idx on public.inventory (customer_id)
  where customer_id is not null;

comment on column public.inventory.customer_id is
  'Customer a custom batch was filled for. NULL for house stock.';
comment on column public.inventory.archived_at is
  'When the batch was archived (use public.archive_batch). Archived batches are hidden, not deleted.';

-- Keep batch names trimmed. A trailing space ("Hotel Vintage ") is why one customer's
-- custom cans never matched their batch.
create function private.inventory_trim_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := regexp_replace(new.name, '^\s+|\s+$', '', 'g');
  return new;
end
$$;

revoke execute on function private.inventory_trim_name() from public;

create trigger inventory_trim_name
  before insert or update of name on public.inventory
  for each row execute function private.inventory_trim_name();
