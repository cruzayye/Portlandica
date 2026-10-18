import { DEFAULT_PRICE_PER_CAN } from '@/globals/constants'
import { unwrap } from './errors'
import type {
  CustomerType,
  Db,
  DeliveryType,
  LineProduct,
  OrderStep,
  SalesOrder,
  SalesOrderLine,
  SalesOrderWithLines,
} from './types'

// Sales orders. The server flow for one form submission (src/lib/orderSteps.ts):
//   1. createSalesOrder with the form's idempotency key (a retry returns the same order)
//   2. write the Sales sheet, recording the outcome with recordOrderStep
//   3. applyOrderInventory; on 'insufficient_stock' the user can retry with allowNegative;
//      on any error recordOrderStep(..., 'inventory', 'failed')
//   4. create the Trello card and the Square invoice, recording each outcome
// pendingSteps(order) says what is left, so a retry only repeats what didn't finish.

export type NewOrderLine = {
  product: LineProduct
  cans: number
  batch_id: number
  /** Dollars per can. */
  unit_price: number
}

export type NewSalesOrder = {
  /** One per form submission; reuse it when retrying that submission. */
  idempotency_key: string
  delivery_type: DeliveryType
  lines: NewOrderLine[]
  customer_id?: number | null
  /** Defaults to the customer's name. Required when there is no customer_id. */
  customer_name?: string | null
  /** Defaults to the customer's type, else business. */
  type?: CustomerType | null
  delivery_date?: string | null
  /** The customer's purchase order number, if they sent one. */
  po_number?: string | null
  notes?: string | null
  /** What to charge. Defaults to the sum of the line totals. */
  total_price?: number | null
  is_paid?: boolean
  create_invoice?: boolean
  is_donation?: boolean
  /** Defaults to today in Portland. */
  order_date?: string | null
  /** Where the order goes, for the Trello card. */
  delivery_address?: string | null
  /** Billing email given with the order. */
  customer_email?: string | null
  /** This order added the customer. */
  new_customer?: boolean
}

export type CreatedSalesOrder = {
  /** False when this idempotency key had already created the order. */
  created: boolean
  order: SalesOrder
  lines: SalesOrderLine[]
}

export const newIdempotencyKey = () => crypto.randomUUID()

const DELIVERY_TYPES: Record<string, DeliveryType> = {
  drop: 'drop',
  ship: 'ship',
  pickup: 'pickup',
}

/** The order form's 'Drop' | 'Ship' | 'Pickup' as a delivery_type. */
export const deliveryTypeFromForm = (value: string | null | undefined): DeliveryType | null =>
  DELIVERY_TYPES[(value ?? '').trim().toLowerCase()] ?? null

// Money is worked out in whole units, cents for totals and ten-thousandths of a dollar for
// unit prices (the precision they are stored at), so the results match Postgres's exact
// numeric arithmetic instead of drifting with floating point.
const UNIT_PRICE_SCALE = 10_000

const toUnitPrice = (dollars: number) => Math.round(dollars * UNIT_PRICE_SCALE) / UNIT_PRICE_SCALE

const lineCents = (line: Pick<NewOrderLine, 'cans' | 'unit_price'>) =>
  Math.round((line.cans * Math.round(line.unit_price * UNIT_PRICE_SCALE)) / 100)

/** A line's dollar total, rounded to cents like sales_order_lines.line_total. */
export const lineTotal = (line: Pick<NewOrderLine, 'cans' | 'unit_price'>) => lineCents(line) / 100

export const linesTotal = (lines: Pick<NewOrderLine, 'cans' | 'unit_price'>[]) =>
  lines.reduce((sum, line) => sum + lineCents(line), 0) / 100

export type PriceOptions = {
  /** Dollars per can: one price for every line, or one per line, in line order. */
  pricePerCan?: number | number[]
  /** A total typed in by hand. It replaces the sum of the lines. */
  totalPrice?: number | null
  isDonation?: boolean
}

