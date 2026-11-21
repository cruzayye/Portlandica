import { pacificDate } from '@/lib/delivery'
import { trackingSummary, type FileOrder } from '@/lib/findelivers'

// BLine's deliveries as the At BLine panel words them. Pure, so it can be tested on its own.

/** "Nov 19" for a YYYY-MM-DD date. */
export const shortDay = (isoDate: string) =>
  new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })

/** "November 2026" for YYYY-MM. */
export const monthName = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  })

/**
 * Where a BLine order still to deliver stands, and whether someone should look: findelivers
 * hasn't got it a day after it was booked (an import since didn't find it), its delivery is
 * in trouble, or its delivery date has passed.
 */
export const waitingSummary = (
  order: FileOrder,
  lastImport: string | null,
  today: string
): { text: string; warn: boolean } => {
  const missing =
    order.blineRef === null &&
    lastImport !== null &&
    pacificDate(new Date(lastImport)) > order.orderDate
  const summary = missing
    ? { text: 'Not in findelivers: email BLine if it should be', warn: true }
    : trackingSummary(order)
  const late = (order.deliveryDate ?? order.orderDate) < today
  return late ? { text: `${summary.text} · past its delivery date`, warn: true } : summary
}

/** "#85 Hillside Clinic · booked Nov 19 · for Nov 21" */
export const waitingTitle = (order: FileOrder) =>
  [
    `#${order.id} ${order.customerName}`,
    `booked ${shortDay(order.orderDate)}`,
    order.deliveryDate ? `for ${shortDay(order.deliveryDate)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

const money = (dollars: number) =>
  dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** "November 2026: 9 delivered, $128.40 in BLine fees" */
export const monthLine = ({
  month,
  orders,
  fees,
}: {
  month: string
  orders: number
  fees: number
}) => `${monthName(month)}: ${orders} delivered, ${money(fees)} in BLine fees`
