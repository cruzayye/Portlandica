import type { Customer, SalesOrderWithLines } from '@/lib/db/types'
import type { DraftInvoiceInput, InvoiceLine, InvoiceReminder } from '@/lib/square'
import { CANS_PER_CASE } from '@/globals/constants'
import { paymentTermsDays } from '@/lib/db/customers'
import { lineAmounts } from '@/lib/orders'

// What an order's Square draft says, made the way Paul makes his invoices by hand from his
// Square template ("Portlandica Invoice Template"): the business as the title, the next
// number in the customer's own series, the order date as the service date, his message
// with the order and delivery dates and the mailing address, 24 packs from the Square Item
// Library less the customer's discount, and his five reminders. Pure: no database or
// network. See docs/integrations.md.

/** The Square Item Library's 24 packs, and their list prices in cents. */
export const PACKS = {
  still: { item: '24 pack - Still', listPriceCents: 3600 },
  sparkling: { item: '24 pack - Sparkling', listPriceCents: 3600 },
  custom: { item: '24 pack - Customized Portland Water Can', listPriceCents: 4800 },
} as const

type Pack = keyof typeof PACKS

const MAILING_ADDRESS = [
  '**** MAILING ADDRESS ****',
  'Portlandica',
  'P.O. Box 5374',
  'Portland, OR 97228',
  '*********',
].join('\n')

const OUTSTANDING =
  'Hey, this invoice for Portlandica is outstanding. Please pay at your earliest convenience and feel free to reach out if you have any questions! -Paul'
const REALLY_OVERDUE =
  'Hey, this invoice for Portlandica is really overdue. Please pay at your earliest convenience and feel free to reach out if you have any questions! -Paul'

/** The template's reminders: on the due date, then 1, 2, 7 and 30 days after. */
export const INVOICE_REMINDERS: InvoiceReminder[] = [
  { days: 0, message: OUTSTANDING },
  { days: 1, message: OUTSTANDING },
  { days: 2, message: OUTSTANDING },
  { days: 7, message: OUTSTANDING },
  { days: 30, message: REALLY_OVERDUE },
]

type DraftOrder = Pick<
  SalesOrderWithLines,
  'lines' | 'total_price' | 'order_date' | 'delivery_date' | 'delivery_type' | 'po_number'
>

/** The name without a location in brackets: 'Pine Street Jewelers' for 'Pine Street Jewelers (Downtown)'. */
const businessName = (name: string) =>
  name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The start of a new customer's invoice numbers, the way Paul writes them:
 * 'NorthgateApartments' for Northgate Apartments, 'Salt&Pine' for Salt & Pine.
 */
export const invoiceSeries = (name: string) =>
  businessName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('')
    .slice(0, 60) || 'Invoice'

/** The title: the business, or the PO for a customer who orders with one ('PO #40012345'). */
export const invoiceTitle = (order: Pick<DraftOrder, 'po_number'>, customerName: string) => {
  const po = order.po_number?.trim()
  if (!po) return customerName
  return /^p\.?o\.?\b/i.test(po) ? po : `PO #${po}`
}

// 'Still', 'Custom Sparkling' and so on, in the order the message lists them
const PRODUCTS = [
  { custom: false, product: 'still', label: 'Still' },
  { custom: false, product: 'sparkling', label: 'Sparkling' },
  { custom: true, product: 'still', label: 'Custom Still' },
  { custom: true, product: 'sparkling', label: 'Custom Sparkling' },
] as const

const count = (n: number) => n.toLocaleString('en-US')

/** '9 cases of Still', '1 case of Custom Still', or '36 cans of Still' when they aren't whole cases. */
const quantityOf = (cans: number, label: string) => {
  if (cans % CANS_PER_CASE !== 0) return `${count(cans)} cans of ${label}`
  const cases = cans / CANS_PER_CASE
  return `${count(cases)} ${cases === 1 ? 'case' : 'cases'} of ${label}`
}

/** 'a', 'a and b', 'a, b and c' */
const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** '$1.50', '$1.659': whole cents, or the price as it is when it has a fraction of a cent. */
const pricePerCan = (price: number) => `$${price.toFixed(4).replace(/0{1,2}$/, '')}`