/**
 * The price per can of each line, for lines of these many cans. Donations are free.
 * Otherwise each line costs its pricePerCan. A manual total replaces the automatic one
 * and is spread over the lines in proportion to what each costs at those prices: every
 * line's price is scaled by the same factor, so a line priced higher (a customer's custom
 * cans) stays higher. When every line has the same price, that is the same as spreading
 * the total evenly over every can.
 */
export const unitPrices = (
  cans: number[],
  { pricePerCan = DEFAULT_PRICE_PER_CAN, totalPrice = null, isDonation = false }: PriceOptions = {}
): number[] => {
  if (Array.isArray(pricePerCan) && pricePerCan.length !== cans.length) {
    throw new Error('Give one price per line')
  }
  const prices = cans.map((_, i) => (Array.isArray(pricePerCan) ? pricePerCan[i] : pricePerCan))
  if (isDonation) return cans.map(() => 0)
  const totalCans = cans.reduce((sum, n) => sum + n, 0)
  if (totalPrice === null || totalCans <= 0) return prices
  const automatic = cans.reduce((sum, n, i) => sum + n * prices[i], 0)
  if (automatic <= 0 || prices.every((price) => price === prices[0])) {
    return cans.map(() => toUnitPrice(totalPrice / totalCans))
  }
  return prices.map((price) => toUnitPrice((price * totalPrice) / automatic))
}

/**
 * Price an order's lines (see unitPrices). Pass the same total_price to createSalesOrder
 * when a total was typed, so the order keeps the exact amount.
 */
export const priceLines = (
  lines: Omit<NewOrderLine, 'unit_price'>[],
  options: PriceOptions = {}
): NewOrderLine[] => {
  const prices = unitPrices(
    lines.map((line) => line.cans),
    options
  )
  return lines.map((line, i) => ({ ...line, unit_price: prices[i] }))
}

// The Sales sheet is the book of record Paul's reports read, so it goes first.
export const STEP_ORDER: OrderStep[] = ['sheet', 'inventory', 'trello', 'square']

/** Steps still to run or retry, in the order to run them. None for a voided order. */
export const pendingSteps = (
  order: Pick<
    SalesOrder,
    'voided_at' | 'inventory_status' | 'sheet_status' | 'trello_status' | 'square_status'
  >
): OrderStep[] =>
  order.voided_at
    ? []
    : STEP_ORDER.filter((step) => {
        const status = order[`${step}_status`]
        return status === 'pending' || status === 'failed'
      })

/** Create an order and its lines in one transaction. Same key again: the existing order. */
export const createSalesOrder = async (db: Db, order: NewSalesOrder) =>
  unwrap<CreatedSalesOrder>(
    await db.rpc('create_sales_order', {
      p_idempotency_key: order.idempotency_key,
      p_delivery_type: order.delivery_type,
      p_lines: order.lines.map(({ product, cans, batch_id, unit_price }) => ({
        product,
        cans,
        batch_id,
        unit_price,
      })),
      p_customer_id: order.customer_id ?? null,
      p_customer_name: order.customer_name ?? null,
      p_type: order.type ?? null,
      p_delivery_date: order.delivery_date ?? null,
      p_notes: order.notes ?? null,
      p_total_price: order.total_price ?? null,
      p_is_paid: order.is_paid ?? false,
      p_create_invoice: order.create_invoice ?? false,
      p_is_donation: order.is_donation ?? false,
      p_order_date: order.order_date ?? null,
      p_po_number: order.po_number ?? null,
      p_delivery_address: order.delivery_address ?? null,
      p_customer_email: order.customer_email ?? null,
      p_new_customer: order.new_customer ?? false,
    })
  )

/**
 * Take the order's cans out of inventory. Safe to call again. Fails with
 * 'insufficient_stock' (see DbError.shortfall) unless allowNegative is set.
 */
export const applyOrderInventory = async (
  db: Db,
  orderId: number,
  { allowNegative = false }: { allowNegative?: boolean } = {}
) =>
  unwrap<SalesOrder>(
    await db.rpc('apply_order_inventory', {
      p_order_id: orderId,
      p_allow_negative: allowNegative,
    })
  )

