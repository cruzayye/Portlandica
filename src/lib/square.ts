/**
 * Creates DRAFT Square invoices for orders, and deletes one when its order is
 * voided while it is still a draft. Nothing in this file publishes, sends,
 * cancels or refunds an invoice: someone reviews the draft in the Square
 * Dashboard and sends it from there. See docs/integrations.md.
 *
 * Server-side only, because it reads SQUARE_ACCESS_TOKEN. Call it from a
 * server action or route handler, and don't mark this file 'use server'
 * (that would let the browser call it directly).
 */

// Square changes request and response shapes only behind a new version, so
// this is pinned. Bump it on purpose and re-run the tests.
const SQUARE_VERSION = '2026-09-16'

const BASE_URLS = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 500
const REQUEST_TIMEOUT_MS = 10_000

export type InvoiceCustomer = {
  /** Who the invoice is billed to, exactly as it should read, e.g. 'Sysco Portland, Inc.' */
  name: string
  /** Billing email. Square needs one before it can email the invoice. */
  email?: string | null
  /** Square customer id saved from an earlier invoice. Skips the lookup. */
  squareCustomerId?: string | null
  /** Days until the invoice is due: 0 = due on receipt, 30 = Net 30 */
  paymentTermsDays: number
}

export type InvoiceLine = {
  /** Product name as it should read on the invoice, e.g. 'Still Cans' */
  name: string
  /** Number of cans */
  cans: number
  /** Price per can in dollars, e.g. 1.5 */
  unitPrice: number
  /**
   * Bill by the case instead of the can, e.g. 24. The invoice then shows
   * cans / caseSize at unitPrice * caseSize each, to match a PO written in
   * cases.
   */
  caseSize?: number
}

export type DraftInvoiceInput = {
  /**
   * The app's id for this order, 40 characters at most. The Square order's
   * reference_id and every idempotency key come from it, so an id must never
   * be reused for a different order.
   */
  orderId: string | number
  customer: InvoiceCustomer
  lines: InvoiceLine[]
  /** The customer's purchase order number */
  poNumber?: string | null
  /** Free text shown on the invoice */
  note?: string | null
  /** Remit-to address shown on the invoice */
  remitTo?: string | null
  /** Unique per Square location. Square numbers the invoice when this is omitted. */
  invoiceNumber?: string | null
  /**
   * EMAIL: Square emails the invoice when someone sends it.
   * SHARE_MANUALLY: Square sends nothing; download the PDF or copy the link.
   * Defaults to EMAIL when the Square customer has an email address.
   */
  deliveryMethod?: 'EMAIL' | 'SHARE_MANUALLY'
  /**
   * When the order was placed. The due date counts from this day in Pacific
   * time, but is never before today at the Square location (Square refuses
   * that). Defaults to now; pass the order's created_at so a retry on a later
   * day sends Square the same invoice.
   */
  orderDate?: Date
}

export type DraftInvoiceResult = {
  squareInvoiceId: string
  squareOrderId: string
  squareCustomerId: string
  /** DRAFT for a new invoice. If one already existed, its current status. */
  status: string
  /** YYYY-MM-DD */
  dueDate: string
  invoiceNumber: string | null
}

/** What deleteDraftInvoice found, and did. */
export type DraftDeletion =
  /** It was still a draft and is gone now. Square also cancels the order it was for. */
  | { outcome: 'deleted' }
  /** Published (sent, scheduled, paid and so on), so it was left alone. */
  | { outcome: 'not_draft'; status: string }
  /** Square has no invoice with this id: deleted already, or made with another account. */
  | { outcome: 'not_found' }

export type SquareErrorDetail = {
  category: string
  code: string
  detail?: string
  field?: string
}

export class SquareApiError extends Error {
  readonly status: number
  readonly errors: SquareErrorDetail[]

