import type { CustomerType, NewOrder, OrderBatches } from '@/types/orders'

/** The Sales sheet's Type column (B) for each kind of customer. */
export const salesType = (customerType: CustomerType) =>
  customerType === 'individual' ? 'Individual' : 'Business'

/**
 * Cans ordered for each product. A product that is switched off counts as
 * zero, even if its quantity field still holds a number from before.
 */
export const stillCans = (order: Pick<NewOrder, 'isStill' | 'totalStill'>) =>
  order.isStill ? (order.totalStill ?? 0) : 0

export const sparkCans = (order: Pick<NewOrder, 'isSpark' | 'totalSpark'>) =>
  order.isSpark ? (order.totalSpark ?? 0) : 0

/**
 * Why an order can't be booked as it stands, or null if it can. createOrder
 * checks this before writing anything.
 */
export const orderProblem = (order: NewOrder, batches: OrderBatches): string | null => {
  if (!order.name?.trim()) return 'Enter the customer name.'
  if (!order.isStill && !order.isSpark) return 'Choose Still or Sparkling.'
  if (order.isStill && stillCans(order) <= 0) return 'Enter how much Still water.'
  if (order.isSpark && sparkCans(order) <= 0) return 'Enter how much Sparkling water.'
  if (order.isStill && !batches.still) return 'Pick the Still batch this order comes from.'
  if (order.isSpark && !batches.spark) return 'Pick the Sparkling batch this order comes from.'
  if (!order.deliveryType) return 'Choose Drop, Ship or Pickup.'
  if (!order.isDonation && !((order.price ?? 0) > 0)) {
    return 'Enter a price, or mark this order as a donation.'
  }
  return null
}
