// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCustomer } from '@/lib/db/customers'
import { getBatch, ledgerMismatches } from '@/lib/db/inventory'
import {
  createSalesOrder,
  getSalesOrder,
  newIdempotencyKey,
  priceLines,
  type NewSalesOrder,
} from '@/lib/db/orders'
import { fakeSupabase } from '@/lib/db/testing/fakeSupabase'
import { SERVICE, createMigratedDb } from '@/lib/db/testing/testDb'
import type { Db } from '@/lib/db/types'
import { INVOICE_REMINDERS } from '@/lib/invoiceDraft'
import type { InvoiceLine } from '@/lib/square'

const steps = vi.hoisted(() => ({
  writeOrderToSheet: vi.fn(),
  untagOrderRows: vi.fn(),
  createTrelloCard: vi.fn(),
  createDraftInvoice: vi.fn(),
  deleteDraftInvoice: vi.fn(),
}))

vi.mock('@/lib/google/sheets', () => ({
  writeOrderToSheet: steps.writeOrderToSheet,
  untagOrderRows: steps.untagOrderRows,
}))
vi.mock('@/lib/trello', () => ({ createTrelloCard: steps.createTrelloCard }))
vi.mock('@/lib/square', () => ({
  createDraftInvoice: steps.createDraftInvoice,
  deleteDraftInvoice: steps.deleteDraftInvoice,
}))

import {
  SQUARE_NOT_SET_UP,
  cleanError,
  invoicedOutsideSquare,
  notInItemLibrary,
  runOrderSteps,
  squareOrderRef,
} from './orderSteps'

let base: PGlite
let pg: PGlite
let db: Db

