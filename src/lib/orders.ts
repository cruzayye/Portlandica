import type { NewOrder } from '@/types/orders'

/**
 * Cans ordered for each product. A product that is switched off counts as
 * zero, even if its quantity field still holds a number from before.
 */
export const stillCans = (order: Pick<NewOrder, 'isStill' | 'totalStill'>) =>
  order.isStill ? (order.totalStill ?? 0) : 0

export const sparkCans = (order: Pick<NewOrder, 'isSpark' | 'totalSpark'>) =>
  order.isSpark ? (order.totalSpark ?? 0) : 0
