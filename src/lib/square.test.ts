// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDraftInvoice,
  deleteDraftInvoice,
  SquareApiError,
  type DraftInvoiceInput,
  type InvoiceLine,
} from './square'
import { ERROR_CODES, createFakeSquare, type FakeSquare } from './testing/fakeSquare'

let square: FakeSquare
// The Item Library's 24 packs, as the fake has them
let STILL: string
let SPARKLING: string
let CUSTOM: string

beforeEach(() => {
  vi.stubEnv('SQUARE_ACCESS_TOKEN', 'test-token')
  vi.stubEnv('SQUARE_LOCATION_ID', 'LOCATION_1')
  vi.stubEnv('SQUARE_ENVIRONMENT', 'sandbox')
  // Due dates are never before today, so the tests' today is fixed: Oct 15 in Portland
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T18:00:00Z') })
  square = createFakeSquare()
  STILL = square.addItem('24 pack - Still', 3600)
  SPARKLING = square.addItem('24 pack - Sparkling', 3600)
  CUSTOM = square.addItem('24 pack - Customized Portland Water Can', 4800)
  vi.stubGlobal('fetch', square.fetch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Packs at list price unless the amount says otherwise */
const packs = (
  item: string,
  quantity: number,
  overrides: Partial<InvoiceLine> = {}
): InvoiceLine => {
  const listPriceCents = item.includes('Customized') ? 4800 : 3600
  return {
    item,
    quantity,
    amountCents: quantity * listPriceCents,
    listPriceCents,
    discountName: 'Dame Discount',
    ...overrides,
  }
}
const still = (quantity: number, overrides: Partial<InvoiceLine> = {}) =>
  packs('24 pack - Still', quantity, overrides)
const sparkling = (quantity: number, overrides: Partial<InvoiceLine> = {}) =>
  packs('24 pack - Sparkling', quantity, overrides)
const custom = (quantity: number, overrides: Partial<InvoiceLine> = {}) =>
  packs('24 pack - Customized Portland Water Can', quantity, overrides)

const anOrder = (overrides: Partial<DraftInvoiceInput> = {}): DraftInvoiceInput => ({
  orderId: 'order-1001',
  customer: { name: 'Dame', email: 'ap@dame.example', paymentTermsDays: 30 },
  lines: [still(10)],
  orderDate: new Date('2026-10-15T17:00:00Z'),
  ...overrides,
})

const customerNamed = (name: string, overrides: Partial<DraftInvoiceInput['customer']> = {}) => ({
  name,
  email: 'ap@example.com',
  paymentTermsDays: 30,
  ...overrides,
})

/** Runs `run` on fake timers, so the retry back-off doesn't slow the tests down */
const skippingDelays = async <T>(run: () => Promise<T>) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: Date.now() })
  let settled = false
  const outcome = run().finally(() => {
    settled = true
  })
  outcome.catch(() => {}) // the caller handles it
  while (!settled) await vi.advanceTimersToNextTimerAsync()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  return outcome
}