beforeAll(async () => {
  // As in production: nobody is on the partner list.
  base = await createMigratedDb({ partners: false })
}, 60_000)
afterAll(async () => {
  await base.close()
})
beforeEach(async () => {
  pg = (await base.clone()) as PGlite
  // The app's server client: the secret key, so the service role.
  db = fakeSupabase(pg, SERVICE)
  steps.writeOrderToSheet
    .mockReset()
    .mockResolvedValue({ ref: 'Sales!A3126:V3127', locationAdded: false })
  steps.untagOrderRows.mockReset().mockResolvedValue(undefined)
  steps.createTrelloCard.mockReset().mockResolvedValue('card-1')
  steps.createDraftInvoice.mockReset().mockResolvedValue({
    squareInvoiceId: 'inv-1',
    squareOrderId: 'sq-order-1',
    squareCustomerId: 'sq-cust-1',
    status: 'DRAFT',
    dueDate: '2026-11-14',
    invoiceNumber: 'Sysco_02',
    unlinkedItems: [],
  })
  vi.stubEnv('SQUARE_ACCESS_TOKEN', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await pg.close()
})

// Keep the logs these failure cases write out of the test output.
vi.spyOn(console, 'error').mockImplementation(() => {})

const placeOrder = async (over: Partial<NewSalesOrder> = {}) =>
  (
    await createSalesOrder(db, {
      idempotency_key: newIdempotencyKey(),
      customer_name: 'Lovejoy Bakers',
      delivery_type: 'drop',
      delivery_date: '2026-10-21',
      order_date: '2026-10-15',
      lines: priceLines([
        { product: 'still', cans: 120, batch_id: 45 },
        { product: 'sparkling', cans: 48, batch_id: 25 },
      ]),
      ...over,
    })
  ).order

describe('runOrderSteps', () => {
  it('runs the sheet, inventory and Trello steps in order and records each one', async () => {
    const order = await placeOrder({
      notes: 'Back door',
      po_number: 'PO-9',
      delivery_address: '939 NW 10th Ave, Portland, OR 97209',
    })
    const run = await runOrderSteps(db, order.id)

    expect(run.order).toMatchObject({
      sheet_status: 'done',
      sheet_ref: 'Sales!A3126:V3127',
      inventory_status: 'done',
      trello_status: 'done',
      trello_card_id: 'card-1',
      square_status: 'skipped',
    })
    expect(run.order.lines).toHaveLength(2)
    expect(run.warnings).toEqual([])
    expect((await getBatch(db, 45))?.count).toBe(12000 - 120)
    expect((await getBatch(db, 25))?.count).toBe(4760 - 48)
    expect(await ledgerMismatches(db)).toEqual([])

    expect(steps.writeOrderToSheet).toHaveBeenCalledWith({
      key: order.idempotency_key,
      orderDate: '2026-10-15',
      type: 'business',
      customerName: 'Lovejoy Bakers',
      lines: [
        { product: 'still', cans: 120, batchId: 45, isCustom: false, amount: 180 },
        { product: 'sparkling', cans: 48, batchId: 25, isCustom: false, amount: 72 },
      ],
      isPaid: false,
      createInvoice: false,
      isDonation: false,
      notes: 'Back door',
      newLocation: null,
    })
    expect(steps.untagOrderRows).toHaveBeenCalledWith(order.idempotency_key)
    expect(steps.createTrelloCard).toHaveBeenCalledWith(
      {
        orderId: order.id,
        customerName: 'Lovejoy Bakers',
        deliveryType: 'drop',
        deliveryDate: '2026-10-21',
        lines: [
          { product: 'still', cans: 120, isCustom: false, fillDate: '2026-09-26' },
          { product: 'sparkling', cans: 48, isCustom: false, fillDate: '2026-08-03' },
        ],
        address: '939 NW 10th Ave, Portland, OR 97209',
        poNumber: 'PO-9',
        notes: 'Back door',
      },
      { findExisting: false }
    )
    expect(steps.writeOrderToSheet.mock.invocationCallOrder[0]).toBeLessThan(
      steps.createTrelloCard.mock.invocationCallOrder[0]
    )
  })

  it('keeps going past a failed step, and a retry repeats only that step', async () => {
    steps.writeOrderToSheet.mockRejectedValueOnce(new Error('The caller does not have permission'))
    const order = await placeOrder()

    const first = await runOrderSteps(db, order.id)
    expect(first.order).toMatchObject({
      sheet_status: 'failed',
      sheet_error: 'The caller does not have permission',
      inventory_status: 'done',
      trello_status: 'done',
    })
    expect(steps.untagOrderRows).not.toHaveBeenCalled()

    const retry = await runOrderSteps(db, order.id, { retry: true })
    expect(retry.order).toMatchObject({ sheet_status: 'done', sheet_error: null })
    expect(steps.writeOrderToSheet).toHaveBeenCalledTimes(2)
    expect(steps.createTrelloCard).toHaveBeenCalledTimes(1)
    expect((await getBatch(db, 45))?.count).toBe(12000 - 120)
  })

  it('looks for an earlier Trello card when retrying', async () => {
    steps.createTrelloCard.mockRejectedValueOnce(new Error('Trello API error: 503'))
    const order = await placeOrder()
    await runOrderSteps(db, order.id)
    await runOrderSteps(db, order.id, { retry: true })
    expect(steps.createTrelloCard.mock.calls.map((call) => call[1])).toEqual([
      { findExisting: false },
      { findExisting: true },
    ])
  })

  it('stops the inventory step when a batch is short, and takes the cans once confirmed', async () => {
    const order = await placeOrder({
      lines: priceLines([{ product: 'still', cans: 1224, batch_id: 13 }]),
      customer_name: 'Que Dice',
    })
    const run = await runOrderSteps(db, order.id)
    expect(run.shortfalls).toEqual([
      { batchId: 13, batchName: 'Que Dice Still', available: 1200, needed: 1224 },
    ])
    expect(run.order.inventory_status).toBe('failed')
    expect(run.order.inventory_error).toMatch(
      /Que Dice Still has 1,200 cans left; this order needs 1,224/
    )
    expect(run.order.trello_status).toBe('done')

    const confirmed = await runOrderSteps(db, order.id, { allowNegativeInventory: true })
    expect(confirmed.order.inventory_status).toBe('done')
    expect((await getBatch(db, 13))?.count).toBe(-24)
  })

  it('skips the Square step, and says so, when Square is not set up', async () => {
    const order = await placeOrder({ create_invoice: true })
    const run = await runOrderSteps(db, order.id)
    expect(run.order.square_status).toBe('skipped')
    expect(run.warnings).toEqual([SQUARE_NOT_SET_UP])
    expect(steps.createDraftInvoice).not.toHaveBeenCalled()
  })

  it('never makes a Square draft for a customer invoiced outside Square', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    const marketOfChoice = await createCustomer(db, {
      name: 'Market of Choice (Belmont)',
      invoiced_outside_square: true,
    })
    const order = await placeOrder({
      customer_id: marketOfChoice.id,
      customer_name: null,
      create_invoice: true,
    })
    const run = await runOrderSteps(db, order.id)

    expect(run.order).toMatchObject({ sheet_status: 'done', trello_status: 'done', square_status: 'skipped' })
    expect(run.warnings).toEqual([invoicedOutsideSquare('Market of Choice (Belmont)')])
    expect(steps.createDraftInvoice).not.toHaveBeenCalled()
  })

  it("makes a Square draft for the customer and saves the customer's Square id", async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    const sysco = await createCustomer(db, {
      name: 'Sysco',
      payment_terms_days: 65,
      email: 'ap@sysco.example',
    })
    const order = await placeOrder({
      customer_id: sysco.id,
      customer_name: null,
      create_invoice: true,
      po_number: '40012345',
      customer_email: 'orders@sysco.example',
    })
    const run = await runOrderSteps(db, order.id)

    expect(run.order).toMatchObject({ square_status: 'done', square_invoice_id: 'inv-1' })
    expect(run.warnings).toEqual([])
    expect(steps.createDraftInvoice).toHaveBeenCalledWith({
      orderId: squareOrderRef(order),
      orderDate: new Date(order.created_at),
      customer: {
        name: 'Sysco',
        email: 'orders@sysco.example',
        squareCustomerId: null,
        paymentTermsDays: 65,
      },
      lines: [
        {
          item: '24 pack - Still',
          quantity: 5,
          amountCents: 18000,
          listPriceCents: 3600,
          discountName: 'Sysco Discount',
        },
        {
          item: '24 pack - Sparkling',
          quantity: 2,
          amountCents: 7200,
          listPriceCents: 3600,
          discountName: 'Sysco Discount',
        },
      ],
      title: 'PO #40012345',
      message: [
        'Portlandica, order of 5 cases of Still and 2 cases of Sparkling (168 cans total) @ $1.50/can for a total of $252.',
        '',
        'Ordered: 10/15/2026',
        'Delivery by: 10/21/2026',
        '',
        '**** MAILING ADDRESS ****',
        'Portlandica',
        'P.O. Box 5374',
        'Portland, OR 97228',
        '*********',
      ].join('\n'),
      serviceDate: '2026-10-15',
      invoiceNumber: { series: 'Sysco' },
      reminders: INVOICE_REMINDERS,
      savePaymentMethod: true,
    })
    const { data } = await db
      .from('customers')
      .select('square_customer_id')
      .eq('id', sysco.id)
      .single()
    expect(data).toEqual({ square_customer_id: 'sq-cust-1' })
  })

  it('books a mixed order line by line on the sheet and the invoice', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    // Que Dice's custom still cans at their price, house sparkling at $1.50.
    const order = await placeOrder({
      customer_name: 'Que Dice',
      create_invoice: true,
      lines: priceLines(
        [
          { product: 'still', cans: 240, batch_id: 13 },
          { product: 'sparkling', cans: 48, batch_id: 25 },
        ],
        { pricePerCan: [2, 1.5] }
      ),
    })
    expect(order.total_price).toBe(552)
    await runOrderSteps(db, order.id)

    expect(steps.writeOrderToSheet.mock.calls[0][0].lines).toEqual([
      { product: 'still', cans: 240, batchId: 13, isCustom: true, amount: 480 },
      { product: 'sparkling', cans: 48, batchId: 25, isCustom: false, amount: 72 },
    ])
    expect(
      (steps.createDraftInvoice.mock.calls[0][0].lines as InvoiceLine[]).map(
        ({ item, quantity, amountCents }) => ({ item, quantity, amountCents })
      )
    ).toEqual([
      { item: '24 pack - Sparkling', quantity: 2, amountCents: 7200 },
      { item: '24 pack - Customized Portland Water Can', quantity: 10, amountCents: 48000 },
    ])
  })

  it('warns when a draft line is not in the Square Item Library', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    steps.createDraftInvoice.mockResolvedValueOnce({
      squareInvoiceId: 'inv-1',
      squareOrderId: 'sq-order-1',
      squareCustomerId: 'sq-cust-1',
      status: 'DRAFT',
      dueDate: '2026-11-14',
      invoiceNumber: 'LovejoyBakers_022',
      unlinkedItems: ['24 pack - Still'],
    })
    const order = await placeOrder({ create_invoice: true })

    const run = await runOrderSteps(db, order.id)

    expect(run.order.square_status).toBe('done')
    expect(run.warnings).toEqual([notInItemLibrary(['24 pack - Still'])])
    expect(run.warnings[0]).toBe(
      "Not in the Square Item Library: 24 pack - Still. The draft lists it by name, so Square's item reports won't count it."
    )
  })

  it('splits a typed total over a mixed order the same way on the sheet and the invoice', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    const lines = priceLines(
      [
        { product: 'still', cans: 240, batch_id: 13 },
        { product: 'sparkling', cans: 48, batch_id: 25 },
      ],
      { pricePerCan: [2, 1.5], totalPrice: 500 }
    )
    const order = await placeOrder({
      customer_name: 'Que Dice',
      create_invoice: true,
      lines,
      total_price: 500,
    })
    await runOrderSteps(db, order.id)

    const sheetAmounts = steps.writeOrderToSheet.mock.calls[0][0].lines.map(
      (line: { amount: number }) => line.amount
    )
    expect(sheetAmounts).toEqual([434.78, 65.22])
    const invoice = steps.createDraftInvoice.mock.calls[0][0].lines as InvoiceLine[]
    // Sparkling first, then the custom still cans
    expect(invoice.map((line) => line.amountCents / 100)).toEqual([65.22, 434.78])
  })

  it("makes an individual's draft due on receipt and a business's due in 30 days", async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    const dtc = await placeOrder({
      customer_name: 'Pat Doe',
      type: 'individual',
      create_invoice: true,
      customer_email: 'pat@example.com',
    })
    await runOrderSteps(db, dtc.id)
    expect(steps.createDraftInvoice.mock.calls[0][0].customer).toEqual({
      name: 'Pat Doe',
      email: 'pat@example.com',
      squareCustomerId: null,
      paymentTermsDays: 0,
    })

    const business = await placeOrder({ create_invoice: true })
    await runOrderSteps(db, business.id)
    expect(steps.createDraftInvoice.mock.calls[1][0].customer.paymentTermsDays).toBe(30)
  })

  it('keeps terms set on an individual customer', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    const pat = await createCustomer(db, {
      name: 'Pat Doe',
      type: 'individual',
      payment_terms_days: 14,
    })
    const order = await placeOrder({
      customer_id: pat.id,
      customer_name: null,
      create_invoice: true,
    })
    expect(order.type).toBe('individual')
    await runOrderSteps(db, order.id)
    expect(steps.createDraftInvoice.mock.calls[0][0].customer.paymentTermsDays).toBe(14)
  })

  it('records a Square failure so it can be retried', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sandbox-token')
    steps.createDraftInvoice.mockRejectedValueOnce(
      new Error('Square POST /v2/invoices failed: 503')
    )
    const order = await placeOrder({ create_invoice: true })
    expect((await runOrderSteps(db, order.id)).order).toMatchObject({
      square_status: 'failed',
      square_error: 'Square POST /v2/invoices failed: 503',
    })
    expect((await runOrderSteps(db, order.id, { retry: true })).order.square_status).toBe('done')
  })

  it('lists a new business for the locations tab', async () => {
    const customer = await createCustomer(db, {
      name: 'Baerlic Brewery',
      business_type: 'Brewery',
      street_address: '2235 SE 11th Ave',
      city: 'Portland',
      state: 'OR',
      zip: '97214',
    })
    const order = await placeOrder({
      customer_id: customer.id,
      customer_name: null,
      new_customer: true,
    })
    await runOrderSteps(db, order.id)
    expect(steps.writeOrderToSheet.mock.calls[0][0].newLocation).toEqual({
      name: 'Baerlic Brewery',
      address: '2235 SE 11th Ave, Portland, OR 97214',
      latitude: null,
      longitude: null,
      businessType: 'Brewery',
    })
  })

  it('does nothing for a void order', async () => {
    const order = await placeOrder()
    await db.rpc('void_order', { p_order_id: order.id, p_reason: 'Test' })
    const run = await runOrderSteps(db, order.id)
    expect(run.warnings).toEqual(['This order is void.'])
    expect(steps.writeOrderToSheet).not.toHaveBeenCalled()
  })

  it('warns instead of throwing when an outcome cannot be recorded', async () => {
    const order = await placeOrder()
    const failingRecord: Db = {
      ...db,
      from: db.from.bind(db),
      rpc: ((fn: string, args?: Record<string, unknown>) =>
        fn === 'record_order_step' && args?.p_step === 'trello'
          ? Promise.resolve({ data: null, error: { message: 'connection reset', code: '08006' } })
          : db.rpc(fn, args)) as Db['rpc'],
    } as Db
    const run = await runOrderSteps(failingRecord, order.id)
    expect(run.warnings).toEqual([
      expect.stringMatching(/Couldn't save how the Trello step went \(connection reset\)/),
    ])
    expect((await getSalesOrder(db, order.id))?.trello_status).toBe('pending')
  })
})

describe('error text', () => {
  it('keeps credentials out of stored errors', () => {
    expect(
      cleanError('GET https://api.trello.com/1/boards/b/labels?key=abc&token=xyz failed')
    ).toBe('GET https://api.trello.com/1/boards/b/labels?key=…&token=… failed')
  })

  it('makes a short Square reference that differs between orders', () => {
    expect(
      squareOrderRef({ id: 123, idempotency_key: '1a2b3c4d-0000-4000-8000-000000000000' })
    ).toBe('123-1a2b3c4d')
  })
})
