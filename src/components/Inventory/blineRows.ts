import { BLINE_LOW_STOCK_CANS } from '@/lib/bline'
import { batchTitle } from '@/lib/batches'
import type { Batch, BlineMoveReason, BlineStockRow } from '@/lib/db/types'
import { PRODUCTS, isArchived } from './stock'
import type { StockProduct } from './types'

// What BLine has, as the Inventory tab shows it. Pure, so it can be tested on its own.

export const BLINE_REASON_LABELS: Record<BlineMoveReason, string> = {
  sent: 'Sent to BLine',
  returned: 'Brought back',
  count: "BLine's count",
}

const productOfRow = (row: Pick<BlineStockRow, 'is_still'>): StockProduct =>
  row.is_still ? 'still' : 'sparkling'

/** A BLine row's batch as people say it: "Portlandica Still". */
export const blineRowTitle = (row: BlineStockRow, batches: Batch[]) => {
  const batch = batches.find((b) => b.id === row.batch_id)
  return batch
    ? batchTitle(batch)
    : batchTitle({ name: row.name ?? `Batch ${row.batch_id}`, isStill: Boolean(row.is_still) })
}

/**
 * Rows BLine still has cans of, or is below zero on, still before sparkling. A batch whose
 * cans are all for booked deliveries still has them on the shelf until they go out.
 */
export const blineHoldings = (stock: BlineStockRow[]) =>
  PRODUCTS.flatMap((product) =>
    stock.filter(
      (row) => (row.remaining !== 0 || row.on_hand !== 0) && productOfRow(row) === product
    )
  )

/**
 * Products BLine is running low on: under BLINE_LOW_STOCK_CANS across its batches, but
 * not below zero (that has its own warning). Only products BLine has ever had.
 */
export const blineLow = (stock: BlineStockRow[]) =>
  PRODUCTS.flatMap((product) => {
    const rows = stock.filter((row) => productOfRow(row) === product)
    const cans = rows.reduce((sum, row) => sum + row.remaining, 0)
    return rows.length && cans >= 0 && cans < BLINE_LOW_STOCK_CANS ? [{ product, cans }] : []
  })

/** Batches BLine is below zero on: more went out on BLine orders than was sent. */
export const blineNegative = (stock: BlineStockRow[]) => stock.filter((row) => row.remaining < 0)

/** What BLine has left of a batch once every booked delivery is made: 0 for one it doesn't hold. */
export const atBline = (stock: BlineStockRow[], batchId: number | '') =>
  stock.find((row) => row.batch_id === batchId)?.remaining ?? 0

/** What BLine should have of a batch on its shelf today (cans for later deliveries included). */
export const onHandAtBline = (stock: BlineStockRow[], batchId: number | '') =>
  stock.find((row) => row.batch_id === batchId)?.on_hand ?? 0

/** Batches cans can be sent from: live ones, house stock first. */
export const sendableBatches = (batches: Batch[]) =>
  batches
    .filter((batch) => !isArchived(batch))
    .sort(
      (a, b) =>
        Number(a.isCustom) - Number(b.isCustom) ||
        Number(b.isStill) - Number(a.isStill) ||
        a.name.localeCompare(b.name) ||
        a.id - b.id
    )
