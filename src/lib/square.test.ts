// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDraftInvoice, SquareApiError, type DraftInvoiceInput } from './square'

type LineItem = {
  name: string
  quantity: string
  base_price_money: { amount: number; currency: string }
}
type Customer = {
  id: string
  company_name?: string
  given_name?: string
  family_name?: string
  email_address?: string
  reference_id?: string
}
type Order = {
  id: string
  location_id: string
  customer_id?: string
  reference_id?: string
  state: string
  line_items: LineItem[]
}
type Invoice = {
  id: string
  location_id: string
  order_id: string
  status: string
  invoice_number: string
  primary_recipient: { customer_id: string }
  payment_requests: unknown[]
  delivery_method: string
  title?: string
  description?: string
}
type Call = {
  method: string
  url: URL
  headers: Record<string, string>
  body: Record<string, unknown>
}
type SearchRequest = {
  cursor?: string
  limit?: number
  location_ids?: string[]
  query?: {
    filter?: {
      email_address?: { exact?: string }
      reference_id?: { exact?: string }
      customer_filter?: { customer_ids?: string[] }
      state_filter?: { states?: string[] }
      location_ids?: string[]
      customer_ids?: string[]
    }
  }
}
type Failure = number | 'network' | 'lost-response'

const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_VALUE',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
}

/**
 * An in-memory stand-in for the Square endpoints square.ts uses. Like Square,
 * it replays the first response for a repeated idempotency key, rejects a key
 * reused for a different request, and allows one invoice per order. That lets
 * these tests check that retries never make a second customer, order or
 * invoice.
 */
