// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ANON,
  JOHNNY,
  PAUL,
  SERVICE,
  STRANGER,
  asRole,
  createMigratedDb,
  migrationFiles,
  type TestAuth,
} from './testing/testDb'

// Runs the real migrations in PGlite and exercises the SQL directly, as the roles the app
// uses. Module-level behaviour is covered in customers/inventory/orders tests.

let base: PGlite
let pg: PGlite

beforeAll(async () => {
  base = await createMigratedDb()
}, 60_000)

afterAll(async () => {
  await base.close()
})

beforeEach(async () => {
  pg = (await base.clone()) as PGlite
})

afterEach(async () => {
  await pg.close()
})

const query = async <T = Record<string, unknown>>(
  auth: TestAuth,
  sql: string,
  params: unknown[] = []
) => asRole(pg, auth, async (tx) => (await tx.query<T>(sql, params)).rows)

const one = async <T = Record<string, unknown>>(
  auth: TestAuth,
  sql: string,
  params: unknown[] = []
) => (await query<T>(auth, sql, params))[0]

const count = async (sql: string, params: unknown[] = []) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params)).rows[0].n

const ledgerMismatches = () =>
  count('select * from public.inventory_ledger_check where difference <> 0')

const batchCount = async (id: number) =>
  Number(
    (await pg.query<{ count: string }>('select count from public.inventory where id = $1', [id]))
      .rows[0].count
  )

type Snapshot = {
  created: boolean
  order: { id: number; total_cans: number; total_price: number } & Record<string, unknown>
  lines: ({ id: number; is_custom: boolean; line_total: number } & Record<string, unknown>)[]
}

const createOrder = async (
  auth: TestAuth,
  key: string,
  lines: { product: string; cans: number; batch_id: number; unit_price: number }[],
  extra: Record<string, unknown> = {}
) => {
  const args = {
    p_idempotency_key: key,
    p_delivery_type: 'drop',
    p_lines: JSON.stringify(lines),
    p_customer_name: 'Que Dice',
    ...extra,
  }
  const names = Object.keys(args)
  const call = `select public.create_sales_order(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as s`
  return (await one<{ s: Snapshot }>(auth, call, Object.values(args))).s
}

describe('migrations on the live schema', () => {
  it('needs the login migration first', async () => {
    const bare = new PGlite()
    await bare.exec(
      readFileSync(path.join(process.cwd(), 'src/lib/db/testing/sql/supabase-stub.sql'), 'utf8')
    )
    await bare.exec('drop function public.is_partner()')
    const first = readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations',
        migrationFiles().find((file) => file.endsWith('_customers.sql')) ?? ''
      ),
      'utf8'
    )
    await expect(bare.exec(first)).rejects.toThrow(/is_partner\(\) is missing/)
    await bare.close()
  })

  it('records an opening balance for every batch so the ledger balances', async () => {
    const rows = await pg.query<{ batch_id: number; delta: number }>(
      `select batch_id, delta from public.inventory_movements where reason = 'opening' order by batch_id`
    )
    expect(rows.rows).toEqual([
      { batch_id: 13, delta: 1200 },
      { batch_id: 22, delta: 2640 },
      { batch_id: 25, delta: 4760 },
      { batch_id: 33, delta: 2376 },
      { batch_id: 36, delta: 2760 },
      { batch_id: 45, delta: 12000 },
    ])
    expect(await ledgerMismatches()).toBe(0)
  })

  it('marks the dog water batch and leaves house stock as water', async () => {
    const rows = await pg.query<{ id: number; product: string }>(
      'select id, product from public.inventory order by id'
    )
    expect(rows.rows.filter((r) => r.product === 'dog_water').map((r) => r.id)).toEqual([33])
  })

  it('keeps the existing inventory columns readable with the public key', async () => {
    const row = await one(
      ANON,
      `select id, created_at, name, count, "isCustom", "isStill", "fillDate", "totalCost",
              "invoiceNumber", source, "initialCount", customer_id, archived_at, product
       from public.inventory where id = 45`
    )
    expect(row).toMatchObject({ name: 'Portlandica', isStill: true, product: 'water' })
  })

  it('can be rolled back to the schema it started from', async () => {
    const fingerprint = async (db: PGlite) =>
      (
        await db.query<{ x: string }>(`
          select 'column ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type as x
          from information_schema.columns where table_schema in ('public', 'private')
          union all
          select 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
          union all
          select 'trigger ' || tgrelid::regclass || '.' || tgname from pg_trigger where not tgisinternal
          union all
          select 'policy ' || schemaname || '.' || tablename || '.' || policyname from pg_policies
          order by 1`)
      ).rows.map((r) => r.x)

    const before = new PGlite()
    const sqlDir = path.join(process.cwd(), 'src/lib/db/testing/sql')
    await before.exec(readFileSync(path.join(sqlDir, 'supabase-stub.sql'), 'utf8'))
    await before.exec(readFileSync(path.join(sqlDir, 'live-baseline.sql'), 'utf8'))

    const { order } = await createOrder(PAUL, 'rollback', [
      { product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 },
    ])
    await query(PAUL, 'select public.apply_order_inventory($1)', [order.id])
    await query(PAUL, `select public.archive_batch(46)`)

    await pg.exec(
      readFileSync(
        path.join(process.cwd(), 'supabase/rollback/20261017_data_foundation.sql'),
        'utf8'
      )
    )
    expect(await fingerprint(pg)).toEqual(await fingerprint(before))
    expect(await batchCount(45)).toBe(12000 - 24)
    await before.close()
  })

  it('leaves the legacy orders table alone', async () => {
    await expect(
      pg.query('select "isSpark", "totalStill" from public.orders')
    ).resolves.toBeTruthy()
  })
})

