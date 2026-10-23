import { vi } from 'vitest'

// An in-memory stand-in for the Square endpoints src/lib/square.ts uses. Like Square, it
// replays the first response for a repeated idempotency key, rejects a key reused for a
// different request, allows one invoice per order and one invoice number per location,
// keeps a version on every invoice, deletes only drafts (cancelling the invoice's order),
// and prices orders from its Item Library: whole quantities only, a line's percentage
// discount rounded to the cent, an amount discount taken once per line. That lets the
// tests check that retries never make a second customer, order or invoice, that a void
// only ever deletes a draft, and what a draft adds up to. Install it with
// vi.stubGlobal('fetch', square.fetch).

type Money = { amount: number; currency: string }

export type FakeLineItem = {
  uid?: string
  quantity: string
  catalog_object_id?: string
  name?: string
  base_price_money?: Money
  applied_discounts?: { discount_uid: string }[]
  /** Filled in by the fake, as Square does */
  total_money?: Money
}
export type FakeDiscount = {
  uid: string
  scope: string
  catalog_object_id?: string
  name?: string
  type?: string
  percentage?: string
  amount_money?: Money
}
export type FakeCatalogObject = {
  id: string
  type: 'ITEM' | 'DISCOUNT'
  item_data?: {
    name: string
    variations: { id: string; item_variation_data: { price_money?: Money } }[]
  }
  discount_data?: {
    name: string
    discount_type: 'FIXED_PERCENTAGE' | 'FIXED_AMOUNT'
    percentage?: string
    amount_money?: Money
  }
}
export type FakeCustomer = {
  id: string
  company_name?: string
  given_name?: string
  family_name?: string
  email_address?: string
  reference_id?: string
}
export type FakeOrder = {
  id: string
  location_id: string
  customer_id?: string
  reference_id?: string
  state: string
  line_items: FakeLineItem[]
  discounts?: FakeDiscount[]
  total_money?: Money
}
export type FakeInvoice = {
  id: string
  version: number
  location_id: string
  order_id: string
  status: string
  invoice_number: string
  primary_recipient: { customer_id: string }
  payment_requests: unknown[]
  delivery_method: string
  title?: string
  description?: string
  sale_or_service_date?: string
  store_payment_method_enabled?: boolean
}
export type FakeCall = {
  method: string
  url: URL
  headers: Record<string, string>
  body: Record<string, unknown>
}
type SearchRequest = {
  cursor?: string
  limit?: number
  location_ids?: string[]
  object_types?: string[]
  query?: {
    prefix_query?: { attribute_name: string; attribute_prefix: string }
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
/** An HTTP status to answer with, a request that never gets through, or a lost reply. */
export type FakeFailure = number | 'network' | 'lost-response'

export const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_VALUE',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
}

const INVOICE_PATH = /^\/v2\/invoices\/(?!search$)(.+)$/

export const createFakeSquare = () => {
  const customers: FakeCustomer[] = []
  const orders: FakeOrder[] = []
  const invoices: FakeInvoice[] = []
  const catalog: FakeCatalogObject[] = []
  const calls: FakeCall[] = []
  const replays = new Map<string, { request: string; response: object }>()
  const failures: { method: string; path: string; failure: FakeFailure }[] = []
  let lastId = 0
  let pageSize = 100
  let locationTimeZone = 'America/Los_Angeles'
  let roundPercentDiscount = Math.round
  let taxCents = 0

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

  const invalid = (field: string, detail: string) =>
    json(400, {
      errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'INVALID_VALUE', field, detail }],
    })

  const variationById = (id: string) => {
    for (const object of catalog) {
      const variation = object.item_data?.variations.find((v) => v.id === id)
      if (variation)
        return { name: object.item_data!.name, price: variation.item_variation_data.price_money }
    }
    return null
  }

  /** The order as Square prices it, or an error Response for what Square would refuse. */
  const priceOrder = (
    order: Omit<FakeOrder, 'id' | 'state'>
  ): Omit<FakeOrder, 'id' | 'state'> | Response => {
    const discounts = new Map<string, FakeDiscount>()
    for (const discount of order.discounts ?? []) {
      const own = discount.catalog_object_id
        ? catalog.find((o) => o.id === discount.catalog_object_id)?.discount_data
        : null
      if (discount.catalog_object_id && !own) return invalid('order.discounts', 'No such discount')
      discounts.set(
        discount.uid,
        own
          ? {
              ...discount,
              name: own.name,
              type: own.discount_type,
              percentage: own.percentage,
              amount_money: own.amount_money,
            }
          : discount
      )
    }
    let total = 0
    const lineItems: FakeLineItem[] = []
    for (const line of order.line_items) {
      const variation = line.catalog_object_id ? variationById(line.catalog_object_id) : null
      if (line.catalog_object_id && !variation) return invalid('order.line_items', 'No such item')
      const price = line.base_price_money?.amount ?? variation?.price?.amount
      if (price === undefined) return invalid('order.line_items', 'The line has no price')
      const quantity = Number(line.quantity)
      if (!Number.isInteger(quantity)) {
        return invalid(
          'order.line_items[0].quantity',
          'Line items with non-integer quantities must specify a `quantity_unit`.'
        )
      }
      const gross = price * quantity
      const off = (line.applied_discounts ?? []).reduce((sum, { discount_uid }) => {
        const discount = discounts.get(discount_uid)
        if (!discount) return sum
        return (
          sum +
          (discount.type === 'FIXED_PERCENTAGE'
            ? roundPercentDiscount((gross * Number(discount.percentage)) / 100)
            : (discount.amount_money?.amount ?? 0))
        )
      }, 0)
      total += gross - off
      lineItems.push({
        ...line,
        name: line.name ?? variation?.name,
        base_price_money: { amount: price, currency: 'USD' },
        total_money: { amount: gross - off, currency: 'USD' },
      })
    }
    return {
      ...order,
      line_items: lineItems,
      ...(order.discounts && { discounts: [...discounts.values()] }),
      total_money: { amount: total + taxCents, currency: 'USD' },
    }
  }

  const findInvoice = (id: string) => {
    const invoice = invoices.find((i) => i.id === id)
    if (!invoice) throw new Error(`fakeSquare: no invoice ${id}`)
    return invoice
  }

  // GetInvoice and DeleteInvoice. Square deletes only drafts, at their current version,
  // and sets the invoice's order to CANCELED.
  const invoiceById = (method: string, url: URL, id: string): Response => {
    const invoice = invoices.find((i) => i.id === id)
    if (!invoice) return error(404, 'NOT_FOUND')
    if (method === 'GET') return json(200, { invoice })
    const version = url.searchParams.get('version')
    if (version !== null && Number(version) !== invoice.version) {
      return error(400, 'VERSION_MISMATCH')
    }
    if (invoice.status !== 'DRAFT') return error(400, 'BAD_REQUEST')
    invoices.splice(invoices.indexOf(invoice), 1)
    const order = orders.find((o) => o.id === invoice.order_id)
    if (order) order.state = 'CANCELED'
    return json(200, {})
  }

  const handle = ({ method, url, body }: FakeCall): Response => {
    const search = body as SearchRequest
    const filter = search.query?.filter ?? {}

    if (method === 'GET' && url.pathname.startsWith('/v2/locations/')) {
      const id = decodeURIComponent(url.pathname.slice('/v2/locations/'.length))
      return json(200, { location: { id, timezone: locationTimeZone } })
    }

    if (method === 'GET' && url.pathname.startsWith('/v2/customers/')) {
      const id = decodeURIComponent(url.pathname.slice('/v2/customers/'.length))
      const customer = customers.find((c) => c.id === id)
      return customer ? json(200, { customer }) : error(404, 'NOT_FOUND')
    }

    const invoicePath = INVOICE_PATH.exec(url.pathname)
    if (invoicePath && (method === 'GET' || method === 'DELETE')) {
      return invoiceById(method, url, decodeURIComponent(invoicePath[1]))
    }

    switch (`${method} ${url.pathname}`) {
      case 'POST /v2/catalog/search': {
        const prefix = search.query?.prefix_query?.attribute_prefix?.toLowerCase()
        const found = catalog.filter(
          (o) =>
            search.object_types?.includes(o.type) &&
            (!prefix ||
              (o.item_data?.name ?? o.discount_data?.name ?? '').toLowerCase().startsWith(prefix))
        )
        return page('objects', found, search)
      }
      case 'POST /v2/orders/calculate': {
        const priced = priceOrder(body.order as Omit<FakeOrder, 'id' | 'state'>)
        return priced instanceof Response ? priced : json(200, { order: priced })
      }
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
          const { company_name, email_address, reference_id } = body as Omit<FakeCustomer, 'id'>
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
          const priced = priceOrder(body.order as Omit<FakeOrder, 'id' | 'state'>)
          if (priced instanceof Response) return priced
          const order = { ...priced, id: nextId('ORDER'), state: 'OPEN' }
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
          const fields = body.invoice as Omit<
            FakeInvoice,
            'id' | 'version' | 'status' | 'invoice_number'
          > & {
            invoice_number?: string
          }
          const order = orders.find((o) => o.id === fields.order_id)
          if (!order || order.state !== 'OPEN') return error(400, 'INVALID_VALUE')
          if (invoices.some((i) => i.order_id === order.id)) return error(400, 'BAD_REQUEST')
          const number = fields.invoice_number
          if (
            number &&
            invoices.some(
              (i) => i.location_id === fields.location_id && i.invoice_number === number
            )
          ) {
            return invalid(
              'invoice.invoice_number',
              'This invoice number is already used at this location and must be unique'
            )
          }
          const invoice = {
            ...fields,
            // Square numbers invoices from 1, padded to 7 digits
            invoice_number: fields.invoice_number ?? String(invoices.length + 1).padStart(7, '0'),
            id: nextId('INVOICE'),
            version: 0,
            status: 'DRAFT',
          }
          invoices.push(invoice)
          return { invoice }
        })
    }
    return error(404, 'NOT_FOUND')
  }

  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: FakeCall = {
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
    catalog,
    calls,
    fetch,
    /** Make the next request(s) to this endpoint fail */
    fail: (method: string, path: string, failure: FakeFailure, times = 1) => {
      for (let i = 0; i < times; i++) failures.push({ method, path, failure })
    },
    addCustomer: (fields: Omit<FakeCustomer, 'id'>) => {
      const customer = { id: nextId('CUSTOMER'), ...fields }
      customers.push(customer)
      return customer
    },
    /** An item in the Item Library with one variation at this price (null: priced at sale). */
    addItem: (name: string, priceCents: number | null) => {
      const variationId = nextId('VARIATION')
      catalog.push({
        id: nextId('ITEM'),
        type: 'ITEM',
        item_data: {
          name,
          variations: [
            {
              id: variationId,
              item_variation_data:
                priceCents === null ? {} : { price_money: { amount: priceCents, currency: 'USD' } },
            },
          ],
        },
      })
      return variationId
    },
    /** A discount in the Item Library: a percentage ('17.05') or an amount in cents. */
    addDiscount: (name: string, value: { percentage: string } | { amountCents: number }) => {
      const id = nextId('DISCOUNT')
      catalog.push({
        id,
        type: 'DISCOUNT',
        discount_data:
          'percentage' in value
            ? { name, discount_type: 'FIXED_PERCENTAGE', percentage: value.percentage }
            : {
                name,
                discount_type: 'FIXED_AMOUNT',
                amount_money: { amount: value.amountCents, currency: 'USD' },
              },
      })
      return id
    },
    /** An invoice made by hand in the Square Dashboard, on an order of its own. */
    addInvoice: (customerId: string, invoiceNumber: string, status = 'UNPAID') => {
      const order = {
        id: nextId('ORDER'),
        location_id: 'LOCATION_1',
        customer_id: customerId,
        state: 'OPEN',
        line_items: [],
      }
      orders.push(order)
      const invoice = {
        id: nextId('INVOICE'),
        version: 1,
        location_id: 'LOCATION_1',
        order_id: order.id,
        status,
        invoice_number: invoiceNumber,
        primary_recipient: { customer_id: customerId },
        payment_requests: [],
        delivery_method: 'EMAIL',
      }
      invoices.push(invoice)
      return invoice
    },
    /** Round percentage discounts some other way than to the nearest cent. */
    setPercentRounding: (round: (cents: number) => number) => {
      roundPercentDiscount = round
    },
    /** Something Square adds to every order total that the app doesn't know about, like a tax. */
    setTaxCents: (cents: number) => {
      taxCents = cents
    },
    /**
     * What happens to an invoice in the Square Dashboard: sending it (UNPAID), a payment
     * (PAID) and so on. Each change is a new version, as in Square.
     */
    setInvoiceStatus: (id: string, status: string) => {
      const invoice = findInvoice(id)
      invoice.status = status
      invoice.version += 1
    },
    /** Someone edits a draft in the Dashboard: same status, a new version. */
    editInvoice: (id: string) => {
      findInvoice(id).version += 1
    },
    forgetIdempotencyKeys: () => replays.clear(),
    setPageSize: (size: number) => {
      pageSize = size
    },
    /** The location's time zone, which Square counts "today" in (the sandbox's is UTC) */
    setLocationTimeZone: (timeZone: string) => {
      locationTimeZone = timeZone
    },
    /** Requests made, as 'METHOD /path' with customer and invoice ids masked */
    endpoints: () =>
      calls.map(
        (c) =>
          `${c.method} ${c.url.pathname
            .replace(/^\/v2\/customers\/(?!search$).+/, '/v2/customers/:id')
            .replace(/^\/v2\/locations\/.+/, '/v2/locations/:id')
            .replace(INVOICE_PATH, '/v2/invoices/:id')}`
      ),
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.url.pathname === path),
  }
}

export type FakeSquare = ReturnType<typeof createFakeSquare>