const createFakeSquare = () => {
  const customers: Customer[] = []
  const orders: Order[] = []
  const invoices: Invoice[] = []
  const calls: Call[] = []
  const replays = new Map<string, { request: string; response: object }>()
  const failures: { method: string; path: string; failure: Failure }[] = []
  let lastId = 0
  let pageSize = 100

  const nextId = (prefix: string) => `${prefix}_${++lastId}`

  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  const error = (status: number, code = ERROR_CODES[status]) =>
    json(status, { errors: [{ category: 'API_ERROR', code, detail: `Fake Square says ${code}` }] })

  const page = (key: string, items: object[], { cursor, limit = 100 }: SearchRequest) => {
    const start = Number(cursor ?? 0)
    const end = start + Math.min(limit, pageSize)
    return json(200, {
      [key]: items.slice(start, end),
      ...(end < items.length && { cursor: String(end) }),
    })
  }

  const idempotent = (body: Record<string, unknown>, create: () => object | Response) => {
    const { idempotency_key: key, ...request } = body
    const seen = replays.get(String(key))
    if (seen) {
      return seen.request === JSON.stringify(request)
        ? json(200, seen.response)
        : error(400, 'IDEMPOTENCY_KEY_REUSED')
    }
    const response = create()
    if (response instanceof Response) return response
    replays.set(String(key), { request: JSON.stringify(request), response })
    return json(200, response)
  }

  const handle = ({ method, url, body }: Call): Response => {
    const search = body as SearchRequest
    const filter = search.query?.filter ?? {}

    if (method === 'GET' && url.pathname.startsWith('/v2/customers/')) {
      const id = decodeURIComponent(url.pathname.slice('/v2/customers/'.length))
      const customer = customers.find((c) => c.id === id)
      return customer ? json(200, { customer }) : error(404, 'NOT_FOUND')
    }

    switch (`${method} ${url.pathname}`) {
      case 'POST /v2/customers/search': {
        const email = filter.email_address?.exact?.toLowerCase()
        const referenceId = filter.reference_id?.exact?.toLowerCase()
        const found = customers.filter(
          (c) =>
            (!email || c.email_address?.toLowerCase() === email) &&
            (!referenceId || c.reference_id?.toLowerCase() === referenceId)
        )
        return page('customers', found, search)
      }
      case 'POST /v2/customers':
        return idempotent(body, () => {
          const { company_name, email_address, reference_id } = body as Omit<Customer, 'id'>
          const customer = { id: nextId('CUSTOMER'), company_name, email_address, reference_id }
          customers.push(customer)
          return { customer }
        })
      case 'POST /v2/orders/search': {
        const customerIds = filter.customer_filter?.customer_ids
        const states = filter.state_filter?.states
        const found = orders.filter(
          (o) =>
            search.location_ids?.includes(o.location_id) &&
            (!customerIds || customerIds.includes(o.customer_id ?? '')) &&
            (!states || states.includes(o.state))
        )
        return page('orders', found.reverse(), search)
      }
      case 'POST /v2/orders':
        return idempotent(body, () => {
          const order = {
            ...(body.order as Omit<Order, 'id' | 'state'>),
            id: nextId('ORDER'),
            state: 'OPEN',
          }
          orders.push(order)
          return { order }
        })
      case 'POST /v2/invoices/search': {
        const [locationId] = filter.location_ids ?? []
        const found = invoices.filter(
          (i) =>
            i.location_id === locationId &&
            (!filter.customer_ids || filter.customer_ids.includes(i.primary_recipient.customer_id))
        )
        return page('invoices', found.reverse(), search)
      }
      case 'POST /v2/invoices':
        return idempotent(body, () => {
          const fields = body.invoice as Omit<Invoice, 'id' | 'status' | 'invoice_number'> & {
            invoice_number?: string
          }
          const order = orders.find((o) => o.id === fields.order_id)
          if (!order || order.state !== 'OPEN') return error(400, 'INVALID_VALUE')
          if (invoices.some((i) => i.order_id === order.id)) return error(400, 'BAD_REQUEST')
          const invoice = {
            ...fields,
            // Square numbers invoices from 1, padded to 7 digits
            invoice_number: fields.invoice_number ?? String(invoices.length + 1).padStart(7, '0'),
            id: nextId('INVOICE'),
            status: 'DRAFT',
          }
          invoices.push(invoice)
          return { invoice }
        })
    }
    return error(404, 'NOT_FOUND')
  }

  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : {},
    }
    calls.push(call)

    const index = failures.findIndex(
      (f) => f.method === call.method && f.path === call.url.pathname
    )
    if (index === -1) return handle(call)
    const [{ failure }] = failures.splice(index, 1)
    // Square did the work, but the reply never reached us
    if (failure === 'lost-response') handle(call)
    if (typeof failure !== 'number') throw new TypeError('fetch failed')
    return error(failure)
  })

  return {
    customers,
    orders,
    invoices,
    calls,
    fetch,
    /** Make the next request(s) to this endpoint fail */
    fail: (method: string, path: string, failure: Failure, times = 1) => {
      for (let i = 0; i < times; i++) failures.push({ method, path, failure })
    },
    addCustomer: (fields: Omit<Customer, 'id'>) => {
      const customer = { id: nextId('CUSTOMER'), ...fields }
      customers.push(customer)
      return customer
    },
    forgetIdempotencyKeys: () => replays.clear(),
    setPageSize: (size: number) => {
      pageSize = size
    },
    /** Requests made, as 'METHOD /path' with customer ids masked */
    endpoints: () =>
      calls.map(
        (c) =>
          `${c.method} ${c.url.pathname.replace(/^\/v2\/customers\/(?!search$).+/, '/v2/customers/:id')}`
      ),
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.url.pathname === path),
  }
}

let square: ReturnType<typeof createFakeSquare>

beforeEach(() => {
  vi.stubEnv('SQUARE_ACCESS_TOKEN', 'test-token')
  vi.stubEnv('SQUARE_LOCATION_ID', 'LOCATION_1')
  vi.stubEnv('SQUARE_ENVIRONMENT', 'sandbox')
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
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  let settled = false
  const outcome = run().finally(() => {
    settled = true
  })
  outcome.catch(() => {}) // the caller handles it
  while (!settled) await vi.advanceTimersToNextTimerAsync()
  vi.useRealTimers()
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
    const createsBefore = square.endpoints().filter((e) => !e.includes('search')).length

    const second = await createDraftInvoice(anOrder())

    expect(second).toEqual(first)
    expect(square.endpoints().filter((e) => !e.includes('search'))).toHaveLength(createsBefore)
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
