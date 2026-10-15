import { unwrap } from './errors'
import type { Db, SalesOrder } from './types'

/** What a batch's history shows for an order or void movement. */
export type OrderSummary = Pick<SalesOrder, 'id' | 'customer_name' | 'order_date' | 'voided_at'>

/** The orders with these ids (repeats are fine), for labelling inventory movements. */
export const listOrderSummaries = async (db: Db, orderIds: number[]): Promise<OrderSummary[]> => {
  const ids = [...new Set(orderIds)]
  if (ids.length === 0) return []
  return unwrap<OrderSummary[]>(
    await db
      .from('sales_orders')
      .select('id, customer_name, order_date, voided_at')
      .in('id', ids)
      .order('id')
  )
}
