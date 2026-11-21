import { unwrap } from './errors'
import type { Db, SalesOrder } from './types'

// BLine deliveries as findelivers.com reports them (see 20261120000100_bline_tracking.sql):
// what an import of its Orders CSV found for each order, and deliveries marked by hand.
// Everything is written through SQL functions.

const COLUMNS = [
  'id',
  'customer_name',
  'delivery_address',
  'order_date',
  'delivery_date',
  'total_cans',
  'delivery_fee',
  'voided_at',
  'trello_card_id',
  'delivered_at',
  'bline_ref',
  'bline_status',
  'bline_problem',
  'bline_checked_at',
].join(', ')

/** A BLine order as delivery tracking needs it. */
export type BlineDelivery = Pick<
  SalesOrder,
  | 'id'
  | 'customer_name'
  | 'delivery_address'
  | 'order_date'
  | 'delivery_date'
  | 'total_cans'
  | 'delivery_fee'
  | 'voided_at'
  | 'trello_card_id'
  | 'delivered_at'
  | 'bline_ref'
  | 'bline_status'
  | 'bline_problem'
  | 'bline_checked_at'
>

const blineOrders = (db: Db) => db.from('sales_orders').select(COLUMNS).eq('delivery_type', 'bline')

/** BLine orders booked from `from` to `to` (YYYY-MM-DD), void ones included. */
export const listBlineOrdersBooked = async (db: Db, { from, to }: { from: string; to: string }) =>
  unwrap<BlineDelivery[]>(
    await blineOrders(db).gte('order_date', from).lte('order_date', to).order('id')
  )

/** These orders, if they are BLine orders. */
export const listBlineOrdersById = async (db: Db, ids: number[]) =>
  ids.length ? unwrap<BlineDelivery[]>(await blineOrders(db).in('id', ids).order('id')) : []

/** BLine orders an import matched to any of these findelivers numbers. */
export const listBlineOrdersByRef = async (db: Db, refs: string[]) =>
  refs.length
    ? unwrap<BlineDelivery[]>(await blineOrders(db).in('bline_ref', refs).order('id'))
    : []

/** Live BLine orders not delivered yet, oldest first. */
export const listUndeliveredBlineOrders = async (db: Db) =>
  unwrap<BlineDelivery[]>(
    await blineOrders(db).is('voided_at', null).is('delivered_at', null).order('id')
  )

/** Live BLine orders delivered at or after `since` (ISO). */
export const listBlineOrdersDeliveredSince = async (db: Db, since: string) =>
  unwrap<BlineDelivery[]>(
    await blineOrders(db).is('voided_at', null).gte('delivered_at', since).order('id')
  )

/** When an import last checked any order, or null if none has. */
export const lastFindeliversImport = async (db: Db) =>
  unwrap<{ bline_checked_at: string }[]>(
    await db
      .from('sales_orders')
      .select('bline_checked_at')
      .gte('bline_checked_at', '1970-01-01')
      .order('bline_checked_at', { ascending: false })
      .limit(1)
  )[0]?.bline_checked_at ?? null

/** What findelivers says about one BLine order. deliveredAt is for a delivered one only. */
export const recordBlineTracking = async (
  db: Db,
  tracking: {
    orderId: number
    ref: string
    status: string
    deliveredAt?: string | null
    problem?: string | null
  }
) =>
  unwrap<SalesOrder>(
    await db.rpc('record_bline_tracking', {
      p_order_id: tracking.orderId,
      p_ref: tracking.ref,
      p_status: tracking.status,
      p_delivered_at: tracking.deliveredAt ?? null,
      p_problem: tracking.problem ?? null,
    })
  )

/** Mark a BLine order delivered as of now. Already delivered: unchanged. */
export const markBlineDelivered = async (db: Db, orderId: number) =>
  unwrap<SalesOrder>(await db.rpc('mark_bline_delivered', { p_order_id: orderId }))

/** Forget a BLine order's delivery and findelivers match. */
export const clearBlineTracking = async (db: Db, orderId: number) =>
  unwrap<SalesOrder>(await db.rpc('clear_bline_tracking', { p_order_id: orderId }))
