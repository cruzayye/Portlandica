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

import { createHash } from 'node:crypto'
import { isIsoDate } from '@/lib/delivery'

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
// Numbers tried in a series when the next ones are already taken
const INVOICE_NUMBER_ATTEMPTS = 5
// Square takes up to 5 reminders per payment request
const MAX_REMINDERS = 5

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
  /** The item's exact name in the Square Item Library, e.g. '24 pack - Still' */
  item: string
  /** How many of the item, a whole number: 6 for six 24 packs */
  quantity: number
  /** What the customer pays for the whole line, in cents */
  amountCents: number
  /** The item's price in cents. Used only when the Item Library doesn't have the item. */
  listPriceCents: number
  /**
   * What to call the discount when the line comes to less than the item's price times
   * the quantity, e.g. 'Pine Street Discount'. A discount in the Item Library is used
   * instead when one fits (see createDraftInvoice).
   */
  discountName: string
  /**
   * Take that discount off as an amount ('Half Case Order', $18.00 off) instead of a
   * percentage ('Pine Street Discount', 10% off).
   */
  discountAsAmount?: boolean
}

export type InvoiceReminder = {
  /** Days after the due date: 0 is the due date itself */
  days: number
  message: string
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
  /** The invoice's title, e.g. 'Rose City Cinema' or 'PO #40012345' */
  title?: string | null
  /** The invoice's message, shown under the title */
  message?: string | null
  /** The day of the sale or service, YYYY-MM-DD */
  serviceDate?: string | null
  /**
   * A string is used as the invoice number. { series } carries on the Square
   * customer's own numbering: after their newest invoice, RoseCityCinema_077,
   * comes RoseCityCinema_078. A customer without numbered invoices starts at
   * `${series}_01`. Left out, Square numbers the invoice (0000042). Invoice
   * numbers are unique per Square location.
   */
  invoiceNumber?: string | { series: string } | null
  /** Emails Square sends while the invoice is unpaid, once it has been sent */
  reminders?: InvoiceReminder[]
  /** Offer to save the customer's card or bank account on the payment page */
  savePaymentMethod?: boolean
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
  /** Items missing from the Square Item Library, so their lines were written out by name */
  unlinkedItems: string[]
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

type Money = { amount: number; currency: 'USD' }

type SquareOrder = { id: string; reference_id?: string; total_money?: Money }

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
  uid: string
  quantity: string
  /** An Item Library variation. Its name and price come from there. */
  catalog_object_id?: string
  /** For a line that isn't in the Item Library */
  name?: string
  /** Replaces the Item Library's price, or prices a line that isn't there */
  base_price_money?: Money
  applied_discounts?: { discount_uid: string }[]
}

type SquareOrderDiscount = {
  uid: string
  scope: 'LINE_ITEM'
  /** An Item Library discount. Its name and amount come from there. */
  catalog_object_id?: string
  name?: string
  type?: 'FIXED_PERCENTAGE' | 'FIXED_AMOUNT'
  percentage?: string
  amount_money?: Money
}

type CatalogObject = {
  id: string
  type: string
  item_data?: {
    name?: string
    variations?: { id: string; item_variation_data?: { price_money?: Money } }[]
  }
  discount_data?: {
    name?: string
    discount_type?: string
    percentage?: string
    amount_money?: Money
  }
}

const usd = (amount: number): Money => ({ amount, currency: 'USD' })

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

/** Pages through a Square search endpoint and returns everything it finds. */
const listAll = async <T>(
  config: SquareConfig,
  path: string,
  request: object,
  resultKey: string
): Promise<T[]> => {
  const all: T[] = []
  let cursor: string | undefined
  do {
    const page = await squareRequest<Record<string, unknown>>(config, 'POST', path, {
      ...request,
      cursor,
    })
    all.push(...((page[resultKey] as T[] | undefined) ?? []))
    cursor = page.cursor as string | undefined
  } while (cursor)
  return all
}

/**
 * The idempotency key for a write. Orders and invoices also carry a hash of the request:
 * a retry that sends the same request reuses its key, so Square answers with the first
 * result, while a different request for the same order (made again after its draft was
 * deleted, or with the next invoice number) gets a key of its own.
 */
const idempotencyKey = (
  step: 'customer' | 'order' | 'invoice',
  orderRef: string,
  request?: object
) =>
  request
    ? `portlandica-${step}-${orderRef}-${createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16)}`
    : `portlandica-${step}-${orderRef}`

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

