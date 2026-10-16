-- Order functions: create an order, take its cans out of inventory, void it, and record
-- the outcome of each downstream step. Every function is safe to call again with the
-- same arguments, so the server can retry after any failure without double booking.
--
-- Called from the server with supabase.rpc(). Security definer because partners only
-- read these tables; every function checks the caller first.

-- The order, its lines and whether this call created it, as one JSON value.
create function private.orders_snapshot(p_order_id bigint, p_created boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'created', p_created,
    'order', to_jsonb(o),
    'lines', coalesce(
      (
        select jsonb_agg(to_jsonb(l) order by l.id)
        from public.sales_order_lines l
        where l.order_id = o.id
      ),
      '[]'::jsonb
    )
  )
  from public.sales_orders o
  where o.id = p_order_id
$$;

revoke execute on function private.orders_snapshot(bigint, boolean) from public;

-- Create an order and its lines in one transaction. If an order with this idempotency key
-- already exists, nothing is written and that order is returned with created = false.
--
-- p_lines is a JSON array of {product, cans, batch_id, unit_price}. p_total_price
-- defaults to the sum of the line totals; pass it to charge a manual price.
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
  p_po_number text default null
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
    po_number, notes, is_paid, create_invoice, is_donation, square_status
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
    case when coalesce(p_create_invoice, false) then 'pending' else 'skipped' end
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

-- Take an order's cans out of inventory: one movement per line and count = count - cans,
-- all in one transaction. A second call for the same order changes nothing.
-- Refuses to take a batch below zero unless p_allow_negative is true.
create function public.apply_order_inventory(p_order_id bigint, p_allow_negative boolean default false)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
  v_line record;
  v_batch public.inventory;
  v_lines integer := 0;
begin
  perform private.ledger_require_partner();

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;
  if v_order.voided_at is not null then
    raise exception 'Order % is void', p_order_id
      using errcode = 'P0001', hint = 'order_void';
  end if;
  if v_order.inventory_status in ('done', 'skipped') then
    return v_order;
  end if;

  -- Batches are locked in id order so two orders can't deadlock each other.
  for v_line in
    select l.id, l.batch_id, l.cans
    from public.sales_order_lines l
    where l.order_id = p_order_id
    order by l.batch_id, l.id
  loop
    v_lines := v_lines + 1;

    continue when exists (
      select 1 from public.inventory_movements m
      where m.order_line_id = v_line.id and m.reason = 'order'
    );

    select * into v_batch from public.inventory where id = v_line.batch_id for update;
    if v_batch.archived_at is not null then
      raise exception 'Inventory batch % (%) is archived', v_batch.id, v_batch.name
        using errcode = 'P0001', hint = 'batch_archived';
    end if;
    if not coalesce(p_allow_negative, false) and coalesce(v_batch.count, 0) < v_line.cans then
      raise exception 'Inventory batch % (%) has % cans; this order needs %',
        v_batch.id, v_batch.name, coalesce(v_batch.count, 0), v_line.cans
        using
          errcode = 'P0001',
          hint = 'insufficient_stock',
          detail = jsonb_build_object(
            'batch_id', v_batch.id,
            'available', coalesce(v_batch.count, 0),
            'needed', v_line.cans
          )::text;
    end if;

    insert into public.inventory_movements (batch_id, delta, reason, order_id, order_line_id)
    values (v_line.batch_id, -v_line.cans, 'order', p_order_id, v_line.id);

    perform set_config('portlandica.ledger_write', 'on', true);
    update public.inventory set count = coalesce(count, 0) - v_line.cans where id = v_line.batch_id;
    perform set_config('portlandica.ledger_write', 'off', true);
  end loop;

  update public.sales_orders
  set
    inventory_status = case when v_lines > 0 then 'done' else 'skipped' end,
    inventory_error = null
  where id = p_order_id
  returning * into v_order;

  return v_order;
end
$$;

comment on function public.apply_order_inventory is
  'Take an order''s cans out of inventory (ledger movements + counts) in one transaction. Safe to call twice.';

-- Void an order: put back every can it took out and mark it void. Voiding twice is
-- harmless. Trello, Square and the Sales sheet are not touched here.
create function public.void_order(p_order_id bigint, p_reason text)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
  v_movement record;
