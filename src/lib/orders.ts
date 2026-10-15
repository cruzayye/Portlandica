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

/**
 * Price per can for an order. A customer's agreed price applies when the order uses
 * their custom cans (what the old "Custom order?" prompt asked), or to every order when
 * their price isn't tied to custom cans. Everyone else pays the default.
 */
export const orderPricePerCan = (
  customer: Pick<Customer, 'price_per_can' | 'custom_cans'> | null | undefined,
  usesCustomCans: boolean
) =>
  customer?.price_per_can != null && (usesCustomCans || !customer.custom_cans)
    ? Number(customer.price_per_can)
    : DEFAULT_PRICE_PER_CAN

/** Whether any line draws from a custom batch. */
export const usesCustomCans = (
  lines: Pick<OrderLineInput, 'batchId'>[],
  batches: Pick<Batch, 'id' | 'isCustom'>[]
) => lines.some((line) => batches.find((batch) => batch.id === line.batchId)?.isCustom ?? false)

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