/** An Item Library item: the variation to sell and its price (null when priced at sale). */
type CatalogItem = { variationId: string; priceCents: number | null }

/** The Item Library's item with this name, case and spacing aside, or null. */
const findCatalogItem = async (config: SquareConfig, name: string): Promise<CatalogItem | null> => {
  // Items whose name starts with the same word ('24'), then the one with this name
  const objects = await listAll<CatalogObject>(
    config,
    '/v2/catalog/search',
    {
      object_types: ['ITEM'],
      query: {
        prefix_query: { attribute_name: 'name', attribute_prefix: name.trim().split(/\s+/)[0] },
      },
      limit: 100,
    },
    'objects'
  )
  const variation = objects.find((o) => normalizeName(o.item_data?.name) === normalizeName(name))
    ?.item_data?.variations?.[0]
  if (!variation) return null
  return {
    variationId: variation.id,
    priceCents: variation.item_variation_data?.price_money?.amount ?? null,
  }
}

// The words that name a business, for matching a discount to a customer: lower case,
// without a location in brackets, 'the' or 'discount'.
const nameWords = (name?: string) =>
  normalizeName(name)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9&]+/)
    .filter((word) => word && word !== 'the' && word !== 'discount')

/** How many words two names start with in common: 2 for 'Pine Street Discount' and 'Pine Street Jewelers (Downtown)'. */
const sharedLeadingWords = (a?: string, b?: string) => {
  const [x, y] = [nameWords(a), nameWords(b)]
  let shared = 0
  while (shared < x.length && x[shared] === y[shared]) shared++
  return shared
}

type PercentRange = { low: number; high: number }

// Kept clear of the ends of a percentage range, for floating point
const EDGE = 1e-9

/**
 * The percentages that take exactly each line's discount off its price, as Square rounds
 * a line's discount to the nearest cent. Open at both ends, so no line's discount lands
 * on half a cent, where rounding could go either way.
 */
const percentRange = (lines: { gross: number; discount: number }[]): PercentRange =>
  lines.reduce(
    ({ low, high }, { gross, discount }) => ({
      low: Math.max(low, ((discount - 0.5) / gross) * 100),
      high: Math.min(high, ((discount + 0.5) / gross) * 100),
    }),
    { low: 0, high: 100 }
  )

const inRange = (percent: number, { low, high }: PercentRange) =>
  percent > low + EDGE && percent < high - EDGE

/** The shortest percentage in the range, written as Square takes it ('17.05'), or null. */
const shortestPercent = (range: PercentRange) => {
  for (let places = 0; places <= 7; places++) {
    const scale = 10 ** places
    const percent = (Math.floor((range.low + EDGE) * scale) + 1) / scale
    if (inRange(percent, range)) return percent.toFixed(places)
  }
  return null
}

/** A line priced at the Item Library's price, before any discount. */
type PricedLine = { line: InvoiceLine; lineItem: SquareLineItem; gross: number; discount: number }

/**
 * The discounts that bring each line down to what the customer pays. Lines discounted by
 * a percentage share one discount: the customer's own from the Item Library when its name
 * and percentage fit ('Rose City Discount', 17.05%), otherwise one named after the line
 * ('Taqueria Sol Discount', 12.5%). The rest, or every line when amountsOnly, take an exact
 * amount off (the Item Library's 'Half Case Order' when its name and amount fit).
 */
