// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCustomer, findCustomerByName } from '@/lib/db/customers'
import { getBatch } from '@/lib/db/inventory'
import { getSalesOrder, listSalesOrders, newIdempotencyKey } from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { SERVICE, asRole, createMigratedDb } from '@/lib/db/testing/testDb'
import type { CreateOrderResult, OrderInput } from '@/types/orders'

const mocks = vi.hoisted(() => ({
  pg: null as PGlite | null,
  afterTasks: [] as (() => unknown)[],
  getLocationsFromSheet: vi.fn(),
  findSameDaySheetOrder: vi.fn(),
  writeOrderToSheet: vi.fn(),
  untagOrderRows: vi.fn(),
  writeLocationCoordinates: vi.fn(),
  createTrelloCard: vi.fn(),
  createDraftInvoice: vi.fn(),
  deleteDraftInvoice: vi.fn(),
  geocodeAddress: vi.fn(),
}))

vi.mock('@/lib/supabase/server', async () => {
  const { fakeSupabase } = await import('@/lib/db/testing/fakeSupabase')
  const { SERVICE } = await import('@/lib/db/testing/testDb')
  // The app's server uses the secret key: the service role.
  return { createClient: async () => fakeSupabase(mocks.pg!, SERVICE) }
})
// Sign-in is covered by src/app/actions/auth.test.ts; act as a signed-in device here.
vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: async () => ({ failure: null }),
}))
vi.mock('@/lib/google/sheets', () => ({
  getLocationsFromSheet: mocks.getLocationsFromSheet,
  findSameDaySheetOrder: mocks.findSameDaySheetOrder,
  writeOrderToSheet: mocks.writeOrderToSheet,
  untagOrderRows: mocks.untagOrderRows,
  writeLocationCoordinates: mocks.writeLocationCoordinates,
}))
vi.mock('@/lib/trello', () => ({ createTrelloCard: mocks.createTrelloCard }))
vi.mock('@/lib/square', () => ({
  createDraftInvoice: mocks.createDraftInvoice,
  deleteDraftInvoice: mocks.deleteDraftInvoice,
}))
vi.mock('@/lib/geocode', () => ({ geocodeAddress: mocks.geocodeAddress }))
vi.mock('next/server', () => ({ after: (task: () => unknown) => mocks.afterTasks.push(task) }))

import { createOrder, getOrderFormData } from './orders'

let base: PGlite
const db = () => fakeSupabase(mocks.pg!, SERVICE)

