import type { OrderSummary } from '@/lib/db/orderSummaries'
import type { InventoryMovement } from '@/lib/db/types'
import type { ChangedBy, HistoryEntry, HistoryOrder } from './types'
import { formatDay } from './dates'

export const changedBy = (createdBy: string | null, viewerId: string): ChangedBy =>
  createdBy === null ? 'system' : createdBy === viewerId ? 'you' : 'partner'

export const CHANGED_BY_LABELS: Record<ChangedBy, string> = {
  you: 'You',
  partner: 'Other partner',
  system: 'System',
}

/**
 * A batch's ledger movements as history, newest first. Each entry carries the count the
 * batch had after it, adding the movements up from the oldest.
 */
export const historyEntries = (
  movements: InventoryMovement[],
  orders: OrderSummary[],
  viewerId: string
): HistoryEntry[] => {
  const ordersById = new Map(orders.map((order) => [order.id, order]))
  let balance = 0
  return [...movements]
    .sort((a, b) => a.id - b.id)
    .map((movement) => {
      balance += movement.delta
      const order = movement.order_id === null ? null : ordersById.get(movement.order_id)
      return {
        id: movement.id,
        at: movement.created_at,
        change: movement.delta,
        balance,
        reason: movement.reason,
        order:
          movement.order_id === null
            ? null
            : {
                id: movement.order_id,
                customerName: order?.customer_name ?? null,
                orderDate: order?.order_date ?? null,
                voided: Boolean(order?.voided_at),
              },
        by: changedBy(movement.created_by, viewerId),
        note: movement.note,
      }
    })
    .reverse()
}

/**
 * What happened, in words. An archive always leaves the batch at 0; putting the cans back
 * (unarchive) leaves it above.
 */
export const reasonLabel = (entry: Pick<HistoryEntry, 'reason' | 'balance'>) => {
  switch (entry.reason) {
    case 'opening':
      return 'Opening count'
    case 'fill':
      return 'Filled'
    case 'order':
      return 'Order'
    case 'void':
      return 'Order voided'
    case 'adjustment':
      return 'Count changed'
    case 'archive':
      return entry.balance === 0 ? 'Archived' : 'Unarchived'
  }
}

export const orderLabel = (order: HistoryOrder) =>
  [
    `Order #${order.id}`,
    order.customerName,
    formatDay(order.orderDate),
    order.voided ? 'voided' : null,
  ]
    .filter(Boolean)
    .join(' · ')