begin
  perform private.ledger_require_partner();

  if nullif(btrim(p_reason), '') is null then
    raise exception 'Say why the order is being voided'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;
  if v_order.voided_at is not null then
    return v_order;
  end if;

  for v_movement in
    select m.batch_id, m.delta, m.order_line_id
    from public.inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'order'
      and not exists (
        select 1 from public.inventory_movements v
        where v.order_line_id = m.order_line_id and v.reason = 'void'
      )
    order by m.batch_id, m.id
  loop
    perform 1 from public.inventory where id = v_movement.batch_id for update;

    insert into public.inventory_movements (batch_id, delta, reason, order_id, order_line_id, note)
    values (v_movement.batch_id, -v_movement.delta, 'void', p_order_id, v_movement.order_line_id, btrim(p_reason));

    perform set_config('portlandica.ledger_write', 'on', true);
    update public.inventory set count = coalesce(count, 0) - v_movement.delta where id = v_movement.batch_id;
    perform set_config('portlandica.ledger_write', 'off', true);
  end loop;

  update public.sales_orders
  set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_order_id
  returning * into v_order;

  return v_order;
end
$$;

comment on function public.void_order is
  'Void an order and return its cans to their batches. Does not touch Trello, Square or the Sales sheet.';

-- Record how a downstream step went: sheet, trello or square (pending, done, failed or
-- skipped), or inventory (failed only; apply_order_inventory sets done). A step that is
-- done stays done, and its Trello card or Square invoice id can't be swapped for another.
create function public.record_order_step(
  p_order_id bigint,
  p_step text,
  p_status text,
  p_external_id text default null,
  p_error text default null
)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
  v_current_status text;
  v_current_id text;
  v_external_id text := nullif(btrim(p_external_id), '');
  v_error text := case when p_status = 'failed' then coalesce(nullif(btrim(p_error), ''), 'Failed') end;
begin
  perform private.ledger_require_partner();

  if p_step is null or p_step not in ('sheet', 'inventory', 'trello', 'square') then
    raise exception 'Unknown order step %', coalesce(p_step, 'null')
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_status is null or p_status not in ('pending', 'done', 'failed', 'skipped') then
    raise exception 'Unknown step status %', coalesce(p_status, 'null')
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if p_step = 'inventory' and p_status <> 'failed' then
    raise exception 'Inventory is marked done by apply_order_inventory; only failures are recorded here'
      using errcode = 'P0001', hint = 'invalid_input';
  end if;
  if v_external_id is not null and p_step not in ('trello', 'square') then
    raise exception 'The % step has no external id', p_step
      using errcode = 'P0001', hint = 'invalid_input';
  end if;

  select * into v_order from public.sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order % does not exist', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;

  v_current_status := case p_step
    when 'sheet' then v_order.sheet_status
    when 'inventory' then v_order.inventory_status
    when 'trello' then v_order.trello_status
    else v_order.square_status
  end;
  v_current_id := case p_step
    when 'trello' then v_order.trello_card_id
    when 'square' then v_order.square_invoice_id
  end;

  if v_current_status = 'done' and p_status <> 'done' then
    raise exception 'The % step of order % is already done', p_step, p_order_id
      using errcode = 'P0001', hint = 'step_already_done';
  end if;
  if v_current_id is not null and v_external_id is not null and v_current_id <> v_external_id then
    raise exception 'Order % already has % id %', p_order_id, p_step, v_current_id
      using errcode = 'P0001', hint = 'external_id_conflict';
  end if;

  if p_step = 'sheet' then
    update public.sales_orders set sheet_status = p_status, sheet_error = v_error
    where id = p_order_id returning * into v_order;
  elsif p_step = 'inventory' then
    update public.sales_orders set inventory_status = p_status, inventory_error = v_error
    where id = p_order_id returning * into v_order;
  elsif p_step = 'trello' then
    update public.sales_orders
    set trello_status = p_status, trello_error = v_error,
        trello_card_id = coalesce(v_external_id, trello_card_id)
    where id = p_order_id returning * into v_order;
  else
    update public.sales_orders
    set square_status = p_status, square_error = v_error,
        square_invoice_id = coalesce(v_external_id, square_invoice_id)
    where id = p_order_id returning * into v_order;
  end if;

  return v_order;
end
$$;

comment on function public.record_order_step is
  'Record the outcome of a downstream order step (sheet, trello, square; or an inventory failure).';

revoke execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text)
  from public, anon;
revoke execute on function public.apply_order_inventory(bigint, boolean) from public, anon;
revoke execute on function public.void_order(bigint, text) from public, anon;
revoke execute on function public.record_order_step(bigint, text, text, text, text) from public, anon;

grant execute on function public.create_sales_order(text, text, jsonb, bigint, text, text, date, text, numeric, boolean, boolean, boolean, date, text)
  to authenticated, service_role;
grant execute on function public.apply_order_inventory(bigint, boolean) to authenticated, service_role;
grant execute on function public.void_order(bigint, text) to authenticated, service_role;
grant execute on function public.record_order_step(bigint, text, text, text, text) to authenticated, service_role;
