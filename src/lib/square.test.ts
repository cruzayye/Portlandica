// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDraftInvoice,
  deleteDraftInvoice,
  SquareApiError,
  type DraftInvoiceInput,
} from './square'
import { ERROR_CODES, createFakeSquare, type FakeSquare } from './testing/fakeSquare'

let square: FakeSquare

beforeEach(() => {
  vi.stubEnv('SQUARE_ACCESS_TOKEN', 'test-token')
  vi.stubEnv('SQUARE_LOCATION_ID', 'LOCATION_1')
  vi.stubEnv('SQUARE_ENVIRONMENT', 'sandbox')
  // Due dates are never before today, so the tests' today is fixed: Oct 15 in Portland
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T18:00:00Z') })
  square = createFakeSquare()
  vi.stubGlobal('fetch', square.fetch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const anOrder = (overrides: Partial<DraftInvoiceInput> = {}): DraftInvoiceInput => ({
  orderId: 'order-1001',
  customer: { name: 'Dame', email: 'ap@dame.example', paymentTermsDays: 30 },
  lines: [{ name: 'Still Cans', cans: 240, unitPrice: 1.5 }],
  orderDate: new Date('2026-10-15T17:00:00Z'),
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

    expect(result).toEqual({
      squareInvoiceId: 'INVOICE_3',
      squareOrderId: 'ORDER_2',
      squareCustomerId: 'CUSTOMER_1',
      status: 'DRAFT',
      dueDate: '2026-11-14',
      invoiceNumber: '0000001',
    })
    expect(square.customers).toEqual([
      {
        id: 'CUSTOMER_1',
        company_name: 'Dame',
        email_address: 'ap@dame.example',
        reference_id: 'portlandica:dame',
      },
    ])
    expect(square.orders).toHaveLength(1)
    expect(square.invoices).toHaveLength(1)
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

  it('creates the order at SQUARE_LOCATION_ID with prices in cents', async () => {
    await createDraftInvoice(
      anOrder({
        lines: [
          { name: 'Still Cans', cans: 240, unitPrice: 1.5 },
          { name: 'Sparkling Cans', cans: 48, unitPrice: 1.15 },
        ],
      })
    )

    expect(square.orders[0]).toMatchObject({
      location_id: 'LOCATION_1',
      reference_id: 'order-1001',
      customer_id: 'CUSTOMER_1',
      line_items: [
        { name: 'Still Cans', quantity: '240', base_price_money: { amount: 150, currency: 'USD' } },
        // 1.15 * 100 is 114.99999999999999 in floating point
        {
          name: 'Sparkling Cans',
          quantity: '48',
          base_price_money: { amount: 115, currency: 'USD' },
        },
      ],
    })
  })

  it('bills by the case when the line has a case size', async () => {
    await createDraftInvoice(
      anOrder({
        lines: [{ name: 'Still Water 24/12oz', cans: 1440, unitPrice: 1.5, caseSize: 24 }],
      })
    )

    expect(square.orders[0].line_items).toEqual([
      {
        name: 'Still Water 24/12oz',
        quantity: '60',
        base_price_money: { amount: 3600, currency: 'USD' },
      },
    ])
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
    const result = await createDraftInvoice(anOrder({ customer: { name: 'Dame', paymentTermsDays: 0 } }))

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

  it('puts the PO, note and remit-to on the invoice', async () => {
    await createDraftInvoice(
      anOrder({
        customer: {
          name: 'Example Foods Northwest, Inc.',
          email: 'owner@portlandica.example',
          paymentTermsDays: 65,
        },
        poNumber: ' 40012345 ',
        note: 'Picked up at the co-packer',
        remitTo: 'Example Water LLC, PO Box 100, Portland, OR 97208',
        invoiceNumber: 'EXAMPLE_02',
      })
    )

    expect(square.invoices[0]).toMatchObject({
      location_id: 'LOCATION_1',
      order_id: 'ORDER_2',
      primary_recipient: { customer_id: 'CUSTOMER_1' },
      title: 'PO 40012345',
      description:
        'PO 40012345\nPicked up at the co-packer\nRemit to: Example Water LLC, PO Box 100, Portland, OR 97208',
      invoice_number: 'EXAMPLE_02',
      delivery_method: 'EMAIL',
      accepted_payment_methods: {
        card: true,
        bank_account: true,
        square_gift_card: false,
        buy_now_pay_later: false,
        cash_app_pay: false,
      },
    })
    expect(square.customers[0].company_name).toBe('Example Foods Northwest, Inc.')
  })

  it('leaves out the title and description when there is nothing to show', async () => {
    await createDraftInvoice(anOrder())

    expect(square.invoices[0]).not.toHaveProperty('title')
    expect(square.invoices[0]).not.toHaveProperty('description')
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
        customer: { name: 'Dame', squareCustomerId: 'CUSTOMER_1', paymentTermsDays: 30 },
      })
    )

    expect(new Set(square.endpoints())).toEqual(
      new Set([
        'GET /v2/locations/:id',
        'GET /v2/customers/:id',
        'POST /v2/customers/search',
        'POST /v2/customers',
        'POST /v2/orders/search',
        'POST /v2/orders',
        'POST /v2/invoices/search',
        'POST /v2/invoices',
      ])
    )
    expect(square.invoices.map((i) => i.status)).toEqual(['DRAFT', 'DRAFT'])
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

    expect(result.squareCustomerId).toBe('CUSTOMER_1')
    expect(square.customers).toHaveLength(1)
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

    expect(result.squareCustomerId).toBe('CUSTOMER_2')
    expect(square.customers.map((c) => c.company_name)).toEqual(['Other Cafe', 'Dame'])
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
    const creates = () => square.endpoints().filter((e) => e.startsWith('POST') && !e.includes('search'))
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
    expect(keys).toEqual(['portlandica-invoice-order-1001', 'portlandica-invoice-order-1001'])
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
    [
      'a price with fractions of a cent',
      anOrder({ lines: [{ name: 'Still Cans', cans: 240, unitPrice: 1.505 }] }),
      'not a whole number of cents',
    ],
    [
      'part of a can',
      anOrder({ lines: [{ name: 'Still Cans', cans: 2.5, unitPrice: 1.5 }] }),
      'cans must be a whole number',
    ],
    [
      'zero cans',
      anOrder({ lines: [{ name: 'Still Cans', cans: 0, unitPrice: 1.5 }] }),
      'cans must be a whole number',
    ],
    [
      'cans that are not whole cases',
      anOrder({ lines: [{ name: 'Still Cans', cans: 100, unitPrice: 1.5, caseSize: 24 }] }),
      "don't make whole cases",
    ],
    [
      'a $0 total',
      anOrder({ lines: [{ name: 'Still Cans', cans: 24, unitPrice: 0 }] }),
      'more than $0',
    ],
    [
      'a missing product name',
      anOrder({ lines: [{ name: ' ', cans: 24, unitPrice: 1.5 }] }),
      'needs a product name',
    ],
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