/** Void an order and put its cans back. Trello, Square and the sheet are left to the caller. */
export const voidSalesOrder = async (db: Db, orderId: number, reason: string) =>
  unwrap<SalesOrder>(await db.rpc('void_order', { p_order_id: orderId, p_reason: reason }))

/**
 * Record how a step went. externalId is the Trello card id or Square invoice id; error is
 * kept only for 'failed'. Inventory accepts only 'failed' (applyOrderInventory marks done).
 */
export const recordOrderStep = async (
  db: Db,
  orderId: number,
  step: OrderStep,
  status: SalesOrder['sheet_status'],
  { externalId, error }: { externalId?: string | null; error?: string | null } = {}
) =>
  unwrap<SalesOrder>(
    await db.rpc('record_order_step', {
      p_order_id: orderId,
      p_step: step,
      p_status: status,
      p_external_id: externalId ?? null,
      p_error: error ?? null,
    })
  )

export const getSalesOrder = async (db: Db, id: number): Promise<SalesOrderWithLines | null> => {
  const order = unwrap<SalesOrder | null>(
    await db.from('sales_orders').select('*').eq('id', id).maybeSingle()
  )
  if (!order) return null
  const lines = unwrap<SalesOrderLine[]>(
    await db.from('sales_order_lines').select('*').eq('order_id', id).order('id')
  )
  return { ...order, lines }
}

/** The order this idempotency key created, if any. */
export const getSalesOrderByKey = async (
  db: Db,
  idempotencyKey: string
): Promise<SalesOrderWithLines | null> => {
  const order = unwrap<SalesOrder | null>(
    await db.from('sales_orders').select('*').eq('idempotency_key', idempotencyKey).maybeSingle()
  )
  return order ? getSalesOrder(db, order.id) : null
}

/** Newest orders first, voided ones included, each with its lines. */
export const listRecentOrders = async (
  db: Db,
  { limit = 50 }: { limit?: number } = {}
): Promise<SalesOrderWithLines[]> => {
  const orders = await listSalesOrders(db, { includeVoided: true, limit })
  if (!orders.length) return []
  const lines = unwrap<SalesOrderLine[]>(
    await db
      .from('sales_order_lines')
      .select('*')
      .in(
        'order_id',
        orders.map((order) => order.id)
      )
      .order('id')
  )
  return orders.map((order) => ({
    ...order,
    lines: lines.filter((line) => line.order_id === order.id),
  }))
}

export const listSalesOrders = async (
  db: Db,
  {
    from,
    to,
    customerId,
    includeVoided = false,
    limit = 200,
  }: {
    from?: string
    to?: string
    customerId?: number
    includeVoided?: boolean
    limit?: number
  } = {}
): Promise<SalesOrder[]> => {
  let query = db.from('sales_orders').select('*')
  if (from) query = query.gte('order_date', from)
  if (to) query = query.lte('order_date', to)
  if (customerId !== undefined) query = query.eq('customer_id', customerId)
  if (!includeVoided) query = query.is('voided_at', null)
  return unwrap<SalesOrder[]>(await query.order('id', { ascending: false }).limit(limit))
}

/** Recent orders with a step still pending or failed, newest first. */
export const listUnfinishedOrders = async (db: Db, { limit = 200 }: { limit?: number } = {}) =>
  (await listSalesOrders(db, { limit })).filter((order) => pendingSteps(order).length > 0)

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

/**
 * Live orders for this customer on this date, to warn before booking a second one. Matches
 * customer_id when there is one, otherwise the name (any case).
 */
export const findSameDayOrders = async (
  db: Db,
  {
    orderDate,
    customerId,
    customerName,
  }: { orderDate: string; customerId?: number | null; customerName: string }
) => {
  let query = db.from('sales_orders').select('*').eq('order_date', orderDate).is('voided_at', null)
  query =
    customerId != null
      ? query.eq('customer_id', customerId)
      : query.ilike('customer_name', escapeLike(customerName.trim()))
  return unwrap<SalesOrder[]>(await query.order('id'))
}