beforeAll(async () => {
  // As in production: nobody is on the partner list.
  base = await createMigratedDb({ partners: false })
}, 60_000)
afterAll(async () => {
  await base.close()
})
beforeEach(async () => {
  mocks.pg = (await base.clone()) as PGlite
  mocks.afterTasks.length = 0
  mocks.getLocationsFromSheet.mockReset().mockResolvedValue([])
  mocks.findSameDaySheetOrder.mockReset().mockResolvedValue(false)
  mocks.writeOrderToSheet
    .mockReset()
    .mockResolvedValue({ ref: 'Sales!A3126:V3127', locationAdded: false })
  mocks.untagOrderRows.mockReset().mockResolvedValue(undefined)
  mocks.writeLocationCoordinates.mockReset().mockResolvedValue(true)
  mocks.createTrelloCard.mockReset().mockResolvedValue('card-1')
  mocks.createDraftInvoice.mockReset()
  mocks.geocodeAddress.mockReset()
  vi.stubEnv('SQUARE_ACCESS_TOKEN', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await mocks.pg!.close()
})

vi.spyOn(console, 'error').mockImplementation(() => {})

// Link a custom batch to its customer, as the seed does.
const linkBatch = (batchId: number, customerId: number) =>
  asRole(mocks.pg!, SERVICE, (tx) =>
    tx.query('update public.inventory set customer_id = $1 where id = $2', [customerId, batchId])
  )

const input = (over: Partial<OrderInput> = {}): OrderInput => ({
  customerType: 'existing',
  customerId: null,
  name: 'Lovejoy Bakers',
  businessType: null,
  streetAddress: null,
  city: null,
  state: null,
  zip: null,
  deliveryAddress: '939 NW 10th Ave, Portland, OR 97209',
  email: null,
  poNumber: null,
  lines: [
    { product: 'still', cans: 120, batchId: 45 },
    { product: 'sparkling', cans: 48, batchId: 25 },
  ],
  price: 252,
  isPaid: false,
  createInvoice: false,
  isDonation: false,
  deliveryType: 'Drop',
  deliveryDate: '2026-10-21',
  notes: null,
  ...over,
})

const lovejoy = async () => {
  const customer = await createCustomer(db(), { name: 'Lovejoy Bakers' })
  return input({ customerId: customer.id })
}

const saved = (result: unknown) => {
  const r = result as CreateOrderResult
  if (r.status !== 'saved') throw new Error(`expected saved, got ${JSON.stringify(r)}`)
  return r
}

describe('getOrderFormData', () => {
  it('adds new names from the locations tab and returns customers, prices and batches', async () => {
    await createCustomer(db(), { name: 'Hotel Vintage', price_per_can: 2, custom_cans: true })
    mocks.getLocationsFromSheet.mockResolvedValue([
      {
        name: 'Hotel Vintage',
        address: '422 SW Broadway, Portland, OR 97205',
        latitude: null,
        longitude: null,
        businessType: 'Hotel',
      },
      {
        name: 'Crisp Salads',
        address: '3901 N Williams Ave, Portland, OR 97227',
        latitude: null,
        longitude: null,
        businessType: 'Restaurant',
      },
    ])

    const data = await getOrderFormData()
    expect(data).toMatchObject({
      customers: [
        {
          name: 'Crisp Salads',
          price_per_can: null,
          custom_cans: false,
          address: '3901 N Williams Ave, Portland, OR 97227',
        },
        {
          name: 'Hotel Vintage',
          price_per_can: 2,
          custom_cans: true,
          address: '422 SW Broadway, Portland, OR 97205',
        },
      ],
      businessTypes: ['Hotel', 'Restaurant'],
      squareReady: false,
      warnings: [],
    })
    expect(await findCustomerByName(db(), 'Crisp Salads')).toMatchObject({ city: 'Portland' })
    // Batches come with what's left in them; the archived one is left out.
    const batches = (data as { batches: { id: number; count: number }[] }).batches
    expect(batches.find((b) => b.id === 45)).toMatchObject({ count: 12000, product: 'water' })
  })

  it('still offers the saved customers when the locations tab cannot be read', async () => {
    await createCustomer(db(), { name: 'Dame' })
    mocks.getLocationsFromSheet.mockRejectedValue(new Error('quota exceeded'))
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'token')
    expect(await getOrderFormData()).toMatchObject({
      customers: [{ name: 'Dame' }],
      squareReady: true,
      warnings: [expect.stringMatching(/Current Locations Addresses tab \(quota exceeded\)/)],
    })
  })
})