const withDiscounts = (
  priced: PricedLine[],
  library: CatalogObject[],
  customerName: string,
  amountsOnly: boolean
): { line_items: SquareLineItem[]; discounts?: SquareOrderDiscount[] } => {
  const discounts: SquareOrderDiscount[] = []
  const applied = new Map<PricedLine, string>()
  const apply = (lines: PricedLine[], discount: Omit<SquareOrderDiscount, 'uid' | 'scope'>) => {
    const uid = `discount-${discounts.length + 1}`
    discounts.push({ uid, scope: 'LINE_ITEM', ...discount })
    for (const line of lines) applied.set(line, uid)
  }

  const discounted = priced.filter((p) => p.discount > 0)
  const byPercent = discounted.filter((p) => !amountsOnly && !p.line.discountAsAmount)
  const byAmount = discounted.filter((p) => !byPercent.includes(p))
  if (byPercent.length) {
    const range = percentRange(byPercent)
    const own = library
      .filter(
        (d) =>
          d.discount_data?.discount_type === 'FIXED_PERCENTAGE' &&
          inRange(Number(d.discount_data.percentage), range)
      )
      .map((d) => ({ d, shared: sharedLeadingWords(d.discount_data?.name, customerName) }))
      .filter(({ shared }) => shared > 0)
      .sort((a, b) => b.shared - a.shared)[0]?.d
    const names = new Set(byPercent.map((p) => p.line.discountName))
    const percentage = names.size === 1 ? shortestPercent(range) : null
    if (own) apply(byPercent, { catalog_object_id: own.id })
    else if (percentage) {
      apply(byPercent, {
        name: byPercent[0].line.discountName,
        type: 'FIXED_PERCENTAGE',
        percentage,
      })
    } else byAmount.push(...byPercent)
  }
  for (const p of byAmount) {
    const own = library.find(
      (d) =>
        d.discount_data?.discount_type === 'FIXED_AMOUNT' &&
        d.discount_data.amount_money?.amount === p.discount &&
        normalizeName(d.discount_data.name) === normalizeName(p.line.discountName)
    )
    apply(
      [p],
      own
        ? { catalog_object_id: own.id }
        : { name: p.line.discountName, type: 'FIXED_AMOUNT', amount_money: usd(p.discount) }
    )
  }

  return {
    line_items: priced.map((p) =>
      applied.has(p)
        ? { ...p.lineItem, applied_discounts: [{ discount_uid: applied.get(p)! }] }
        : p.lineItem
    ),
    ...(discounts.length > 0 && { discounts }),
  }
}

const dollars = (cents?: number) =>
  cents === undefined ? 'nothing' : `$${(cents / 100).toFixed(2)}`

/**
 * The Square order for the lines: Item Library items at the Item Library's prices, with
 * discounts down to what the customer pays (withDiscounts). Square works the total out
 * before anything is made; if it isn't the app's total to the cent, every discount becomes
 * an exact amount, and if that's still off nothing is made.
 */
const buildOrder = async (
  config: SquareConfig,
  lines: InvoiceLine[],
  customerName: string,
  base: { location_id: string; reference_id: string; customer_id: string },
  totalCents: number
) => {
  const catalog = new Map<string, CatalogItem | null>()
  for (const item of new Set(lines.map((line) => line.item))) {
    catalog.set(item, await findCatalogItem(config, item))
  }
  const unlinkedItems = [...catalog].filter(([, found]) => !found).map(([item]) => item)

  const priced = lines.map((line, i): PricedLine => {
    const found = catalog.get(line.item) ?? null
    const listCents = found?.priceCents ?? line.listPriceCents
    // Dearer than the item's price: each one at the agreed price instead, to the cent above
    const unitCents = Math.max(listCents, Math.ceil(line.amountCents / line.quantity))
    const gross = unitCents * line.quantity
    return {
      line,
      lineItem: {
        uid: `line-${i + 1}`,
        quantity: String(line.quantity),
        ...(found ? { catalog_object_id: found.variationId } : { name: line.item }),
        ...((!found || found.priceCents !== unitCents) && { base_price_money: usd(unitCents) }),
      },
      gross,
      discount: gross - line.amountCents,
    }
  })

  const library = priced.some((p) => p.discount > 0)
    ? await listAll<CatalogObject>(
        config,
        '/v2/catalog/search',
        { object_types: ['DISCOUNT'], limit: 1000 },
        'objects'
      )
    : []
  const tries = [false, true]
    .map((amountsOnly) => ({
      ...base,
      ...withDiscounts(priced, library, customerName, amountsOnly),
    }))
    .filter((order, i, all) => i === 0 || JSON.stringify(order) !== JSON.stringify(all[0]))

  let squareTotal: number | undefined
  for (const order of tries) {
    const { order: calculated } = await squareRequest<{ order: SquareOrder }>(
      config,
      'POST',
      '/v2/orders/calculate',
      { order }
    )
    squareTotal = calculated.total_money?.amount
    if (squareTotal === totalCents) return { order, unlinkedItems }
  }
  throw new Error(
    `Square works this order out to ${dollars(squareTotal)}, not the ${dollars(totalCents)} the app booked, so no draft was made. Check the items and discounts in the Square Item Library.`
  )
}