  constructor(status: number, errors: SquareErrorDetail[], message: string) {
    super(message)
    this.name = 'SquareApiError'
    this.status = status
    this.errors = errors
  }
}

type SquareConfig = { accessToken: string; locationId: string; baseUrl: string }

type SquareCustomer = {
  id: string
  given_name?: string
  family_name?: string
  company_name?: string
  email_address?: string
}

type SquareOrder = { id: string; reference_id?: string }

type SquareInvoice = {
  id: string
  /** Goes up with every change. Deleting needs the current one. */
  version?: number
  order_id?: string
  status: string
  invoice_number?: string
  payment_requests?: { due_date?: string }[]
}

type SquareLineItem = {
  name: string
  quantity: string
  base_price_money: { amount: number; currency: 'USD' }
}

const getConfig = (): SquareConfig => {
  // Trimmed because values pasted into Vercel often pick up a trailing newline
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim()
  const locationId = process.env.SQUARE_LOCATION_ID?.trim()
  const environment = process.env.SQUARE_ENVIRONMENT?.trim()

  if (!accessToken || !locationId || !environment) {
    throw new Error(
      `Missing Square env vars: ${[
        !accessToken && 'SQUARE_ACCESS_TOKEN',
        !locationId && 'SQUARE_LOCATION_ID',
        !environment && 'SQUARE_ENVIRONMENT',
      ]
        .filter(Boolean)
        .join(', ')}`
    )
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`SQUARE_ENVIRONMENT must be 'sandbox' or 'production', not '${environment}'`)
  }
  return { accessToken, locationId, baseUrl: BASE_URLS[environment] }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const describeErrors = (errors: SquareErrorDetail[]) =>
  errors.map((e) => [e.code, e.detail].filter(Boolean).join(': ')).join('; ')

/**
 * Calls the Square API. Network failures, timeouts, 429s and 5xx responses
 * are retried. That is safe because every write carries an idempotency key:
 * Square answers a repeated key with the first result instead of acting twice.
 * A repeated delete can't act twice either: the second one finds nothing.
 */
const squareRequest = async <T>(
  config: SquareConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: object
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Square-Version': SQUARE_VERSION,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt)
        continue
      }
      throw new Error(`Square ${method} ${path} failed: ${(err as Error).message}`, { cause: err })
    }

    if (res.ok) return (await res.json()) as T

    const data = (await res.json().catch(() => ({}))) as { errors?: SquareErrorDetail[] }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS * attempt)
      continue
    }
    const errors = data.errors ?? []
    throw new SquareApiError(
      res.status,
      errors,
      `Square ${method} ${path} failed (${res.status}): ${describeErrors(errors) || res.statusText}`
    )
  }
}

/** Pages through a Square search endpoint and returns the first item that matches. */
const findInSearch = async <T>(
  config: SquareConfig,
  path: string,
  request: object,
  resultKey: string,
  matches: (item: T) => boolean
): Promise<T | null> => {
  let cursor: string | undefined
  do {
    const page = await squareRequest<Record<string, unknown>>(config, 'POST', path, {
      ...request,
      cursor,
    })
    const found = ((page[resultKey] as T[] | undefined) ?? []).find(matches)
    if (found) return found
    cursor = page.cursor as string | undefined
  } while (cursor)
  return null
}

const idempotencyKey = (step: 'customer' | 'order' | 'invoice', orderRef: string) =>
  `portlandica-${step}-${orderRef}`