describe('createOrder', () => {
  it('saves the order, then runs the sheet, inventory and Trello steps', async () => {
    const order = await lovejoy()
    const key = newIdempotencyKey()
    const result = saved(
      await createOrder({ ...order, poNumber: 'PO-7', notes: 'Back door' }, { idempotencyKey: key })
    )

    expect(result.order).toMatchObject({
      idempotency_key: key,
      customer_id: order.customerId,
      customer_name: 'Lovejoy Bakers',
      delivery_type: 'drop',
      delivery_date: '2026-10-21',
      delivery_address: '939 NW 10th Ave, Portland, OR 97209',
      po_number: 'PO-7',
      notes: 'Back door',
      total_cans: 168,
      total_price: 252,
      sheet_status: 'done',
      sheet_ref: 'Sales!A3126:V3127',
      inventory_status: 'done',
      trello_status: 'done',
      trello_card_id: 'card-1',
      square_status: 'skipped',
    })
    expect(result.warnings).toEqual([])
    expect((await getBatch(db(), 45))?.count).toBe(12000 - 120)
    expect(mocks.writeOrderToSheet).toHaveBeenCalledTimes(1)
    expect(mocks.createTrelloCard.mock.calls[0][1]).toEqual({ findExisting: false })
  })

  it("prices a mixed order line by line: custom cans at the customer's price, house stock at $1.50", async () => {
    const hotel = await createCustomer(db(), {
      name: 'Hotel Vintage',
      price_per_can: 2,
      custom_cans: true,
    })
    await linkBatch(22, hotel.id)
    const result = saved(
      await createOrder(
        input({
          customerId: hotel.id,
          name: 'Hotel Vintage',
          lines: [
            { product: 'still', cans: 240, batchId: 22 },
            { product: 'sparkling', cans: 48, batchId: 25 },
          ],
          price: 552,
        }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.lines).toMatchObject([
      { batch_id: 22, is_custom: true, unit_price: 2, line_total: 480 },
      { batch_id: 25, is_custom: false, unit_price: 1.5, line_total: 72 },
    ])
    expect(result.order.total_price).toBe(552)
    // Each Sales row gets its own line's amount.
    expect(
      mocks.writeOrderToSheet.mock.calls[0][0].lines.map((l: { amount: number }) => l.amount)
    ).toEqual([480, 72])
  })

  it("charges house stock at the price of a customer who isn't a custom-can account", async () => {
    const benBridge = await createCustomer(db(), {
      name: 'Ben Bridge Jeweler (Downtown)',
      price_per_can: 1.35,
      custom_cans: false,
    })
    const result = saved(
      await createOrder(
        input({ customerId: benBridge.id, name: 'Ben Bridge Jeweler (Downtown)', price: 226.8 }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.lines.map((l) => l.unit_price)).toEqual([1.35, 1.35])
    expect(result.order.total_price).toBe(226.8)
  })

  it('spreads a typed price over a mixed order in proportion to its line prices', async () => {
    const hotel = await createCustomer(db(), {
      name: 'Hotel Vintage',
      price_per_can: 2,
      custom_cans: true,
    })
    await linkBatch(22, hotel.id)
    const result = saved(
      await createOrder(
        input({
          customerId: hotel.id,
          name: 'Hotel Vintage',
          lines: [
            { product: 'still', cans: 240, batchId: 22 },
            { product: 'sparkling', cans: 48, batchId: 25 },
          ],
          price: 500,
        }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.total_price).toBe(500)
    expect(result.order.lines.map((l) => l.unit_price)).toEqual([1.8116, 1.3587])
    expect(
      mocks.writeOrderToSheet.mock.calls[0][0].lines.map((l: { amount: number }) => l.amount)
    ).toEqual([434.78, 65.22])
  })

  it('charges the default price when a custom-can customer orders house stock', async () => {
    const hotel = await createCustomer(db(), {
      name: 'Hotel Vintage',
      price_per_can: 2,
      custom_cans: true,
    })
    const result = saved(
      await createOrder(
        input({
          customerId: hotel.id,
          name: 'Hotel Vintage',
          lines: [{ product: 'still', cans: 48, batchId: 45 }],
          price: 72,
        }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.lines).toMatchObject([{ unit_price: 1.5, is_custom: false }])
  })

  it('keeps a typed price and spreads it over every can', async () => {
    const result = saved(
      await createOrder(
        { ...(await lovejoy()), price: 250 },
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.total_price).toBe(250)
    expect(result.order.lines.map((l) => l.unit_price)).toEqual([1.4881, 1.4881])
  })

  it('finishes the same order when the form sends its key again', async () => {
    mocks.writeOrderToSheet.mockRejectedValueOnce(new Error('Sheets API 503'))
    const order = await lovejoy()
    const key = newIdempotencyKey()
    const first = saved(await createOrder(order, { idempotencyKey: key }))
    expect(first.order).toMatchObject({
      sheet_status: 'failed',
      sheet_error: 'Sheets API 503',
      trello_status: 'done',
    })

    const again = saved(await createOrder(order, { idempotencyKey: key }))
    expect(again.order).toMatchObject({ id: first.order.id, sheet_status: 'done' })
    expect(await listSalesOrders(db())).toHaveLength(1)
    expect(mocks.createTrelloCard).toHaveBeenCalledTimes(1)
    expect((await getBatch(db(), 45))?.count).toBe(12000 - 120)
  })

  it("won't let a changed form reuse the key of an order it already saved", async () => {
    const order = await lovejoy()
    const key = newIdempotencyKey()
    const first = saved(await createOrder(order, { idempotencyKey: key }))
    expect(await createOrder({ ...order, price: 300 }, { idempotencyKey: key })).toEqual({
      status: 'already_saved',
      orderId: first.order.id,
      message: expect.stringMatching(/already saved order #\d+ with different details/),
    })
    expect(await listSalesOrders(db())).toHaveLength(1)
  })

  it('asks before booking a second order for the customer today, and books it when told to', async () => {
    const order = await lovejoy()
    saved(await createOrder(order, { idempotencyKey: newIdempotencyKey() }))

    const duplicate = await createOrder(order, { idempotencyKey: newIdempotencyKey() })
    expect(duplicate).toEqual({
      status: 'duplicate',
      message: expect.stringMatching(
        /^Lovejoy Bakers already has an order today \(order #\d+\)\.$/
      ),
    })
    expect(await listSalesOrders(db())).toHaveLength(1)

    saved(await createOrder(order, { idempotencyKey: newIdempotencyKey(), force: true }))
    expect(await listSalesOrders(db())).toHaveLength(2)
  })

  it('counts orders typed straight into the Sales sheet as duplicates', async () => {
    mocks.findSameDaySheetOrder.mockResolvedValue(true)
    expect(await createOrder(await lovejoy(), { idempotencyKey: newIdempotencyKey() })).toEqual({
      status: 'duplicate',
      message: 'Lovejoy Bakers already has an order today in the Sales sheet.',
    })
  })

  it("doesn't hold up an order when the sheet's duplicate check can't run", async () => {
    mocks.findSameDaySheetOrder.mockRejectedValue(new Error('Sheets API 503'))
    saved(await createOrder(await lovejoy(), { idempotencyKey: newIdempotencyKey() }))
  })

  it('stops before writing anything when a batch is short, and books it once confirmed', async () => {
    const order = {
      ...(await lovejoy()),
      lines: [{ product: 'sparkling' as const, cans: 4800, batchId: 25 }],
      price: 7200,
    }
    expect(await createOrder(order, { idempotencyKey: newIdempotencyKey() })).toEqual({
      status: 'short',
      shortfalls: [
        {
          batchId: 25,
          batchName: 'Portlandica - north powder Sparkling',
          available: 4760,
          needed: 4800,
        },
      ],
    })
    expect(await listSalesOrders(db())).toHaveLength(0)

    const result = saved(
      await createOrder(order, { idempotencyKey: newIdempotencyKey(), allowOversell: true })
    )
    expect(result.order.inventory_status).toBe('done')
    expect((await getBatch(db(), 25))?.count).toBe(-40)
  })

  it("refuses another customer's custom cans", async () => {
    const dame = await createCustomer(db(), { name: 'Dame', custom_cans: true })
    await linkBatch(36, dame.id)
    const result = await createOrder(
      { ...(await lovejoy()), lines: [{ product: 'still', cans: 24, batchId: 36 }], price: 36 },
      { idempotencyKey: newIdempotencyKey() }
    )
    expect(result).toEqual({
      status: 'failed',
      message: expect.stringMatching(/can't be used for this customer/),
    })
  })

  it('adds a new business, lists it for the locations tab and looks up its coordinates afterwards', async () => {
    mocks.geocodeAddress.mockResolvedValue({
      latitude: 45.5,
      longitude: -122.65,
      matchedAddress: '',
    })
    const result = saved(
      await createOrder(
        input({
          customerType: 'new',
          name: 'Baerlic Brewery',
          businessType: 'Brewery',
          streetAddress: '2235 SE 11th Ave',
          city: 'Portland',
          state: 'or',
          zip: '97214',
          deliveryAddress: null,
          email: 'Owner@Baerlic.example',
        }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    const customer = await findCustomerByName(db(), 'Baerlic Brewery')
    expect(customer).toMatchObject({
      type: 'business',
      business_type: 'Brewery',
      street_address: '2235 SE 11th Ave',
      state: 'OR',
      email: 'owner@baerlic.example',
      latitude: null,
    })
    expect(result.order).toMatchObject({
      customer_id: customer!.id,
      new_customer: true,
      delivery_address: '2235 SE 11th Ave, Portland, OR 97214',
      customer_email: 'owner@baerlic.example',
    })
    expect(mocks.writeOrderToSheet.mock.calls[0][0].newLocation).toMatchObject({
      name: 'Baerlic Brewery',
      address: '2235 SE 11th Ave, Portland, OR 97214',
      businessType: 'Brewery',
    })

    // Geocoding waits until the response has gone out.
    expect(mocks.geocodeAddress).not.toHaveBeenCalled()
    expect(mocks.afterTasks).toHaveLength(1)
    await mocks.afterTasks[0]()
    expect(await findCustomerByName(db(), 'Baerlic Brewery')).toMatchObject({
      latitude: 45.5,
      longitude: -122.65,
    })
    expect(mocks.writeLocationCoordinates).toHaveBeenCalledWith('Baerlic Brewery', 45.5, -122.65)
  })

  it("uses a business that's already on file instead of adding it twice", async () => {
    const crisp = await createCustomer(db(), {
      name: 'Crisp Salads',
      latitude: 45.55,
      longitude: -122.67,
    })
    const result = saved(
      await createOrder(
        input({ customerType: 'new', name: 'crisp salads', deliveryAddress: null }),
        {
          idempotencyKey: newIdempotencyKey(),
        }
      )
    )
    expect(result.order).toMatchObject({ customer_id: crisp.id, customer_name: 'Crisp Salads' })
    expect((await db().from('customers').select('id')).data).toHaveLength(1)
    expect(mocks.afterTasks).toHaveLength(0)
  })

  it('books an individual without a customer row, with the delivery address for the card', async () => {
    const result = saved(
      await createOrder(
        input({
          customerType: 'individual',
          name: 'Pat Doe',
          deliveryAddress: '12 SE Ash St, Portland',
          email: 'pat@example.com',
        }),
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order).toMatchObject({
      customer_id: null,
      type: 'individual',
      delivery_address: '12 SE Ash St, Portland',
      customer_email: 'pat@example.com',
      notes: null,
    })
    expect(mocks.createTrelloCard.mock.calls[0][0]).toMatchObject({
      address: '12 SE Ash St, Portland',
      notes: null,
    })
    expect((await db().from('customers').select('id')).data).toEqual([])
  })

  it('saves a billing email typed for an existing customer', async () => {
    const order = await lovejoy()
    saved(
      await createOrder(
        { ...order, email: 'AP@Lovejoy.example' },
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect((await findCustomerByName(db(), 'Lovejoy Bakers'))?.email).toBe('ap@lovejoy.example')
  })

  it('books a donation at $0 with no invoice', async () => {
    const result = saved(
      await createOrder(
        { ...(await lovejoy()), isDonation: true, price: 0, createInvoice: true },
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order).toMatchObject({
      is_donation: true,
      total_price: 0,
      create_invoice: false,
      square_status: 'skipped',
    })
  })

  it('makes a Square draft when Create Invoice is on and Square is set up', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    mocks.createDraftInvoice.mockResolvedValue({
      squareInvoiceId: 'inv-9',
      squareCustomerId: 'sq-1',
      squareOrderId: 'o',
      status: 'DRAFT',
      dueDate: '',
      invoiceNumber: null,
    })
    const result = saved(
      await createOrder(
        { ...(await lovejoy()), createInvoice: true, poNumber: '40012345' },
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order).toMatchObject({ square_status: 'done', square_invoice_id: 'inv-9' })
    expect(mocks.createDraftInvoice.mock.calls[0][0]).toMatchObject({
      poNumber: '40012345',
      customer: { name: 'Lovejoy Bakers', paymentTermsDays: 30 },
    })
  })

  it('says so when Create Invoice is on but Square is not set up', async () => {
    const result = saved(
      await createOrder(
        { ...(await lovejoy()), createInvoice: true },
        { idempotencyKey: newIdempotencyKey() }
      )
    )
    expect(result.order.square_status).toBe('skipped')
    expect(result.warnings).toEqual([expect.stringMatching(/Square isn't set up/)])
  })

  it('writes nothing for an incomplete order or a missing key', async () => {
    expect(
      await createOrder(input({ price: null }), { idempotencyKey: newIdempotencyKey() })
    ).toEqual({
      status: 'failed',
      message: 'Pick the customer from the list.',
    })
    expect(await createOrder(await lovejoy(), { idempotencyKey: ' ' })).toMatchObject({
      status: 'failed',
    })
    expect(await listSalesOrders(db())).toHaveLength(0)
  })

  it('says a retry is safe when something unexpected goes wrong', async () => {
    const order = await lovejoy()
    // Break the database underneath the action.
    await mocks.pg!.exec('drop table public.sales_order_lines cascade')
    expect(await createOrder(order, { idempotencyKey: newIdempotencyKey() })).toEqual({
      status: 'failed',
      message: expect.stringMatching(/couldn't be confirmed .* Submitting again is safe/),
    })
  })

  it('reads the saved order back with its lines', async () => {
    const result = saved(
      await createOrder(await lovejoy(), { idempotencyKey: newIdempotencyKey() })
    )
    expect((await getSalesOrder(db(), result.order.id))?.lines).toHaveLength(2)
  })
})
