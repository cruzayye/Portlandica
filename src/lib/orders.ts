import type { Batch, Customer, CustomerType as DbCustomerType, SalesOrderLine } from '@/lib/db/types'
import type {
  CustomerType,
  OrderInput,
  OrderLineInput,
  OrderProduct,
  Shortfall,
} from '@/types/orders'
import { CANS_PER_CASE, DEFAULT_PRICE_PER_CAN } from '@/globals/constants'
import { customerKey } from '@/lib/db/customers'
import { lineTotal, unitPrices } from '@/lib/db/orders'
import { isIsoDate } from '@/lib/delivery'
import { batchTitle } from '@/lib/batches'

// Order rules shared by the order form and the server. Pure: no database or network.

/** The customers table's type for each kind of customer on the form. */
export const dbCustomerType = (customerType: CustomerType): DbCustomerType =>
  customerType === 'individual' ? 'individual' : 'business'

/**
 * Cans for a quantity typed into the order form: cases by default, single
 * cans when Enter Manual Number is on. Blank stays blank.
 */
export const toCans = (quantity: string, inCans: boolean): number | null =>
  quantity === '' ? null : Number(quantity) * (inCans ? 1 : CANS_PER_CASE)

/** The automatic price for this many cans, to the cent. Null when there's nothing to price. */
export const priceForCans = (cans: number, pricePerCan: number): number | null =>
  cans > 0 ? Math.round(cans * pricePerCan * 100) / 100 : null

export const PRODUCT_NAMES: Record<OrderProduct, string> = { still: 'Still', sparkling: 'Sparkling' }

/** The shape the database accepts for an email address. */
export const isEmail = (value: string) => /^[^@\s]+@[^@\s]+$/.test(value)

/**
 * Why an order can't be booked as it stands, or null if it can. The form uses it to
 * enable Submit, and createOrder checks it again before writing anything.
 */
export const orderProblem = (order: OrderInput): string | null => {
  if (!order.name.trim()) return 'Enter the customer name.'
  if (order.customerType === 'existing' && order.customerId === null) {
    return 'Pick the customer from the list.'
  }
  if (!order.lines.length) return 'Choose Still or Sparkling.'
  for (const line of order.lines) {
    if (!((line.cans ?? 0) > 0)) return `Enter how much ${PRODUCT_NAMES[line.product]} water.`
    if (!Number.isInteger(line.cans)) {
      return `Enter a whole number of ${PRODUCT_NAMES[line.product]} cans.`
    }
  }
  for (const line of order.lines) {
    if (line.batchId === null) {
      return `Pick the ${PRODUCT_NAMES[line.product]} batch this order comes from.`
    }
  }
  if (!order.deliveryType) return 'Choose Drop, Ship or Pickup.'
  if (!isIsoDate(order.deliveryDate)) return 'Pick a delivery date.'
  if (!order.isDonation && !((order.price ?? 0) > 0)) {
    return 'Enter a price, or mark this order as a donation.'
  }
  const email = order.email?.trim()
  if (email && !isEmail(email)) return 'Check the email address.'
  return null
}

type PricedCustomer = Pick<Customer, 'price_per_can' | 'custom_cans'> | null | undefined

/**
 * Price per can for one order line. A line from the customer's custom batch is billed at
 * their agreed price. A house-stock line is too, but only for a customer who isn't a
 * custom-can account (custom_cans false: Ben Bridge's $1.35 is for regular cans); a
 * custom-can customer pays the default for house stock. No agreed price: the default.
 */
export const linePricePerCan = (customer: PricedCustomer, isCustomLine: boolean) =>
  customer?.price_per_can != null && (isCustomLine || !customer.custom_cans)
    ? Number(customer.price_per_can)
    : DEFAULT_PRICE_PER_CAN

/** Each line's automatic price per can, in line order. A line is custom when its batch is. */
export const linePrices = (
  lines: Pick<OrderLineInput, 'batchId'>[],
  batches: Pick<Batch, 'id' | 'isCustom'>[],
  customer: PricedCustomer
) =>
  lines.map((line) =>
    linePricePerCan(customer, batches.find((batch) => batch.id === line.batchId)?.isCustom ?? false)
  )