describe('inventory triggers', () => {
  it('logs a direct count edit as an adjustment', async () => {
    await query(PAUL, 'update public.inventory set count = count - 24 where id = 45')
    const movement = await one(
      SERVICE,
      `select delta, reason, note, created_by from public.inventory_movements
       where batch_id = 45 order by id desc limit 1`
    )
    expect(movement).toMatchObject({ delta: -24, reason: 'adjustment', created_by: PAUL.sub })
    expect(await ledgerMismatches()).toBe(0)
  })

  it('logs a batch inserted directly as a fill', async () => {
    const batch = await one<{ id: number; initialCount: number }>(
      PAUL,
      `insert into public.inventory (name, count, "isCustom", "isStill") values ('Direct', 240, false, true)
       returning id, "initialCount"`
    )
    expect(batch.initialCount).toBe(240)
    expect(
      await count(
        `select 1 from public.inventory_movements where batch_id = $1 and reason = 'fill' and delta = 240`,
        [batch.id]
      )
    ).toBe(1)
    expect(await ledgerMismatches()).toBe(0)
  })

  it('trims batch names', async () => {
    await query(PAUL, `update public.inventory set name = '  Que Dice  ' where id = 13`)
    expect(
      (await pg.query<{ name: string }>('select name from public.inventory where id = 13')).rows[0]
        .name
    ).toBe('Que Dice')
  })

  it('refuses to delete a batch with history, even for the service role', async () => {
    await expect(
      query(SERVICE, 'delete from public.inventory where id = 45')
    ).rejects.toMatchObject({
      hint: 'batch_has_history',
    })
    await expect(query(PAUL, 'delete from public.inventory where id = 13')).rejects.toMatchObject({
      hint: 'batch_has_history',
    })
  })

  it('still lets an empty batch with no history be deleted', async () => {
    await query(PAUL, 'delete from public.inventory where id = 46')
    expect(await count('select 1 from public.inventory where id = 46')).toBe(0)
  })
})