const findOrCreateOrder = async (
  config: SquareConfig,
  customerId: string,
  orderRef: string,
  build: (base: {
    location_id: string
    reference_id: string
    customer_id: string
  }) => Promise<{ order: object; unlinkedItems: string[] }>
): Promise<{ order: SquareOrder; unlinkedItems: string[] }> => {
  // Square forgets idempotency keys eventually, so first look for an order an
  // earlier attempt already made.
  const earlier = (
    await listAll<SquareOrder & { state?: string }>(
      config,
      '/v2/orders/search',
      {
        location_ids: [config.locationId],
        limit: 500,
        query: {
          filter: {
            customer_filter: { customer_ids: [customerId] },
            state_filter: { states: ['OPEN', 'COMPLETED', 'CANCELED'] },
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
      },
      'orders'
    )
  ).filter((order) => order.reference_id === orderRef)
  const existing = earlier.find((order) => order.state !== 'CANCELED')
  if (existing) return { order: existing, unlinkedItems: [] }

  const { order, unlinkedItems } = await build({
    location_id: config.locationId,
    reference_id: orderRef,
    customer_id: customerId,
  })
  // Deleting a draft cancels its order. Making it again needs a key of its own, or Square
  // could answer with the canceled order.
  const { order: created } = await squareRequest<{ order: SquareOrder }>(
    config,
    'POST',
    '/v2/orders',
    {
      idempotency_key: idempotencyKey('order', orderRef, { order, remade: earlier.length }),
      order,
    }
  )
  return { order: created, unlinkedItems }
}

// An invoice number in a series: RoseCityCinema_077 is number 77 of RoseCityCinema
const NUMBER_IN_SERIES = /^(.+)_(\d+)$/

const numberAfter = (series: string, number: number, digits: number) =>
  `${series}_${String(number + 1).padStart(digits, '0')}`

/**
 * The next number in the customer's series. Their newest invoice numbered like
 * RoseCityCinema_077 sets the series and its zero padding, and the number goes past
 * the highest in that series. Square's own numbers (0000042) don't count.
 */
const nextInvoiceNumber = (invoices: SquareInvoice[], newSeries: string) => {
  const numbered = invoices.flatMap((invoice) => {
    const match = NUMBER_IN_SERIES.exec(invoice.invoice_number ?? '')
    return match ? [{ series: match[1], digits: match[2] }] : []
  })
  if (!numbered.length) return `${newSeries}_01`
  const [{ series, digits }] = numbered
  const highest = Math.max(
    ...numbered.filter((n) => n.series === series).map((n) => Number(n.digits))
  )
  return numberAfter(series, highest, digits.length)
}

/** Square's answer when another invoice at the location already has the number */
const isNumberTaken = (err: unknown) =>
  err instanceof SquareApiError &&
  err.errors.some(
    (e) => e.field === 'invoice.invoice_number' && /already used|unique/i.test(e.detail ?? '')
  )

const findOrCreateInvoice = async (
  config: SquareConfig,
  orderRef: string,
  customerId: string,
  orderId: string,
  fields: object,
  numbering: DraftInvoiceInput['invoiceNumber']
): Promise<SquareInvoice> => {
  const invoices = await listAll<SquareInvoice>(
    config,
    '/v2/invoices/search',
    {
      limit: 200,
      query: {
        filter: { location_ids: [config.locationId], customer_ids: [customerId] },
        sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' },
      },
    },
    'invoices'
  )
  // Square allows one invoice per order, so an existing one is the answer
  const existing = invoices.find((invoice) => invoice.order_id === orderId)
  if (existing) return existing

  let invoiceNumber =
    typeof numbering === 'string'
      ? numbering
      : numbering
        ? nextInvoiceNumber(invoices, numbering.series)
        : undefined
  for (let attempt = 1; ; attempt++) {
    const invoice = {
      ...fields,
      invoice_number: invoiceNumber,
      location_id: config.locationId,
      order_id: orderId,
      primary_recipient: { customer_id: customerId },
    }
    try {
      const { invoice: created } = await squareRequest<{ invoice: SquareInvoice }>(
        config,
        'POST',
        '/v2/invoices',
        { idempotency_key: idempotencyKey('invoice', orderRef, invoice), invoice }
      )
      return created
    } catch (err) {
      // Taken since the search (an invoice made by hand, say): the series moves on
      const match = NUMBER_IN_SERIES.exec(invoiceNumber ?? '')
      const inSeries = typeof numbering === 'object' && numbering !== null
      if (!isNumberTaken(err) || !inSeries || !match || attempt >= INVOICE_NUMBER_ATTEMPTS) {
        throw err
      }
      invoiceNumber = numberAfter(match[1], Number(match[2]), match[2].length)
    }
  }
}

const checkLine = (line: InvoiceLine): InvoiceLine => {
  const item = line.item?.trim()
  if (!item) throw new Error('Every invoice line needs an item name')
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new Error(`${item}: the quantity must be a whole number above 0, not ${line.quantity}`)
  }
  if (!Number.isInteger(line.amountCents) || line.amountCents < 0) {
    throw new Error(`${item}: the amount must be whole cents, $0 or more, not ${line.amountCents}`)
  }
  if (!Number.isInteger(line.listPriceCents) || line.listPriceCents <= 0) {
    throw new Error(
      `${item}: the list price must be whole cents above $0, not ${line.listPriceCents}`
    )
  }
  const discountName = line.discountName?.trim()
  if (!discountName) throw new Error(`${item}: the line needs a name for its discount`)
  return { ...line, item, discountName }
}

const checkReminder = ({ days, message }: InvoiceReminder): InvoiceReminder => {
  if (!Number.isInteger(days) || Math.abs(days) > 32767) {
    throw new Error(`A reminder's days must be a whole number, not ${days}`)
  }
  const text = message?.trim()
  if (!text || text.length > 1000)
    throw new Error('A reminder needs a message of 1 to 1000 characters')
  return { days, message: text }
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
 * Creates a DRAFT Square invoice for one order: finds or creates the Square customer,
 * creates the order at SQUARE_LOCATION_ID with Item Library items and discounts, then
 * creates the invoice as a draft, numbered in the customer's series. Safe to call again
 * for the same order: it returns the existing draft instead of making a second customer,
 * order or invoice.
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
  const lines = input.lines.map(checkLine)
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  if (totalCents <= 0) throw new Error('The invoice total must be more than $0')

  const orderDate = input.orderDate ?? new Date()
  if (Number.isNaN(orderDate.getTime())) throw new Error('orderDate is not a valid date')
  const termsDueDate = datePlusDays(orderDate, termsDays)

  const title = input.title?.trim()
  if (title && title.length > 255) throw new Error('The invoice title is over 255 characters')
  const message = input.message?.trim()
  if (message && message.length > 65536) throw new Error('The invoice message is too long')
  const serviceDate = input.serviceDate?.trim()
  if (serviceDate && !isIsoDate(serviceDate)) {
    throw new Error(`The service date must be YYYY-MM-DD, not '${serviceDate}'`)
  }
  const numbering = input.invoiceNumber
  const fixedNumber = typeof numbering === 'string' ? numbering.trim() : null
  if (fixedNumber !== null && (!fixedNumber || fixedNumber.length > 191)) {
    throw new Error('The invoice number must be 1 to 191 characters')
  }
  const series = typeof numbering === 'object' && numbering ? numbering.series?.trim() : null
  if (series !== null && (!series || series.length > 180)) {
    throw new Error('The invoice number series must be 1 to 180 characters')
  }
  const reminders = (input.reminders ?? []).map(checkReminder)
  if (reminders.length > MAX_REMINDERS) {
    throw new Error(`Square takes at most ${MAX_REMINDERS} reminders, not ${reminders.length}`)
  }

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
  const { order, unlinkedItems } = await findOrCreateOrder(config, customer.id, orderRef, (base) =>
    buildOrder(config, lines, customerName, base, totalCents)
  )
  const invoice = await findOrCreateInvoice(
    config,
    orderRef,
    customer.id,
    order.id,
    {
      payment_requests: [
        {
          request_type: 'BALANCE',
          due_date: dueDate,
          automatic_payment_source: 'NONE',
          ...(reminders.length > 0 && {
            reminders: reminders.map(({ days, message: text }) => ({
              relative_scheduled_days: days,
              message: text,
            })),
          }),
        },
      ],
      delivery_method:
        input.deliveryMethod ?? (customer.email_address ? 'EMAIL' : 'SHARE_MANUALLY'),
      accepted_payment_methods: {
        card: true,
        bank_account: true,
        square_gift_card: false,
        buy_now_pay_later: false,
        cash_app_pay: false,
      },
      title: title || undefined,
      description: message || undefined,
      sale_or_service_date: serviceDate || undefined,
      ...(input.savePaymentMethod && { store_payment_method_enabled: true }),
    },
    fixedNumber ?? (series ? { series } : null)
  )

  return {
    squareInvoiceId: invoice.id,
    squareOrderId: order.id,
    squareCustomerId: customer.id,
    status: invoice.status,
    dueDate: invoice.payment_requests?.[0]?.due_date ?? dueDate,
    invoiceNumber: invoice.invoice_number ?? null,
    unlinkedItems,
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