/** '$540' for whole dollars, '$1,353.74' otherwise. */
const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`

/** '10/14/2026' (and '9/14/2026', no leading zeros) for 2026-10-14 */
const usDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-').map(Number)
  return `${month}/${day}/${year}`
}

/** Each order line's charge in cents (lineAmounts, so it matches the Sales rows). */
const lineCents = (order: Pick<DraftOrder, 'lines' | 'total_price'>) =>
  lineAmounts(order).map((amount) => Math.round(amount * 100))

/**
 * The invoice message from Paul's template:
 *
 *   Portlandica, order of 9 cases of Still and 6 cases of Sparkling (360 cans total) @ $1.50/can for a total of $540.
 *
 *   Ordered: 10/14/2026
 *   Delivery by: 10/16/2026
 *
 * then the mailing address. The price per can is left out when the lines differ in price
 * or a typed total doesn't come to that price.
 */
export const invoiceMessage = (order: DraftOrder) => {
  const cents = lineCents(order)
  const items = PRODUCTS.flatMap(({ custom, product, label }) => {
    const cans = order.lines
      .filter((line) => line.is_custom === custom && line.product === product)
      .reduce((sum, line) => sum + line.cans, 0)
    return cans > 0 ? [quantityOf(cans, label)] : []
  })
  const totalCans = order.lines.reduce((sum, line) => sum + line.cans, 0)
  const totalCents = cents.reduce((sum, c) => sum + c, 0)
  const prices = [...new Set(order.lines.map((line) => Number(line.unit_price)))]
  const atPrice =
    prices.length === 1 && Math.round(totalCans * prices[0] * 100) === totalCents
      ? ` @ ${pricePerCan(prices[0])}/can`
      : ''

  const sentence = `Portlandica, order of ${listed(items)} (${count(totalCans)} cans total)${atPrice} for a total of ${dollars(totalCents)}.`
  const dates = [
    `Ordered: ${usDate(order.order_date)}`,
    order.delivery_date &&
      `${order.delivery_type === 'pickup' ? 'Pickup by' : 'Delivery by'}: ${usDate(order.delivery_date)}`,
  ]
    .filter(Boolean)
    .join('\n')
  return [sentence, dates, MAILING_ADDRESS].join('\n\n')
}

/**
 * The invoice lines: one per 24 pack in the Item Library (Still, Sparkling, and the
 * customized can for custom cans of either), at what the order charges. Cans that don't
 * fill the last pack are billed as a whole pack with the difference taken off: 'Half Case
 * Order' for half a pack at list price, as Paul does, otherwise the customer's discount.
 * A customer's lower price is a discount too, named after them, unless the Item Library
 * has theirs (square.ts looks).
 */
export const invoicePacks = (
  order: Pick<DraftOrder, 'lines' | 'total_price'>,
  customerName: string
): InvoiceLine[] => {
  const cents = lineCents(order)
  const packs = new Map<Pack, { cans: number; cents: number }>()
  order.lines.forEach((line, i) => {
    const pack: Pack = line.is_custom ? 'custom' : line.product
    const sum = packs.get(pack) ?? { cans: 0, cents: 0 }
    packs.set(pack, { cans: sum.cans + line.cans, cents: sum.cents + cents[i] })
  })

  return (['still', 'sparkling', 'custom'] as const).flatMap((pack) => {
    const sum = packs.get(pack)
    if (!sum) return []
    const { item, listPriceCents } = PACKS[pack]
    const quantity = Math.ceil(sum.cans / CANS_PER_CASE)
    const emptyCans = quantity * CANS_PER_CASE - sum.cans
    const halfCaseAtList =
      emptyCans === CANS_PER_CASE / 2 && sum.cents * CANS_PER_CASE === sum.cans * listPriceCents
    return [
      {
        item,
        quantity,
        amountCents: sum.cents,
        listPriceCents,
        discountName: halfCaseAtList ? 'Half Case Order' : `${businessName(customerName)} Discount`,
        ...(emptyCans > 0 && { discountAsAmount: true }),
      },
    ]
  })
}

/** Everything createDraftInvoice needs for an order but its Square reference. */
export const draftInvoiceFor = (
  order: SalesOrderWithLines,
  customer: Customer | null
): Omit<DraftInvoiceInput, 'orderId'> => {
  const name = customer?.name ?? order.customer_name
  return {
    orderDate: new Date(order.created_at),
    customer: {
      name,
      email: order.customer_email ?? customer?.email ?? null,
      squareCustomerId: customer?.square_customer_id ?? null,
      paymentTermsDays: paymentTermsDays(customer, order.type),
    },
    lines: invoicePacks(order, name),
    title: invoiceTitle(order, name),
    message: invoiceMessage(order),
    serviceDate: order.order_date,
    invoiceNumber: { series: invoiceSeries(name) },
    reminders: INVOICE_REMINDERS,
    savePaymentMethod: true,
  }
}