describe('access', () => {
  beforeEach(async () => {
    await pg.query(`insert into public.customers (name) values ('Que Dice')`)
    await createOrder(PAUL, 'access-order', [
      { product: 'still', cans: 24, batch_id: 13, unit_price: 2 },
    ])
  })

  it('hides customers, orders and the ledger from anon', async () => {
    for (const table of [
      'customers',
      'sales_orders',
      'sales_order_lines',
      'inventory_movements',
      'inventory_ledger_check',
    ]) {
      await expect(query(ANON, `select * from public.${table}`)).rejects.toMatchObject({
        code: '42501',
      })
    }
  })

  it('shows signed-in non-partners nothing and refuses their writes', async () => {
    expect(await query(STRANGER, 'select * from public.customers')).toEqual([])
    expect(await query(STRANGER, 'select * from public.sales_orders')).toEqual([])
    expect(await query(STRANGER, 'select * from public.inventory_movements')).toEqual([])
    await expect(
      query(STRANGER, `insert into public.customers (name) values ('Nope')`)
    ).rejects.toMatchObject({
      code: '42501',
    })
    await expect(
      query(STRANGER, `select public.adjust_batch(45, 0, 'zero it')`)
    ).rejects.toMatchObject({ hint: 'not_partner' })
  })

  it('lets partners read everything and manage customers', async () => {
    expect(await query(JOHNNY, 'select * from public.sales_orders')).toHaveLength(1)
    expect(
      (await query(JOHNNY, 'select * from public.inventory_movements')).length
    ).toBeGreaterThan(0)
    await query(JOHNNY, `update public.customers set price_per_can = 2 where name = 'Que Dice'`)
    await query(
      JOHNNY,
      `insert into public.customers (name, type) values ('Jane Doe', 'individual')`
    )
    expect(await count('select 1 from public.customers')).toBe(2)
  })

  it('only lets partners write orders and the ledger through the functions', async () => {
    await expect(
      query(
        PAUL,
        `insert into public.inventory_movements (batch_id, delta, reason) values (45, 1, 'adjustment')`
      )
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      query(PAUL, `update public.sales_orders set voided_at = now(), void_reason = 'x'`)
    ).rejects.toMatchObject({
      code: '42501',
    })
    await expect(query(PAUL, `delete from public.sales_order_lines`)).rejects.toMatchObject({
      code: '42501',
    })
  })

  it("doesn't let anon call the functions at all", async () => {
    await expect(query(ANON, `select public.archive_batch(45)`)).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('trusts direct database sessions such as the SQL editor', async () => {
    const batch = await pg.query<{ archive_batch: { archived_at: string | null } }>(
      'select public.archive_batch(46)'
    )
    expect(batch.rows).toHaveLength(1)
  })
})

describe('record_fill', () => {
  it('adds a house batch with a fill movement', async () => {
    const batch = await one<{ b: Record<string, unknown> }>(
      PAUL,
      `select to_jsonb(public.record_fill(p_count => 1440, p_is_still => false, p_fill_date => '2026-10-20',
         p_name => ' Portlandica ', p_source => 'Opal Springs', p_total_cost => 1855.5, p_note => 'Run 12')) as b`
    )
    expect(batch.b).toMatchObject({
      name: 'Portlandica',
      count: 1440,
      initialCount: 1440,
      isCustom: false,
      isStill: false,
      customer_id: null,
    })
    const movement = await one(
      SERVICE,
      `select delta, reason, note, created_by from public.inventory_movements where batch_id = $1`,
      [batch.b.id]
    )
    expect(movement).toEqual({ delta: 1440, reason: 'fill', note: 'Run 12', created_by: PAUL.sub })
    expect(await ledgerMismatches()).toBe(0)
  })

  it('names a custom batch after its customer', async () => {
    const customer = await one<{ id: number }>(
      SERVICE,
      `insert into public.customers (name) values ('Hotel Vintage') returning id`
    )
    const batch = await one<{ b: Record<string, unknown> }>(
      PAUL,
      `select to_jsonb(public.record_fill(p_count => 2880, p_is_still => true, p_fill_date => '2026-10-20', p_customer_id => $1)) as b`,
      [customer.id]
    )
    expect(batch.b).toMatchObject({
      name: 'Hotel Vintage',
      isCustom: true,
      customer_id: customer.id,
    })
  })

  it('needs a name for house stock and a positive count', async () => {
    await expect(
      query(
        PAUL,
        `select public.record_fill(p_count => 24, p_is_still => true, p_fill_date => null)`
      )
    ).rejects.toMatchObject({
      hint: 'invalid_input',
    })
    await expect(
      query(
        PAUL,
        `select public.record_fill(p_count => 0, p_is_still => true, p_fill_date => null, p_name => 'X')`
      )
    ).rejects.toMatchObject({ hint: 'invalid_input' })
  })

  it('records dog water as its own product', async () => {
    const batch = await one<{ product: string }>(
      PAUL,
      `select (public.record_fill(p_count => 240, p_is_still => true, p_fill_date => null, p_name => 'Dog water', p_product => 'dog_water')).product`
    )
    expect(batch.product).toBe('dog_water')
  })
})

describe('adjust_batch', () => {
  it('sets the counted number and logs the difference with the note', async () => {
    await query(PAUL, `select public.adjust_batch(45, 11976, 'Recount: one case short')`)
    expect(await batchCount(45)).toBe(11976)
    const movement = await one(
      SERVICE,
      `select delta, reason, note from public.inventory_movements where batch_id = 45 order by id desc limit 1`
    )
    expect(movement).toEqual({ delta: -24, reason: 'adjustment', note: 'Recount: one case short' })
    expect(await ledgerMismatches()).toBe(0)
  })

  it('needs a note and a non-negative count', async () => {
    await expect(query(PAUL, `select public.adjust_batch(45, 100, '  ')`)).rejects.toMatchObject({
      hint: 'invalid_input',
    })
    await expect(query(PAUL, `select public.adjust_batch(45, -1, 'oops')`)).rejects.toMatchObject({
      hint: 'invalid_input',
    })
  })

  it('refuses to overwrite a count that changed since the user looked', async () => {
    await expect(
      query(PAUL, `select public.adjust_batch(45, 100, 'recount', 11000)`)
    ).rejects.toMatchObject({
      hint: 'count_changed',
    })
    await query(PAUL, `select public.adjust_batch(45, 100, 'recount', 12000)`)
    expect(await batchCount(45)).toBe(100)
  })

  it('does nothing when the count is unchanged', async () => {
    const before = await count('select 1 from public.inventory_movements')
    await query(PAUL, `select public.adjust_batch(45, 12000, 'same')`)
    expect(await count('select 1 from public.inventory_movements')).toBe(before)
  })
})

describe('archive_batch and unarchive_batch', () => {
  it('writes off what is left, and can be undone', async () => {
    await query(PAUL, `select public.archive_batch(36, 'Dame closed')`)
    let batch = (
      await pg.query<{ count: string; archived_at: string | null }>(
        'select count, archived_at from public.inventory where id = 36'
      )
    ).rows[0]
    expect(Number(batch.count)).toBe(0)
    expect(batch.archived_at).not.toBeNull()

    await query(PAUL, `select public.archive_batch(36)`)
    expect(
      await count(
        `select 1 from public.inventory_movements where batch_id = 36 and reason = 'archive'`
      )
    ).toBe(1)

    await expect(
      query(PAUL, `select public.adjust_batch(36, 10, 'found some')`)
    ).rejects.toMatchObject({ hint: 'batch_archived' })

    await query(PAUL, `select public.unarchive_batch(36)`)
    batch = (
      await pg.query<{ count: string; archived_at: string | null }>(
        'select count, archived_at from public.inventory where id = 36'
      )
    ).rows[0]
    expect(Number(batch.count)).toBe(2760)
    expect(batch.archived_at).toBeNull()
    expect(await ledgerMismatches()).toBe(0)
  })

  it('keeps archived batches out of new orders', async () => {
    await query(PAUL, `select public.archive_batch(13)`)
    await expect(
      createOrder(PAUL, 'archived-batch', [
        { product: 'still', cans: 24, batch_id: 13, unit_price: 2 },
      ])
    ).rejects.toMatchObject({ hint: 'batch_archived' })
  })
})

describe('create_sales_order', () => {
  it('creates the order and its lines with totals, once per idempotency key', async () => {
    const first = await createOrder(PAUL, 'key-1', [
      { product: 'still', cans: 48, batch_id: 13, unit_price: 2 },
      { product: 'sparkling', cans: 24, batch_id: 25, unit_price: 1.5 },
    ])
    expect(first.created).toBe(true)
    expect(first.order).toMatchObject({
      customer_name: 'Que Dice',
      total_cans: 72,
      total_price: 132,
      sheet_status: 'pending',
      inventory_status: 'pending',
      trello_status: 'pending',
      square_status: 'skipped',
      created_by: PAUL.sub,
    })
    expect(first.lines.map((l) => [l.is_custom, l.line_total])).toEqual([
      [true, 96],
      [false, 36],
    ])

    const again = await createOrder(PAUL, 'key-1', [
      { product: 'still', cans: 1, batch_id: 45, unit_price: 9 },
    ])
    expect(again.created).toBe(false)
    expect(again.order.id).toBe(first.order.id)
    expect(again.lines).toHaveLength(2)
    expect(await count('select 1 from public.sales_orders')).toBe(1)
  })

  it('keeps a manual total and snapshots the customer', async () => {
    const customer = await one<{ id: number }>(
      SERVICE,
      `insert into public.customers (name, type) values ('Woodlark Hotel Portland', 'business') returning id`
    )
    const snapshot = await createOrder(
      PAUL,
      'key-2',
      [{ product: 'still', cans: 72, batch_id: 45, unit_price: 1.3889 }],
      {
        p_customer_id: customer.id,
        p_customer_name: null,
        p_total_price: 100,
        p_create_invoice: true,
      }
    )
    expect(snapshot.order).toMatchObject({
      customer_id: customer.id,
      customer_name: 'Woodlark Hotel Portland',
      total_price: 100,
      square_status: 'pending',
    })
  })

  it('refuses lines whose batch holds a different product', async () => {
    await expect(
      createOrder(PAUL, 'k-3', [{ product: 'still', cans: 24, batch_id: 25, unit_price: 1.5 }])
    ).rejects.toMatchObject({ hint: 'product_batch_mismatch' })
    await expect(
      createOrder(PAUL, 'k-4', [{ product: 'still', cans: 24, batch_id: 33, unit_price: 1.5 }])
    ).rejects.toMatchObject({ hint: 'product_batch_mismatch' })
    const dog = await createOrder(PAUL, 'k-5', [
      { product: 'dog_water', cans: 24, batch_id: 33, unit_price: 1.5 },
    ])
    expect(dog.created).toBe(true)
    expect(await count('select 1 from public.sales_orders')).toBe(1)
  })

  it('books donations at $0 only', async () => {
    await expect(
      createOrder(PAUL, 'k-6', [{ product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 }], {
        p_is_donation: true,
      })
    ).rejects.toMatchObject({ code: '23514' })
    const donation = await createOrder(
      PAUL,
      'k-7',
      [{ product: 'still', cans: 24, batch_id: 45, unit_price: 0 }],
      {
        p_is_donation: true,
      }
    )
    expect(donation.order.total_price).toBe(0)
  })

  it('needs at least one line and a customer name', async () => {
    await expect(createOrder(PAUL, 'k-8', [])).rejects.toMatchObject({ hint: 'invalid_input' })
    await expect(
      createOrder(PAUL, 'k-9', [{ product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 }], {
        p_customer_name: '  ',
      })
    ).rejects.toMatchObject({ hint: 'invalid_input' })
  })
})

describe('apply_order_inventory and void_order', () => {
  const apply = (auth: TestAuth, id: number, allowNegative = false) =>
    one(auth, 'select to_jsonb(public.apply_order_inventory($1, $2)) as o', [id, allowNegative])

  it('takes the cans out once, however many times it is called', async () => {
    const { order } = await createOrder(PAUL, 'apply-1', [
      { product: 'still', cans: 48, batch_id: 13, unit_price: 2 },
      { product: 'sparkling', cans: 24, batch_id: 25, unit_price: 1.5 },
    ])
    await apply(PAUL, order.id)
    await apply(JOHNNY, order.id)
    expect(await batchCount(13)).toBe(1200 - 48)
    expect(await batchCount(25)).toBe(4760 - 24)
    expect(
      await count(
        `select 1 from public.inventory_movements where order_id = $1 and reason = 'order'`,
        [order.id]
      )
    ).toBe(2)
    expect(
      (
        await pg.query<{ s: string }>(
          'select inventory_status as s from public.sales_orders where id = $1',
          [order.id]
        )
      ).rows[0].s
    ).toBe('done')
    expect(await ledgerMismatches()).toBe(0)
  })

  it("won't take a batch below zero unless told to", async () => {
    const { order } = await createOrder(PAUL, 'apply-2', [
      { product: 'still', cans: 1224, batch_id: 13, unit_price: 2 },
    ])
    const error = await apply(PAUL, order.id).catch((e) => e)
    expect(error).toMatchObject({ hint: 'insufficient_stock' })
    expect(JSON.parse(error.detail)).toEqual({ batch_id: 13, available: 1200, needed: 1224 })
    expect(await batchCount(13)).toBe(1200)

    await apply(PAUL, order.id, true)
    expect(await batchCount(13)).toBe(-24)
    expect(await ledgerMismatches()).toBe(0)
  })

  it('puts the cans back on void, once', async () => {
    const { order } = await createOrder(PAUL, 'void-1', [
      { product: 'still', cans: 240, batch_id: 45, unit_price: 1.5 },
    ])
    await apply(PAUL, order.id)
    await expect(
      query(PAUL, `select public.void_order($1, ' ')`, [order.id])
    ).rejects.toMatchObject({ hint: 'invalid_input' })
    await query(PAUL, `select public.void_order($1, 'Customer cancelled')`, [order.id])
    await query(PAUL, `select public.void_order($1, 'Clicked twice')`, [order.id])
    expect(await batchCount(45)).toBe(12000)
    const voided = await one(
      SERVICE,
      'select void_reason, voided_by from public.sales_orders where id = $1',
      [order.id]
    )
    expect(voided).toEqual({ void_reason: 'Customer cancelled', voided_by: PAUL.sub })
    expect(
      await count(
        `select 1 from public.inventory_movements where order_id = $1 and reason = 'void'`,
        [order.id]
      )
    ).toBe(1)
    await expect(apply(PAUL, order.id)).rejects.toMatchObject({ hint: 'order_void' })
    expect(await ledgerMismatches()).toBe(0)
  })

  it('voids an order that never touched inventory', async () => {
    const { order } = await createOrder(PAUL, 'void-2', [
      { product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 },
    ])
    await query(PAUL, `select public.void_order($1, 'Duplicate')`, [order.id])
    expect(await batchCount(45)).toBe(12000)
    expect(
      await count(`select 1 from public.inventory_movements where order_id = $1`, [order.id])
    ).toBe(0)
  })
})

describe('record_order_step', () => {
  const step = (
    id: number,
    name: string,
    status: string,
    externalId: string | null = null,
    error: string | null = null
  ) =>
    one(PAUL, 'select to_jsonb(public.record_order_step($1, $2, $3, $4, $5)) as o', [
      id,
      name,
      status,
      externalId,
      error,
    ])

  it('records outcomes and keeps done steps done', async () => {
    const { order } = await createOrder(PAUL, 'step-1', [
      { product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 },
    ])

    await step(order.id, 'trello', 'failed', null, 'Trello 500')
    let row = await one(
      SERVICE,
      'select trello_status, trello_error from public.sales_orders where id = $1',
      [order.id]
    )
    expect(row).toEqual({ trello_status: 'failed', trello_error: 'Trello 500' })

    await expect(step(order.id, 'trello', 'done')).rejects.toMatchObject({ code: '23514' })
    await step(order.id, 'trello', 'done', 'card-1')
    row = await one(
      SERVICE,
      'select trello_status, trello_error, trello_card_id from public.sales_orders where id = $1',
      [order.id]
    )
    expect(row).toEqual({ trello_status: 'done', trello_error: null, trello_card_id: 'card-1' })

    await step(order.id, 'trello', 'done', 'card-1')
    await expect(step(order.id, 'trello', 'failed')).rejects.toMatchObject({
      hint: 'step_already_done',
    })
    await expect(step(order.id, 'trello', 'done', 'card-2')).rejects.toMatchObject({
      hint: 'external_id_conflict',
    })
  })

  it('only records inventory failures, and rejects unknown steps', async () => {
    const { order } = await createOrder(PAUL, 'step-2', [
      { product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 },
    ])
    await expect(step(order.id, 'inventory', 'done')).rejects.toMatchObject({
      hint: 'invalid_input',
    })
    await step(order.id, 'inventory', 'failed', null, 'Network')
    await expect(step(order.id, 'email', 'done')).rejects.toMatchObject({ hint: 'invalid_input' })
    await expect(step(order.id, 'sheet', 'done', 'row-5')).rejects.toMatchObject({
      hint: 'invalid_input',
    })
  })

  it('never shares a Square invoice between orders', async () => {
    const a = await createOrder(
      PAUL,
      'step-3',
      [{ product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 }],
      { p_create_invoice: true }
    )
    const b = await createOrder(
      PAUL,
      'step-4',
      [{ product: 'still', cans: 24, batch_id: 45, unit_price: 1.5 }],
      { p_create_invoice: true }
    )
    await step(a.order.id, 'square', 'done', 'inv-1')
    await expect(step(b.order.id, 'square', 'done', 'inv-1')).rejects.toMatchObject({
      code: '23505',
    })
  })
})
