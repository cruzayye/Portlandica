import type { Batch } from '@/lib/db/types'
import type { StockKind, StockProduct } from './types'

/**
 * The banner at the top of the tab warns when house still or house sparkling stock is
 * below this many cans (2,000 cans is about 83 cases). Change it here.
 */
export const LOW_STOCK_THRESHOLD_CANS = 2_000

export const PRODUCTS: StockProduct[] = ['still', 'sparkling']

export const PRODUCT_LABELS: Record<StockProduct, string> = {
  still: 'Still',
  sparkling: 'Sparkling',
}

export const KIND_LABELS: Record<StockKind, string> = {
  house: 'House stock',
  custom: 'Custom cans',
}

/** What a batch holds: still or sparkling ("Portlandica Dog water" is house still stock). */
export const productOf = (batch: Pick<Batch, 'isStill'>): StockProduct =>
  batch.isStill ? 'still' : 'sparkling'

/** The batch columns record_fill takes for a product. */
export const fillColumns = (product: StockProduct) => ({ is_still: product === 'still' })

export const kindOf = (batch: Pick<Batch, 'isCustom'>): StockKind =>
  batch.isCustom ? 'custom' : 'house'

export const isArchived = (batch: Pick<Batch, 'archived_at'>) => batch.archived_at !== null

const sumCans = (batches: Batch[]) => batches.reduce((total, batch) => total + batch.count, 0)

/** By name, then oldest fill first (the order the list and the order form use). */
const byNameThenFill = (a: Batch, b: Batch) =>
  a.name.localeCompare(b.name) ||
  (a.fillDate ?? '9999').localeCompare(b.fillDate ?? '9999') ||
  a.id - b.id

export type BatchGroup = {
  product: StockProduct
  kind: StockKind
  batches: Batch[]
  /** Cans on hand across the group. */
  cans: number
}

/**
 * Batches still in use, by product (still, then sparkling) and then house stock before
 * custom cans. Groups with no batches are left out.
 */
export const groupBatches = (batches: Batch[]): BatchGroup[] =>
  PRODUCTS.flatMap((product) =>
    (['house', 'custom'] as const).map((kind) => {
      const members = batches
        .filter(
          (batch) => !isArchived(batch) && productOf(batch) === product && kindOf(batch) === kind
        )
        .sort(byNameThenFill)
      return { product, kind, batches: members, cans: sumCans(members) }
    })
  ).filter((group) => group.batches.length > 0)

/** Archived batches, most recently archived first. */
export const archivedBatches = (batches: Batch[]) =>
  batches
    .filter(isArchived)
    .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '') || a.id - b.id)

/** House still and sparkling stock that is below the threshold, with the cans left. */
export const lowStock = (batches: Batch[], threshold = LOW_STOCK_THRESHOLD_CANS) =>
  (['still', 'sparkling'] as const)
    .map((product) => ({
      product,
      cans: sumCans(
        batches.filter(
          (batch) => !isArchived(batch) && kindOf(batch) === 'house' && productOf(batch) === product
        )
      ),
    }))
    .filter(({ cans }) => cans < threshold)

/** Batches in use whose count is below zero: more cans went out than the count had. */
export const negativeBatches = (batches: Batch[]) =>
  batches.filter((batch) => !isArchived(batch) && batch.count < 0).sort(byNameThenFill)