/**
 * The automatic price of lines with these many cans at these prices per can: each line
 * priced to the cent on its own, as the database totals them. Null when there are no cans.
 */
export const autoTotal = (cans: number[], prices: number[]): number | null =>
  cans.some((n) => n > 0)
    ? cans.reduce((sum, n, i) => sum + Math.round((priceForCans(n, prices[i]) ?? 0) * 100), 0) / 100
    : null

/**
 * Split a dollar total over parts in proportion to their weights, to the cent, so the
 * parts add up to the total exactly (the last part takes the rounding).
 */
export const splitCents = (total: number, weights: number[]): number[] => {
  const totalCents = Math.round(total * 100)
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map(() => 0)
  let given = 0
  return weights.map((weight, i) => {
    const cents =
      i === weights.length - 1 ? totalCents - given : Math.round((totalCents * weight) / sum)
    given += cents
    return cents / 100
  })
}

/**
 * What each line of an order is charged, in dollars and in line order: its line total,
 * adjusted by a cent where needed so the lines add up to the order's total exactly (a
 * typed total, spread over the lines by priceLines, can be a cent off once rounded). The
 * Sales rows and the Square invoice lines both use these.
 */
export const lineAmounts = (order: {
  total_price: number
  lines: Pick<SalesOrderLine, 'cans' | 'line_total'>[]
}) => {
  const cents = order.lines.map((line) => Math.round(Number(line.line_total) * 100))
  return splitCents(
    Number(order.total_price),
    cents.some((c) => c > 0) ? cents : order.lines.map((line) => line.cans)
  )
}

/**
 * How a typed total is booked over lines of these many cans at these automatic prices per
 * can (spread in proportion by unitPrices): each line's dollar amount, as its Sales row and
 * Square line will show it.
 */
export const typedLineAmounts = (cans: number[], prices: number[], total: number) => {
  const units = unitPrices(cans, { pricePerCan: prices, totalPrice: total })
  return lineAmounts({
    total_price: total,
    lines: cans.map((n, i) => ({
      cans: n,
      line_total: lineTotal({ cans: n, unit_price: units[i] }),
    })),
  })
}

/** Lines that need more cans than their batch has left. */
export const shortfalls = (
  lines: OrderLineInput[],
  batches: Pick<Batch, 'id' | 'name' | 'count' | 'isStill'>[]
): Shortfall[] =>
  lines.flatMap((line) => {
    const batch = batches.find((b) => b.id === line.batchId)
    if (!batch || !line.cans) return []
    const available = Number(batch.count ?? 0)
    return line.cans > available
      ? [{ batchId: batch.id, batchName: batchTitle(batch), available, needed: line.cans }]
      : []
  })

export const shortfallMessage = (s: Shortfall) =>
  `${s.batchName} has ${s.available.toLocaleString('en-US')} cans left; this order needs ${s.needed.toLocaleString('en-US')}.`

/**
 * Whether a saved order is the one this form submission describes: same customer,
 * products, cans, batches, donation flag and price.
 */
export const sameOrder = (
  saved: {
    customer_name: string
    is_donation: boolean
    total_price: number
    lines: Pick<SalesOrderLine, 'product' | 'cans' | 'batch_id'>[]
  },
  input: OrderInput
) => {
  const linesKey = (lines: { product: string; cans: number | null; batch_id: number | null }[]) =>
    lines
      .map((line) => `${line.product}:${line.cans}:${line.batch_id}`)
      .sort()
      .join('|')
  const inputLines = input.lines.map((line) => ({
    product: line.product,
    cans: line.cans,
    batch_id: line.batchId,
  }))
  return (
    customerKey(saved.customer_name) === customerKey(input.name) &&
    linesKey(saved.lines) === linesKey(inputLines) &&
    saved.is_donation === input.isDonation &&
    (input.isDonation ||
      Math.round(Number(saved.total_price) * 100) === Math.round((input.price ?? 0) * 100))
  )
}

/** "Sales!A3126:V3127" as people read it: "Sales rows 3126–3127". */
export const describeSheetRef = (ref: string) => {
  const match = /^(.+)!A(\d+):[A-Z]+(\d+)$/.exec(ref)
  if (!match) return ref
  const [, tab, first, last] = match
  return first === last ? `${tab} row ${first}` : `${tab} rows ${first}–${last}`
}