const normalizeName = (name?: string | null) =>
  (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

const isNamed = (customer: SquareCustomer, name: string) =>
  [
    customer.company_name,
    [customer.given_name, customer.family_name].filter(Boolean).join(' '),
  ].some((candidate) => normalizeName(candidate) === normalizeName(name))

// Stored on the customers this app creates, so it can find them again by name
// when it has no email or saved id to go on
const customerReferenceId = (name: string) => `portlandica:${normalizeName(name)}`.slice(0, 100)

const searchCustomers = (
  config: SquareConfig,
  filter: object,
  matches: (customer: SquareCustomer) => boolean
) =>
  findInSearch<SquareCustomer>(
    config,
    '/v2/customers/search',
    { limit: 100, query: { filter, sort: { field: 'CREATED_AT', order: 'ASC' } } },
    'customers',
    matches
  )

const findOrCreateCustomer = async (
  config: SquareConfig,
  customer: InvoiceCustomer,
  orderRef: string
): Promise<SquareCustomer> => {
  const savedId = customer.squareCustomerId?.trim()
  if (savedId) {
    try {
      const { customer: saved } = await squareRequest<{ customer: SquareCustomer }>(
        config,
        'GET',
        `/v2/customers/${encodeURIComponent(savedId)}`
      )
      return saved
    } catch (err) {
      // Deleted or merged in Square, so look the customer up again below
      if (!(err instanceof SquareApiError && err.status === 404)) throw err
    }
  }

  const referenceId = customerReferenceId(customer.name)
  const tagged = await searchCustomers(config, { reference_id: { exact: referenceId } }, () => true)
  if (tagged) return tagged

  const email = customer.email?.trim()
  if (email) {
    // Same email isn't enough: several customers can share one billing inbox
    const existing = await searchCustomers(config, { email_address: { exact: email } }, (c) =>
      isNamed(c, customer.name)
    )
    if (existing) return existing
  }

  const response = await squareRequest<{ customer: SquareCustomer }>(
    config,
    'POST',
    '/v2/customers',
    {
      idempotency_key: idempotencyKey('customer', orderRef),
      company_name: customer.name,
      email_address: email || undefined,
      reference_id: referenceId,
    }
  )
  return response.customer
}

const findOrCreateOrder = async (
  config: SquareConfig,
  customerId: string,
  orderRef: string,
  lineItems: SquareLineItem[]
): Promise<SquareOrder> => {
  // Square forgets idempotency keys eventually, so first look for an order an
  // earlier attempt already made.
  const existing = await findInSearch<SquareOrder>(
    config,
    '/v2/orders/search',
    {
      location_ids: [config.locationId],
      limit: 100,
      query: {
        filter: {
          customer_filter: { customer_ids: [customerId] },
          state_filter: { states: ['OPEN', 'COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
    },
    'orders',
    (order) => order.reference_id === orderRef
  )
  if (existing) return existing

  const { order } = await squareRequest<{ order: SquareOrder }>(config, 'POST', '/v2/orders', {
    idempotency_key: idempotencyKey('order', orderRef),
    order: {
      location_id: config.locationId,
      reference_id: orderRef,
      customer_id: customerId,
      line_items: lineItems,
    },
  })
  return order
}

const findOrCreateInvoice = async (
  config: SquareConfig,
  orderRef: string,
  customerId: string,
  orderId: string,
  fields: object
): Promise<SquareInvoice> => {
  // Square allows one invoice per order, so an existing one is the answer
  const existing = await findInSearch<SquareInvoice>(
    config,
    '/v2/invoices/search',
    {
      limit: 100,
      query: {
        filter: { location_ids: [config.locationId], customer_ids: [customerId] },
        sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' },
      },
    },
    'invoices',
    (invoice) => invoice.order_id === orderId
  )
  if (existing) return existing

  const { invoice } = await squareRequest<{ invoice: SquareInvoice }>(
    config,
    'POST',
    '/v2/invoices',
    {
      idempotency_key: idempotencyKey('invoice', orderRef),
      invoice: {
        ...fields,
        location_id: config.locationId,
        order_id: orderId,
        primary_recipient: { customer_id: customerId },
      },
    }
  )
  return invoice
}

// Float math turns 1.15 * 100 into 114.99999999999999, so allow a sliver
const isWholeCents = (dollars: number) => Math.abs(dollars * 100 - Math.round(dollars * 100)) < 1e-6

const toLineItem = (line: InvoiceLine): SquareLineItem => {
  const name = line.name?.trim()
  if (!name) throw new Error('Every invoice line needs a product name')
  if (!Number.isInteger(line.cans) || line.cans <= 0) {
    throw new Error(`${name}: cans must be a whole number above 0, not ${line.cans}`)
  }
  if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
    throw new Error(`${name}: unit price must be $0 or more, not ${line.unitPrice}`)
  }

  const caseSize = line.caseSize ?? 1
  if (!Number.isInteger(caseSize) || caseSize <= 0) {
    throw new Error(`${name}: case size must be a whole number above 0, not ${line.caseSize}`)
  }
  if (line.cans % caseSize !== 0) {
    throw new Error(`${name}: ${line.cans} cans don't make whole cases of ${caseSize}`)
  }

  // Rounding here would silently change what the customer is billed
  const price = line.unitPrice * caseSize
  if (!isWholeCents(price)) {
    throw new Error(`${name}: $${price} is not a whole number of cents`)
  }

  return {
    name,
    quantity: String(line.cans / caseSize),
    base_price_money: { amount: Math.round(price * 100), currency: 'USD' },
  }
}

/** The calendar date in Portland (YYYY-MM-DD) at `date`, plus `days` */
const PORTLAND_TIME_ZONE = 'America/Los_Angeles'

/** The day `days` after `date` in `timeZone`, as YYYY-MM-DD. */
const datePlusDays = (date: Date, days: number, timeZone = PORTLAND_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  // Date.UTC rolls a day past the end of the month into the next month
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + days))
    .toISOString()
    .slice(0, 10)
}

/** The Square location's time zone, e.g. America/Los_Angeles. Square counts "today" there. */
const locationTimeZone = async (config: SquareConfig) => {
  const { location } = await squareRequest<{ location?: { timezone?: string } }>(
    config,
    'GET',
    `/v2/locations/${encodeURIComponent(config.locationId)}`
  )
  return location?.timezone || PORTLAND_TIME_ZONE
}

/**
 * Creates a DRAFT Square invoice for one order: finds or creates the Square
 * customer, creates the order at SQUARE_LOCATION_ID, then creates the invoice
 * as a draft. Safe to call again for the same order: it returns the existing
 * draft instead of making a second customer, order or invoice.
 */
export const createDraftInvoice = async (input: DraftInvoiceInput): Promise<DraftInvoiceResult> => {
  // Check everything before the first request, so bad input changes nothing in Square
  const config = getConfig()

  const orderRef = String(input.orderId ?? '').trim()
  if (!orderRef || orderRef.length > 40) {
    throw new Error(`orderId must be 1 to 40 characters, not '${orderRef}'`)
  }

  const customerName = input.customer.name?.trim()
  if (!customerName) throw new Error('The customer needs a name to bill')

  const termsDays = input.customer.paymentTermsDays
  if (!Number.isInteger(termsDays) || termsDays < 0) {
    throw new Error(`paymentTermsDays must be a whole number of days, not ${termsDays}`)
  }

  if (!input.lines.length) throw new Error('An invoice needs at least one line')
  const lineItems = input.lines.map(toLineItem)
  const totalCents = lineItems.reduce(
    (sum, item) => sum + item.base_price_money.amount * Number(item.quantity),
    0
  )
  if (totalCents <= 0) throw new Error('The invoice total must be more than $0')

  const orderDate = input.orderDate ?? new Date()
  if (Number.isNaN(orderDate.getTime())) throw new Error('orderDate is not a valid date')
  const termsDueDate = datePlusDays(orderDate, termsDays)

  const poNumber = input.poNumber?.trim()
  const note = input.note?.trim()
  const remitTo = input.remitTo?.trim()
  const invoiceNumber = input.invoiceNumber?.trim()
  const title = poNumber ? `PO ${poNumber}` : undefined
  if (title && title.length > 255) throw new Error('The PO number is too long for an invoice title')
  if (invoiceNumber && invoiceNumber.length > 191) throw new Error('The invoice number is too long')

  // The PO goes in the title and the description so it shows wherever Square
  // prints either one; accounts payable teams reject invoices without it.
  const description = [poNumber && `PO ${poNumber}`, note, remitTo && `Remit to: ${remitTo}`]
    .filter(Boolean)
    .join('\n')

  // Square refuses a due date before today at the location. A due-on-receipt order
  // retried on a later day, or a location in another time zone (the sandbox's is
  // UTC), would hit that, so the due date is never earlier than the location's today.
  const locationToday = datePlusDays(new Date(), 0, await locationTimeZone(config))
  const dueDate = termsDueDate < locationToday ? locationToday : termsDueDate

  const customer = await findOrCreateCustomer(
    config,
    { ...input.customer, name: customerName },
    orderRef
  )
  const order = await findOrCreateOrder(config, customer.id, orderRef, lineItems)
  const invoice = await findOrCreateInvoice(config, orderRef, customer.id, order.id, {
    payment_requests: [
      { request_type: 'BALANCE', due_date: dueDate, automatic_payment_source: 'NONE' },
    ],
    delivery_method: input.deliveryMethod ?? (customer.email_address ? 'EMAIL' : 'SHARE_MANUALLY'),
    accepted_payment_methods: {
      card: true,
      bank_account: true,
      square_gift_card: false,
      buy_now_pay_later: false,
      cash_app_pay: false,
    },
    title,
    description: description || undefined,
    invoice_number: invoiceNumber || undefined,
  })

  return {
    squareInvoiceId: invoice.id,
    squareOrderId: order.id,
    squareCustomerId: customer.id,
    status: invoice.status,
    dueDate: invoice.payment_requests?.[0]?.due_date ?? dueDate,
    invoiceNumber: invoice.invoice_number ?? null,
  }
}

/** The invoice as Square has it now, or null if Square has none with this id. */
const getInvoice = async (config: SquareConfig, invoiceId: string) => {
  try {
    const { invoice } = await squareRequest<{ invoice: SquareInvoice }>(
      config,
      'GET',
      `/v2/invoices/${encodeURIComponent(invoiceId)}`
    )
    return invoice
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) return null
    throw err
  }
}

/**
 * Deletes a Square invoice, but only while it is still a DRAFT, for an order that was
 * voided. A published invoice (sent, scheduled, paid, ...) is never touched: the result
 * says what it is, so a person can cancel or refund it in Square. Square deletes only
 * the version it is given, so this reads the invoice first and deletes that version; a
 * draft someone changed in between is left for a person too. Deleting a draft also
 * cancels the Square order it was for. Safe to call again: a second call finds nothing.
 */
export const deleteDraftInvoice = async (invoiceId: string): Promise<DraftDeletion> => {
  const config = getConfig()
  const id = String(invoiceId ?? '').trim()
  if (!id) throw new Error('There is no Square invoice id to delete')

  const invoice = await getInvoice(config, id)
  if (!invoice) return { outcome: 'not_found' }
  if (invoice.status !== 'DRAFT') return { outcome: 'not_draft', status: invoice.status }

  try {
    await squareRequest(
      config,
      'DELETE',
      `/v2/invoices/${encodeURIComponent(id)}?version=${invoice.version ?? 0}`
    )
    return { outcome: 'deleted' }
  } catch (err) {
    // Look again before calling it a failure: a reply lost after Square deleted the
    // draft comes back as "not found" on the retry, and someone may have sent the
    // invoice in the meantime.
    const now = await getInvoice(config, id).catch(() => undefined)
    if (now === null) return { outcome: 'deleted' }
    if (now && now.status !== 'DRAFT') return { outcome: 'not_draft', status: now.status }
    throw err
  }
}