describe('createDraftInvoice', () => {
  it('creates a customer, an order and a draft invoice', async () => {
    const result = await createDraftInvoice(anOrder())

    expect(square.customers).toEqual([
      {
        id: expect.any(String),
        company_name: 'Dame',
        email_address: 'ap@dame.example',
        reference_id: 'portlandica:dame',
      },
    ])
    expect(square.orders).toHaveLength(1)
    expect(square.invoices).toHaveLength(1)
    expect(result).toEqual({
      squareInvoiceId: square.invoices[0].id,
      squareOrderId: square.orders[0].id,
      squareCustomerId: square.customers[0].id,
      status: 'DRAFT',
      dueDate: '2026-11-14',
      invoiceNumber: '0000001',
      unlinkedItems: [],
    })
  })

  it('sends the token, a pinned Square-Version and JSON to the sandbox', async () => {
    await createDraftInvoice(anOrder())

    for (const call of square.calls) {
      expect(call.url.origin).toBe('https://connect.squareupsandbox.com')
      expect(call.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      })
      expect(call.headers['Square-Version']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('uses the production host when SQUARE_ENVIRONMENT says so, ignoring stray whitespace', async () => {
    vi.stubEnv('SQUARE_ENVIRONMENT', ' production\n')

    await createDraftInvoice(anOrder())

    expect(square.calls[0].url.origin).toBe('https://connect.squareup.com')
  })

  it('creates the order at SQUARE_LOCATION_ID from Item Library items at their prices', async () => {
    await createDraftInvoice(anOrder({ lines: [still(6), sparkling(4)] }))

    expect(square.orders[0]).toMatchObject({
      location_id: 'LOCATION_1',
      reference_id: 'order-1001',
      customer_id: square.customers[0].id,
      total_money: { amount: 36000 },
    })
    expect(square.orders[0].line_items).toEqual([
      {
        uid: 'line-1',
        quantity: '6',
        catalog_object_id: STILL,
        name: '24 pack - Still',
        base_price_money: { amount: 3600, currency: 'USD' },
        total_money: { amount: 21600, currency: 'USD' },
      },
      {
        uid: 'line-2',
        quantity: '4',
        catalog_object_id: SPARKLING,
        name: '24 pack - Sparkling',
        base_price_money: { amount: 3600, currency: 'USD' },
        total_money: { amount: 14400, currency: 'USD' },
      },
    ])
    // The price comes from the Item Library, so the app sends none
    const sent = square.callsTo('POST', '/v2/orders')[0].body.order as { line_items: object[] }
    expect(sent.line_items[0]).not.toHaveProperty('base_price_money')
    expect(square.orders[0]).not.toHaveProperty('discounts')
  })

  it('counts the payment terms from the order date in Portland, not UTC', async () => {
    // 10:30pm on Oct 15 in Portland is already Oct 16 in UTC
    const result = await createDraftInvoice(
      anOrder({
        orderDate: new Date('2026-10-16T05:30:00Z'),
        customer: { name: 'Dame', email: 'ap@dame.example', paymentTermsDays: 65 },
      })
    )

    expect(result.dueDate).toBe('2026-12-19')
    expect(square.invoices[0].payment_requests).toEqual([
      { request_type: 'BALANCE', due_date: '2026-12-19', automatic_payment_source: 'NONE' },
    ])
  })

  it("never sets a due date before today at the Square location, which may not be Portland's", async () => {
    // 10:30pm on Oct 15 in Portland is already Oct 16 at a location set to UTC, like the sandbox's
    vi.setSystemTime(new Date('2026-10-16T05:30:00Z'))
    square.setLocationTimeZone('UTC')

    const result = await createDraftInvoice(
      anOrder({
        orderDate: new Date('2026-10-16T05:30:00Z'),
        customer: { name: 'Dame', paymentTermsDays: 0 },
      })
    )

    expect(result.dueDate).toBe('2026-10-16')
    expect(square.invoices[0].payment_requests).toEqual([
      { request_type: 'BALANCE', due_date: '2026-10-16', automatic_payment_source: 'NONE' },
    ])
    expect(square.callsTo('GET', '/v2/locations/LOCATION_1')).toHaveLength(1)
  })

  it('moves a due-on-receipt date to the day the order is retried', async () => {
    vi.setSystemTime(new Date('2026-10-18T18:00:00Z'))

    // Ordered on Oct 15, retried on Oct 18
    const result = await createDraftInvoice(
      anOrder({ customer: { name: 'Dame', paymentTermsDays: 0 } })
    )

    expect(result.dueDate).toBe('2026-10-18')
  })

  it('keeps the payment terms date while it is still ahead', async () => {
    vi.setSystemTime(new Date('2026-10-18T18:00:00Z'))

    // Net 30 from Oct 15
    expect((await createDraftInvoice(anOrder())).dueDate).toBe('2026-11-14')
  })

  it('counts from today when no order date is given', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T18:00:00Z'))

    const result = await createDraftInvoice(
      anOrder({ orderDate: undefined, customer: { name: 'Dame', paymentTermsDays: 0 } })
    )

    expect(result.dueDate).toBe('2026-10-15')
  })

  it('puts the title, message, service date and reminders on the invoice', async () => {
    await createDraftInvoice(
      anOrder({
        title: ' PO #40012345 ',
        message:
          'Portlandica, order of 10 cases of Still (240 cans total) @ $1.50/can for a total of $360.',
        serviceDate: '2026-10-14',
        invoiceNumber: 'Sysco_02',
        reminders: [
          { days: 0, message: 'Due today' },
          { days: 30, message: ' Really overdue ' },
        ],
        savePaymentMethod: true,
      })
    )

    expect(square.invoices[0]).toMatchObject({
      location_id: 'LOCATION_1',
      order_id: square.orders[0].id,
      primary_recipient: { customer_id: square.customers[0].id },
      title: 'PO #40012345',
      description:
        'Portlandica, order of 10 cases of Still (240 cans total) @ $1.50/can for a total of $360.',
      sale_or_service_date: '2026-10-14',
      invoice_number: 'Sysco_02',
      store_payment_method_enabled: true,
      delivery_method: 'EMAIL',
      accepted_payment_methods: {
        card: true,
        bank_account: true,
        square_gift_card: false,
        buy_now_pay_later: false,
        cash_app_pay: false,
      },
      payment_requests: [
        {
          request_type: 'BALANCE',
          due_date: '2026-11-14',
          automatic_payment_source: 'NONE',
          reminders: [
            { relative_scheduled_days: 0, message: 'Due today' },
            { relative_scheduled_days: 30, message: 'Really overdue' },
          ],
        },
      ],
    })
  })

  it('leaves out what it is not given', async () => {
    await createDraftInvoice(anOrder())

    for (const field of [
      'title',
      'description',
      'sale_or_service_date',
      'store_payment_method_enabled',
    ]) {
      expect(square.invoices[0]).not.toHaveProperty(field)
    }
    expect(square.invoices[0].payment_requests[0]).not.toHaveProperty('reminders')
    expect(square.invoices[0].invoice_number).toBe('0000001')
  })

  it('shares the invoice manually when the customer has no email', async () => {
    await createDraftInvoice(anOrder({ customer: { name: 'Dame', paymentTermsDays: 30 } }))

    expect(square.invoices[0].delivery_method).toBe('SHARE_MANUALLY')
  })

  it('uses the delivery method it is given', async () => {
    await createDraftInvoice(anOrder({ deliveryMethod: 'SHARE_MANUALLY' }))

    expect(square.invoices[0].delivery_method).toBe('SHARE_MANUALLY')
  })

  it('never publishes or sends the invoice', async () => {
    await createDraftInvoice(anOrder())
    await createDraftInvoice(
      anOrder({
        orderId: 'order-1002',
        customer: { name: 'Dame', squareCustomerId: square.customers[0].id, paymentTermsDays: 30 },
      })
    )

    expect(new Set(square.endpoints())).toEqual(
      new Set([
        'GET /v2/locations/:id',
        'GET /v2/customers/:id',
        'POST /v2/customers/search',
        'POST /v2/customers',
        'POST /v2/catalog/search',
        'POST /v2/orders/search',
        'POST /v2/orders/calculate',
        'POST /v2/orders',
        'POST /v2/invoices/search',
        'POST /v2/invoices',
      ])
    )
    expect(square.invoices.map((i) => i.status)).toEqual(['DRAFT', 'DRAFT'])
  })
})

describe('Item Library lines', () => {
  it('lists a line by name at its list price when the Item Library has no such item, and says so', async () => {
    const result = await createDraftInvoice(
      anOrder({ lines: [still(2), packs('24 pack - Mixed', 1, { listPriceCents: 3600 })] })
    )

    expect(result.unlinkedItems).toEqual(['24 pack - Mixed'])
    expect(square.orders[0].line_items[1]).toMatchObject({
      quantity: '1',
      name: '24 pack - Mixed',
      base_price_money: { amount: 3600 },
    })
    expect(square.orders[0].line_items[1]).not.toHaveProperty('catalog_object_id')
  })

  it('finds an item whatever its case and spacing', async () => {
    const result = await createDraftInvoice(
      anOrder({ lines: [still(1, { item: '24 PACK -  still' })] })
    )

    expect(result.unlinkedItems).toEqual([])
    expect(square.orders[0].line_items[0].catalog_object_id).toBe(STILL)
  })

  it('prices an item the Item Library prices at sale', async () => {
    const mixed = square.addItem('24 pack - Mixed', null)

    await createDraftInvoice(anOrder({ lines: [packs('24 pack - Mixed', 2)] }))

    expect(square.orders[0].line_items[0]).toMatchObject({
      catalog_object_id: mixed,
      base_price_money: { amount: 3600 },
    })
    expect(square.orders[0].total_money?.amount).toBe(7200)
  })

  it('bills a line that costs more than the Item Library price at its own price', async () => {
    await createDraftInvoice(anOrder({ lines: [still(2, { amountCents: 8000 })] }))

    expect(square.orders[0].line_items[0]).toMatchObject({
      catalog_object_id: STILL,
      base_price_money: { amount: 4000 },
    })
    expect(square.orders[0]).not.toHaveProperty('discounts')
    expect(square.orders[0].total_money?.amount).toBe(8000)
  })
})

describe('discounts', () => {
  const sentOrder = () =>
    square.callsTo('POST', '/v2/orders')[0].body.order as {
      line_items: { applied_discounts?: { discount_uid: string }[] }[]
      discounts?: object[]
    }

  it("takes off the customer's own discount from the Item Library", async () => {
    // Rose City's custom cans at 17.05% off $2.00, as Paul invoices them
    const rosecity = square.addDiscount('Rose City Discount', { percentage: '17.05' })
    square.addDiscount('The Birch Discount', { percentage: '12.5' })

    await createDraftInvoice(
      anOrder({
        customer: customerNamed('Rose City Cinema'),
        lines: [custom(34, { amountCents: 135374, discountName: 'Rose City Cinema Discount' })],
      })
    )

    expect(sentOrder().discounts).toEqual([
      { uid: 'discount-1', scope: 'LINE_ITEM', catalog_object_id: rosecity },
    ])
    expect(sentOrder().line_items[0].applied_discounts).toEqual([{ discount_uid: 'discount-1' }])
    expect(square.orders[0].line_items[0]).toMatchObject({
      catalog_object_id: CUSTOM,
      quantity: '34',
      base_price_money: { amount: 4800 },
    })
    expect(square.orders[0].total_money?.amount).toBe(135374)
  })

  it('takes one discount off every line at the special price', async () => {
    const pineStreet = square.addDiscount('Pine Street Discount', { percentage: '10.0' })

    await createDraftInvoice(
      anOrder({
        customer: customerNamed('Pine Street Jewelers (Eastside)'),
        lines: [still(6, { amountCents: 19440 }), sparkling(4, { amountCents: 12960 })],
      })
    )

    expect(sentOrder().discounts).toEqual([
      { uid: 'discount-1', scope: 'LINE_ITEM', catalog_object_id: pineStreet },
    ])
    expect(sentOrder().line_items.map((line) => line.applied_discounts)).toEqual([
      [{ discount_uid: 'discount-1' }],
      [{ discount_uid: 'discount-1' }],
    ])
    expect(square.orders[0].total_money?.amount).toBe(32400)
  })

  it('picks the discount whose name is most like the customer', async () => {
    square.addDiscount('The Birch Discount', { percentage: '12.5' })
    const alder = square.addDiscount('The Alder Discount', { percentage: '12.5' })

    await createDraftInvoice(
      anOrder({
        customer: customerNamed('The Alder Hotel Portland'),
        lines: [custom(20, { amountCents: 84000 })],
      })
    )

    expect(sentOrder().discounts).toEqual([
      { uid: 'discount-1', scope: 'LINE_ITEM', catalog_object_id: alder },
    ])
  })

  it("names the discount after the customer when the Item Library's don't fit", async () => {
    // Rose City's discount is 17.05%; this order is at $1.66 a can, 17% off
    square.addDiscount('Rose City Discount', { percentage: '17.05' })
    square.addDiscount('Taqueria Discount', { percentage: '12.5' })

    await createDraftInvoice(
      anOrder({
        customer: customerNamed('Rose City Cinema'),
        lines: [custom(34, { amountCents: 135456, discountName: 'Rose City Cinema Discount' })],
      })
    )

    expect(sentOrder().discounts).toEqual([
      {
        uid: 'discount-1',
        scope: 'LINE_ITEM',
        name: 'Rose City Cinema Discount',
        type: 'FIXED_PERCENTAGE',
        percentage: '17',
      },
    ])
    expect(square.orders[0].total_money?.amount).toBe(135456)
  })

  it('takes exact amounts off when no one percentage gives every line its price', async () => {
    // A typed total of $500 over 10 still and 5 sparkling packs
    await createDraftInvoice(
      anOrder({ lines: [still(10, { amountCents: 33334 }), sparkling(5, { amountCents: 16666 })] })
    )

    expect(sentOrder().discounts).toEqual([
      {
        uid: 'discount-1',
        scope: 'LINE_ITEM',
        name: 'Dame Discount',
        type: 'FIXED_AMOUNT',
        amount_money: { amount: 2666, currency: 'USD' },
      },
      {
        uid: 'discount-2',
        scope: 'LINE_ITEM',
        name: 'Dame Discount',
        type: 'FIXED_AMOUNT',
        amount_money: { amount: 1334, currency: 'USD' },
      },
    ])
    expect(square.orders[0].total_money?.amount).toBe(50000)
  })

  it("takes an amount off a part-filled pack, as the Item Library's Half Case Order when it fits", async () => {
    const halfCase = square.addDiscount('Half Case Order', { amountCents: 1800 })

    // 36 still cans: two packs, less half a pack
    await createDraftInvoice(
      anOrder({
        lines: [
          still(2, { amountCents: 5400, discountName: 'Half Case Order', discountAsAmount: true }),
          sparkling(2, {
            amountCents: 6000,
            discountName: 'Dame Discount',
            discountAsAmount: true,
          }),
        ],
      })
    )

    expect(sentOrder().discounts).toEqual([
      { uid: 'discount-1', scope: 'LINE_ITEM', catalog_object_id: halfCase },
      {
        uid: 'discount-2',
        scope: 'LINE_ITEM',
        name: 'Dame Discount',
        type: 'FIXED_AMOUNT',
        amount_money: { amount: 1200, currency: 'USD' },
      },
    ])
    expect(square.orders[0].total_money?.amount).toBe(11400)
  })

  it('takes exact amounts off instead when Square works a percentage out differently', async () => {
    square.addDiscount('Rose City Discount', { percentage: '17.05' })
    square.setPercentRounding(Math.floor)

    await createDraftInvoice(
      anOrder({
        customer: customerNamed('Rose City Cinema'),
        lines: [custom(34, { amountCents: 135374, discountName: 'Rose City Cinema Discount' })],
      })
    )

    expect(square.callsTo('POST', '/v2/orders/calculate')).toHaveLength(2)
    expect(sentOrder().discounts).toEqual([
      {
        uid: 'discount-1',
        scope: 'LINE_ITEM',
        name: 'Rose City Cinema Discount',
        type: 'FIXED_AMOUNT',
        amount_money: { amount: 27826, currency: 'USD' },
      },
    ])
    expect(square.orders[0].total_money?.amount).toBe(135374)
  })

  it("makes nothing when Square's total still isn't the app's", async () => {
    square.setTaxCents(100)

    await expect(createDraftInvoice(anOrder())).rejects.toThrow(
      'Square works this order out to $361.00, not the $360.00 the app booked, so no draft was made.'
    )
    expect(square.orders).toEqual([])
    expect(square.invoices).toEqual([])
  })

  it('looks up discounts only when a line needs one', async () => {
    await createDraftInvoice(anOrder())

    const searches = square.callsTo('POST', '/v2/catalog/search').map((c) => c.body.object_types)
    expect(searches).toEqual([['ITEM']])
  })
})

describe('invoice numbers', () => {
  const series = { invoiceNumber: { series: 'RoseCityCinema' } }

  it("carries on the customer's own series, keeping its zero padding", async () => {
    const rosecity = square.addCustomer({ company_name: 'Rose City Cinema' })
    square.addInvoice(rosecity.id, 'RoseCityCinema_076', 'PAID')
    square.addInvoice(rosecity.id, 'RoseCityCinema_077')

    const result = await createDraftInvoice(
      anOrder({
        ...series,
        customer: customerNamed('Rose City Cinema', { squareCustomerId: rosecity.id }),
      })
    )

    expect(result.invoiceNumber).toBe('RoseCityCinema_078')
    expect(square.invoices.at(-1)?.invoice_number).toBe('RoseCityCinema_078')
  })

  it('goes past the highest number in the series and follows the newest series', async () => {
    const ironwood = square.addCustomer({ company_name: 'Ironwood Coffee Company' })
    square.addInvoice(ironwood.id, 'Ironwood_120')
    square.addInvoice(ironwood.id, 'IronwoodCoffeeCo_34')
    square.addInvoice(ironwood.id, 'IronwoodCoffeeCo_9')
    // Square's own numbering, as on a draft the app made before
    square.addInvoice(ironwood.id, '0000019')

    const result = await createDraftInvoice(
      anOrder({
        invoiceNumber: { series: 'IronwoodCoffeeCompany' },
        customer: customerNamed('Ironwood Coffee Company', { squareCustomerId: ironwood.id }),
      })
    )

    expect(result.invoiceNumber).toBe('IronwoodCoffeeCo_35')
  })

  it('starts a series at 01 for a customer without numbered invoices', async () => {
    const result = await createDraftInvoice(
      anOrder({ invoiceNumber: { series: 'NorthgateApartments' } })
    )

    expect(result.invoiceNumber).toBe('NorthgateApartments_01')
  })

  it('moves on when the next number is taken, such as by another customer', async () => {
    const other = square.addCustomer({ company_name: 'Somebody else' })
    square.addInvoice(other.id, 'RoseCityCinema_01')
    square.addInvoice(other.id, 'RoseCityCinema_02')

    const result = await createDraftInvoice(anOrder(series))

    expect(result.invoiceNumber).toBe('RoseCityCinema_03')
    const keys = square.callsTo('POST', '/v2/invoices').map((c) => c.body.idempotency_key)
    expect(new Set(keys).size).toBe(3)
  })

  it('gives up after five taken numbers', async () => {
    const other = square.addCustomer({ company_name: 'Somebody else' })
    for (const n of ['01', '02', '03', '04', '05'])
      square.addInvoice(other.id, `RoseCityCinema_${n}`)

    await expect(createDraftInvoice(anOrder(series))).rejects.toThrow('already used')
    expect(square.callsTo('POST', '/v2/invoices')).toHaveLength(5)
  })

  it('does not change a number it was given', async () => {
    const other = square.addCustomer({ company_name: 'Somebody else' })
    square.addInvoice(other.id, 'Sysco_02')

    await expect(createDraftInvoice(anOrder({ invoiceNumber: 'Sysco_02' }))).rejects.toMatchObject({
      status: 400,
    })
    expect(square.callsTo('POST', '/v2/invoices')).toHaveLength(1)
  })

  it('keeps the number of a draft found again on a retry', async () => {
    const first = await createDraftInvoice(anOrder(series))
    const second = await createDraftInvoice(anOrder(series))

    expect(second.invoiceNumber).toBe(first.invoiceNumber)
    expect(square.invoices).toHaveLength(1)
  })
})

describe('finding the Square customer', () => {
  it('uses the saved Square customer id without searching', async () => {
    const saved = square.addCustomer({ company_name: 'Dame' })

    const result = await createDraftInvoice(
      anOrder({ customer: { name: 'Dame', squareCustomerId: saved.id, paymentTermsDays: 30 } })
    )

    expect(result.squareCustomerId).toBe(saved.id)
    expect(square.endpoints().filter((e) => e.includes('customers'))).toEqual([
      'GET /v2/customers/:id',
    ])
  })

  it('looks the customer up again when the saved id is gone from Square', async () => {
    const result = await createDraftInvoice(
      anOrder({
        customer: { name: 'Dame', squareCustomerId: 'MERGED_AWAY', paymentTermsDays: 30 },
      })
    )

    expect(square.customers).toHaveLength(1)
    expect(result.squareCustomerId).toBe(square.customers[0].id)
  })

  it('stops on other errors for the saved id instead of creating a customer', async () => {
    const saved = square.addCustomer({ company_name: 'Dame' })
    square.fail('GET', `/v2/customers/${saved.id}`, 401)

    await expect(
      createDraftInvoice(
        anOrder({ customer: { name: 'Dame', squareCustomerId: saved.id, paymentTermsDays: 30 } })
      )
    ).rejects.toMatchObject({ status: 401 })
    expect(square.customers).toHaveLength(1)
  })

  it('reuses a customer made in the Square Dashboard with the same email and name', async () => {
    const existing = square.addCustomer({ company_name: 'Dame', email_address: 'AP@dame.example' })

    const result = await createDraftInvoice(anOrder())

    expect(result.squareCustomerId).toBe(existing.id)
    expect(square.customers).toHaveLength(1)
  })

  it('does not reuse a different business that shares the email', async () => {
    square.addCustomer({ company_name: 'Other Cafe', email_address: 'ap@dame.example' })

    const result = await createDraftInvoice(anOrder())

    expect(square.customers.map((c) => c.company_name)).toEqual(['Other Cafe', 'Dame'])
    expect(result.squareCustomerId).toBe(square.customers[1].id)
  })

  it('matches names regardless of case and extra spaces', async () => {
    // Saved by hand in Square as a person's name; the app's copy has stray spaces
    const existing = square.addCustomer({
      given_name: 'Hotel',
      family_name: 'Vintage',
      email_address: 'ap@vintage.example',
    })

    const result = await createDraftInvoice(
      anOrder({
        customer: { name: 'hotel  vintage ', email: 'ap@vintage.example', paymentTermsDays: 30 },
      })
    )

    expect(result.squareCustomerId).toBe(existing.id)
    expect(square.customers).toHaveLength(1)
  })

  it('finds a customer it created earlier even without an email', async () => {
    const first = await createDraftInvoice(
      anOrder({ customer: { name: 'Dame', paymentTermsDays: 30 } })
    )
    const second = await createDraftInvoice(
      anOrder({ orderId: 'order-1002', customer: { name: ' DAME', paymentTermsDays: 30 } })
    )

    expect(second.squareCustomerId).toBe(first.squareCustomerId)
    expect(square.customers).toHaveLength(1)
  })

  it('pages through search results', async () => {
    square.setPageSize(1)
    square.addCustomer({ company_name: 'Other Cafe', email_address: 'ap@dame.example' })
    const dame = square.addCustomer({ company_name: 'Dame', email_address: 'ap@dame.example' })

    const result = await createDraftInvoice(anOrder())

    expect(result.squareCustomerId).toBe(dame.id)
    const cursors = square.callsTo('POST', '/v2/customers/search').map((c) => c.body.cursor)
    expect(cursors).toContain('1')
  })
})

describe('retries', () => {
  it('returns the same draft when called again for the same order', async () => {
    const first = await createDraftInvoice(anOrder())
    const creates = () =>
      square.endpoints().filter((e) => e.startsWith('POST') && !e.includes('search'))
    const createsBefore = creates().length

    const second = await createDraftInvoice(anOrder())

    expect(second).toEqual(first)
    expect(creates()).toHaveLength(createsBefore)
    expect([square.customers, square.orders, square.invoices].map((list) => list.length)).toEqual([
      1, 1, 1,
    ])
  })

  it('resends a write whose reply was lost with the same idempotency key', async () => {
    square.fail('POST', '/v2/invoices', 'lost-response')

    const result = await skippingDelays(() => createDraftInvoice(anOrder()))

    expect(result.status).toBe('DRAFT')
    expect(square.invoices).toHaveLength(1)
    const keys = square.callsTo('POST', '/v2/invoices').map((c) => c.body.idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(keys[0]).toMatch(/^portlandica-invoice-order-1001-[0-9a-f]{16}$/)
  })

  it.each([429, 500, 503])('retries a %i response', async (status) => {
    square.fail('POST', '/v2/orders', status)

    await skippingDelays(() => createDraftInvoice(anOrder()))

    expect(square.callsTo('POST', '/v2/orders')).toHaveLength(2)
    expect(square.orders).toHaveLength(1)
  })

  it('gives up after three attempts, and a later call reuses the order it made', async () => {
    square.fail('POST', '/v2/invoices', 500, 3)

    const failed = skippingDelays(() => createDraftInvoice(anOrder()))

    await expect(failed).rejects.toBeInstanceOf(SquareApiError)
    await expect(failed).rejects.toMatchObject({ status: 500 })
    expect(square.callsTo('POST', '/v2/invoices')).toHaveLength(3)
    expect(square.invoices).toHaveLength(0)

    const result = await createDraftInvoice(anOrder())

    expect(result.squareOrderId).toBe(square.orders[0].id)
    expect(square.orders).toHaveLength(1)
    expect(square.invoices).toHaveLength(1)
  })

  it('gives up after three network failures', async () => {
    square.fail('POST', '/v2/customers/search', 'network', 3)

    await expect(skippingDelays(() => createDraftInvoice(anOrder()))).rejects.toThrow(
      'Square POST /v2/customers/search failed: fetch failed'
    )
    expect(square.customers).toHaveLength(0)
  })

  it('finds the earlier draft after Square has forgotten the idempotency keys', async () => {
    const first = await createDraftInvoice(anOrder())
    square.forgetIdempotencyKeys()

    // A retry the next day would otherwise send a different due date
    const second = await createDraftInvoice(
      anOrder({ orderDate: new Date('2026-10-16T17:00:00Z') })
    )

    expect(second).toEqual(first)
    expect([square.customers, square.orders, square.invoices].map((list) => list.length)).toEqual([
      1, 1, 1,
    ])
  })

  it('makes the order and invoice again after the draft was deleted in Square', async () => {
    const first = await createDraftInvoice(anOrder())
    await deleteDraftInvoice(first.squareInvoiceId)

    const second = await createDraftInvoice(anOrder())

    expect(second.squareOrderId).not.toBe(first.squareOrderId)
    expect(square.orders.map((o) => o.state)).toEqual(['CANCELED', 'OPEN'])
    expect(square.invoices.map((i) => i.status)).toEqual(['DRAFT'])
  })

  it.each([400, 401, 403])('does not retry a %i response', async (status) => {
    square.fail('POST', '/v2/invoices', status)

    await expect(createDraftInvoice(anOrder())).rejects.toMatchObject({
      name: 'SquareApiError',
      status,
      errors: [expect.objectContaining({ code: ERROR_CODES[status] })],
    })
    expect(square.callsTo('POST', '/v2/invoices')).toHaveLength(1)
  })

  it("explains Square's errors in the message", async () => {
    square.fail('POST', '/v2/invoices', 400)

    await expect(createDraftInvoice(anOrder())).rejects.toThrow(
      'Square POST /v2/invoices failed (400): INVALID_VALUE: Fake Square says INVALID_VALUE'
    )
  })
})

describe('deleteDraftInvoice', () => {
  const draft = async () => (await createDraftInvoice(anOrder())).squareInvoiceId

  it('deletes a draft at its current version, which cancels its Square order', async () => {
    const id = await draft()
    const before = square.calls.length

    expect(await deleteDraftInvoice(id)).toEqual({ outcome: 'deleted' })
    expect(square.invoices).toEqual([])
    expect(square.orders[0].state).toBe('CANCELED')
    // Read first for the version, then delete exactly that version. Nothing else is called.
    expect(square.endpoints().slice(before)).toEqual([
      'GET /v2/invoices/:id',
      'DELETE /v2/invoices/:id',
    ])
    expect(square.calls.at(-1)!.url.searchParams.get('version')).toBe('0')
  })

  it('deletes the version Square has now when the draft was edited in the Dashboard', async () => {
    const id = await draft()
    square.editInvoice(id)
    square.editInvoice(id)

    expect(await deleteDraftInvoice(id)).toEqual({ outcome: 'deleted' })
    expect(square.callsTo('DELETE', `/v2/invoices/${id}`)[0].url.search).toBe('?version=2')
  })

  it.each(['UNPAID', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'CANCELED'])(
    'leaves a %s invoice alone and says what it is',
    async (status) => {
      const id = await draft()
      square.setInvoiceStatus(id, status)

      expect(await deleteDraftInvoice(id)).toEqual({ outcome: 'not_draft', status })
      expect(square.invoices.map((i) => i.status)).toEqual([status])
      expect(square.callsTo('DELETE', `/v2/invoices/${id}`)).toEqual([])
    }
  )

  it('leaves an invoice that was sent while it was being deleted', async () => {
    const id = await draft()
    // Someone sends the invoice from the Dashboard just after the app read it.
    const handle = square.fetch.getMockImplementation()!
    square.fetch.mockImplementationOnce(async (input, init) => {
      const response = await handle(input, init)
      square.setInvoiceStatus(id, 'UNPAID')
      return response
    })

    expect(await deleteDraftInvoice(id)).toEqual({ outcome: 'not_draft', status: 'UNPAID' })
    expect(square.invoices.map((i) => i.status)).toEqual(['UNPAID'])
  })

  it('says when Square has no such invoice', async () => {
    expect(await deleteDraftInvoice('INVOICE_GONE')).toEqual({ outcome: 'not_found' })
    expect(square.endpoints()).toEqual(['GET /v2/invoices/:id'])
  })

  it('counts a delete whose reply was lost as done', async () => {
    const id = await draft()
    square.fail('DELETE', `/v2/invoices/${id}`, 'lost-response')

    expect(await skippingDelays(() => deleteDraftInvoice(id))).toEqual({ outcome: 'deleted' })
    expect(square.invoices).toEqual([])
    // The retry found nothing left to delete.
    expect(square.callsTo('DELETE', `/v2/invoices/${id}`)).toHaveLength(2)
  })

  it('throws when Square refuses to delete a draft, leaving it in place', async () => {
    const id = await draft()
    square.fail('DELETE', `/v2/invoices/${id}`, 403)

    await expect(deleteDraftInvoice(id)).rejects.toMatchObject({
      name: 'SquareApiError',
      status: 403,
    })
    expect(square.invoices.map((i) => i.status)).toEqual(['DRAFT'])
  })

  it('needs an invoice id and the Square settings before calling Square', async () => {
    await expect(deleteDraftInvoice(' ')).rejects.toThrow('no Square invoice id')
    vi.stubEnv('SQUARE_ACCESS_TOKEN', '')
    await expect(deleteDraftInvoice('INVOICE_1')).rejects.toThrow(
      'Missing Square env vars: SQUARE_ACCESS_TOKEN'
    )
    expect(square.fetch).not.toHaveBeenCalled()
  })
})

describe('input checks', () => {
  it.each([
    ['no lines', anOrder({ lines: [] }), 'at least one line'],
    ['a line without an item', anOrder({ lines: [still(1, { item: ' ' })] }), 'needs an item name'],
    ['part of a pack', anOrder({ lines: [still(1.5)] }), 'quantity must be a whole number'],
    ['no packs', anOrder({ lines: [still(0)] }), 'quantity must be a whole number'],
    [
      'fractions of a cent',
      anOrder({ lines: [still(1, { amountCents: 3600.5 })] }),
      'amount must be whole cents',
    ],
    [
      'a negative amount',
      anOrder({ lines: [still(1, { amountCents: -1 })] }),
      'amount must be whole cents',
    ],
    [
      'no list price',
      anOrder({ lines: [still(1, { listPriceCents: 0 })] }),
      'list price must be whole cents',
    ],
    [
      'no name for the discount',
      anOrder({ lines: [still(1, { discountName: '' })] }),
      'needs a name for its discount',
    ],
    ['a $0 total', anOrder({ lines: [still(1, { amountCents: 0 })] }), 'more than $0'],
    ['an order id over 40 characters', anOrder({ orderId: 'x'.repeat(41) }), 'orderId'],
    ['a blank order id', anOrder({ orderId: ' ' }), 'orderId'],
    [
      'negative payment terms',
      anOrder({ customer: { name: 'Dame', paymentTermsDays: -1 } }),
      'paymentTermsDays',
    ],
    [
      'a customer without a name',
      anOrder({ customer: { name: '', paymentTermsDays: 30 } }),
      'needs a name',
    ],
    ['an invalid order date', anOrder({ orderDate: new Date('not a date') }), 'orderDate'],
    ['a title over 255 characters', anOrder({ title: 'x'.repeat(256) }), 'over 255 characters'],
    ['a service date that is not a date', anOrder({ serviceDate: '10/14/2026' }), 'YYYY-MM-DD'],
    [
      'an invoice number over 191 characters',
      anOrder({ invoiceNumber: 'x'.repeat(192) }),
      '1 to 191',
    ],
    ['a blank series', anOrder({ invoiceNumber: { series: ' ' } }), 'series must be 1 to 180'],
    [
      'six reminders',
      anOrder({ reminders: [0, 1, 2, 3, 4, 5].map((days) => ({ days, message: 'Due' })) }),
      'at most 5 reminders',
    ],
    [
      'a reminder without a message',
      anOrder({ reminders: [{ days: 0, message: ' ' }] }),
      'needs a message',
    ],
    [
      'a reminder part of a day out',
      anOrder({ reminders: [{ days: 1.5, message: 'Due' }] }),
      'whole number',
    ],
  ])('rejects %s before calling Square', async (_, input, message) => {
    await expect(createDraftInvoice(input)).rejects.toThrow(message)
    expect(square.fetch).not.toHaveBeenCalled()
  })

  it('names every missing env var', async () => {
    vi.stubEnv('SQUARE_ACCESS_TOKEN', '')
    vi.stubEnv('SQUARE_LOCATION_ID', '')

    await expect(createDraftInvoice(anOrder())).rejects.toThrow(
      'Missing Square env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID'
    )
    expect(square.fetch).not.toHaveBeenCalled()
  })

  it('only accepts sandbox or production', async () => {
    vi.stubEnv('SQUARE_ENVIRONMENT', 'live')

    await expect(createDraftInvoice(anOrder())).rejects.toThrow(
      "SQUARE_ENVIRONMENT must be 'sandbox' or 'production', not 'live'"
    )
    expect(square.fetch).not.toHaveBeenCalled()
  })
})
