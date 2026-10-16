-- Batch functions: record a fill, adjust a count, archive and unarchive. Each one writes
-- the ledger movement and the count change in the same transaction.
--
-- Called from the server with supabase.rpc(). Security definer so they can write the
-- ledger (partners only read it); every function checks the caller first.

create function public.record_fill(
  p_count integer,
  p_is_still boolean,
  p_fill_date date,
  p_name text default null,
  p_customer_id bigint default null,
  p_product text default 'water',
  p_source text default null,
  p_total_cost numeric default null,
  p_invoice_number text default null,
  p_note text default null
)
returns public.inventory
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_name text;
  v_name text;
  v_batch public.inventory;
begin
  perform private.ledger_require_partner();

  if p_count is null or p_count <= 0 then
    raise exception 'A fill needs a positive number of cans'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_is_still is null then
    raise exception 'A fill must be still or sparkling'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  if p_customer_id is not null then
    select c.name into v_customer_name from public.customers c where c.id = p_customer_id;
    if not found then
      raise exception 'Customer % does not exist', p_customer_id
        using errcode = 'P0001', hint = 'customer_not_found';
    end if;
  end if;

  -- Custom batches default to the customer's exact name.
  v_name := coalesce(nullif(btrim(p_name), ''), v_customer_name);
  if v_name is null then
    raise exception 'A house-stock fill needs a batch name'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  perform set_config('portlandica.ledger_write', 'on', true);
  insert into public.inventory (
    name, count, "isCustom", "isStill", "fillDate", "totalCost", "invoiceNumber", source,
    customer_id, product
  )
  values (
    v_name, p_count, p_customer_id is not null, p_is_still, p_fill_date, p_total_cost,
    nullif(btrim(p_invoice_number), ''), nullif(btrim(p_source), ''), p_customer_id,
    coalesce(p_product, 'water')
  )
  returning * into v_batch;
  perform set_config('portlandica.ledger_write', 'off', true);

  insert into public.inventory_movements (batch_id, delta, reason, note)
  values (v_batch.id, p_count, 'fill', nullif(btrim(p_note), ''));

  return v_batch;
end
$$;

comment on function public.record_fill is
  'Add a new batch and its fill movement. Pass p_customer_id for a custom batch (name defaults to the customer''s).';

-- Set a batch to a counted number of cans. p_expected_count, when given, must match the
-- current count, so two people editing the same batch can't silently overwrite each other.
create function public.adjust_batch(
  p_batch_id bigint,
  p_new_count integer,
  p_note text,
  p_expected_count integer default null
)
returns public.inventory
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.inventory;
  v_delta integer;
begin
  perform private.ledger_require_partner();

  if nullif(btrim(p_note), '') is null then
    raise exception 'Say why the count is changing'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_new_count is null or p_new_count < 0 then
    raise exception 'A counted batch can''t have fewer than 0 cans'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select * into v_batch from public.inventory where id = p_batch_id for update;
  if not found then
    raise exception 'Inventory batch % does not exist', p_batch_id
      using errcode = 'P0001', hint = 'batch_not_found';
  end if;
  if v_batch.archived_at is not null then
    raise exception 'Inventory batch % (%) is archived; unarchive it first', p_batch_id, v_batch.name
      using errcode = 'P0001', hint = 'batch_archived';
  end if;
  if p_expected_count is not null and coalesce(v_batch.count, 0) <> p_expected_count then
    raise exception 'Inventory batch % changed to % cans while you were editing', p_batch_id, v_batch.count
      using errcode = 'P0001', hint = 'count_changed';
  end if;

  v_delta := p_new_count - coalesce(v_batch.count, 0)::integer;
  if v_delta = 0 then
    return v_batch;
  end if;

  insert into public.inventory_movements (batch_id, delta, reason, note)
  values (p_batch_id, v_delta, 'adjustment', btrim(p_note));

  perform set_config('portlandica.ledger_write', 'on', true);
  update public.inventory set count = p_new_count where id = p_batch_id returning * into v_batch;
  perform set_config('portlandica.ledger_write', 'off', true);

  return v_batch;
end
$$;

comment on function public.adjust_batch is
  'Set a batch to a counted number of cans, recording the difference as an adjustment with a note.';

-- Archive closes out a batch: whatever count is left is written off so the ledger still
-- balances, and the batch drops out of pickers. Calling it twice is harmless.
create function public.archive_batch(p_batch_id bigint, p_note text default null)
returns public.inventory
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.inventory;
  v_count integer;
begin
  perform private.ledger_require_partner();

  select * into v_batch from public.inventory where id = p_batch_id for update;
  if not found then
    raise exception 'Inventory batch % does not exist', p_batch_id
      using errcode = 'P0001', hint = 'batch_not_found';
  end if;
  if v_batch.archived_at is not null then
    return v_batch;
  end if;

  v_count := coalesce(v_batch.count, 0)::integer;
  if v_count <> 0 then
    insert into public.inventory_movements (batch_id, delta, reason, note)
    values (p_batch_id, -v_count, 'archive', coalesce(nullif(btrim(p_note), ''), 'Archived'));
  end if;

  perform set_config('portlandica.ledger_write', 'on', true);
  update public.inventory
  set count = 0, archived_at = now()
  where id = p_batch_id
  returning * into v_batch;
  perform set_config('portlandica.ledger_write', 'off', true);

  return v_batch;
end
$$;

comment on function public.archive_batch is
  'Archive a batch, writing off any remaining cans. Use instead of deleting.';

-- Undo an archive: puts back the cans the archive wrote off.
create function public.unarchive_batch(p_batch_id bigint, p_note text default null)
returns public.inventory
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.inventory;
  v_last_archive integer;
begin
  perform private.ledger_require_partner();

  select * into v_batch from public.inventory where id = p_batch_id for update;
  if not found then
    raise exception 'Inventory batch % does not exist', p_batch_id
      using errcode = 'P0001', hint = 'batch_not_found';
  end if;
  if v_batch.archived_at is null then
    return v_batch;
  end if;

  select m.delta into v_last_archive
  from public.inventory_movements m
  where m.batch_id = p_batch_id and m.reason = 'archive'
  order by m.id desc
  limit 1;

  if v_last_archive < 0 then
    insert into public.inventory_movements (batch_id, delta, reason, note)
    values (p_batch_id, -v_last_archive, 'archive', coalesce(nullif(btrim(p_note), ''), 'Unarchived'));
  else
    v_last_archive := 0;
  end if;

  perform set_config('portlandica.ledger_write', 'on', true);
  update public.inventory
  set count = coalesce(count, 0) - v_last_archive, archived_at = null
  where id = p_batch_id
  returning * into v_batch;
  perform set_config('portlandica.ledger_write', 'off', true);

  return v_batch;
end
$$;

comment on function public.unarchive_batch is 'Undo archive_batch, restoring the cans it wrote off.';

revoke execute on function public.record_fill(integer, boolean, date, text, bigint, text, text, numeric, text, text)
  from public, anon;
revoke execute on function public.adjust_batch(bigint, integer, text, integer) from public, anon;
revoke execute on function public.archive_batch(bigint, text) from public, anon;
revoke execute on function public.unarchive_batch(bigint, text) from public, anon;

grant execute on function public.record_fill(integer, boolean, date, text, bigint, text, text, numeric, text, text)
  to authenticated, service_role;
grant execute on function public.adjust_batch(bigint, integer, text, integer) to authenticated, service_role;
grant execute on function public.archive_batch(bigint, text) to authenticated, service_role;
grant execute on function public.unarchive_batch(bigint, text) to authenticated, service_role;
