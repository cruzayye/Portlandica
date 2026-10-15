import type { Batch } from '@/lib/db/types'
import type { BatchOption, OrderProduct } from '@/types/orders'
import { batchHoldsProduct } from '@/lib/db/inventory'

/** A batch as people say it: "Portlandica Still", "Hollywood Theatre Sparkling". */
export const batchTitle = (batch: Pick<Batch, 'name' | 'isStill'>) =>
  `${batch.name} ${batch.isStill ? 'Still' : 'Sparkling'}`

/**
 * Batches an order line may draw from: batches holding this product that are house stock
 * or custom cans filled for this customer, matched by customer id. Another customer's
 * custom fill, and a custom fill not linked to any customer yet, are never offered.
 */
export const batchesForCustomer = <T extends BatchOption>(
  batches: T[],
  product: OrderProduct,
  customerId: number | null
) =>
  batches.filter(
    (batch) =>
      batchHoldsProduct(batch, product) &&
      (!batch.isCustom || (customerId !== null && batch.customer_id === customerId))
  )

/** Custom fills among the batches on offer. */
export const customBatches = <T extends Pick<BatchOption, 'isCustom'>>(batches: T[]) =>
  batches.filter((batch) => batch.isCustom)

/**
 * Which batch to preselect. A single custom fill for this customer wins
 * outright; otherwise the only available batch; otherwise nothing, so the
 * user has to choose rather than silently getting whichever sorted first.
 */
export const preselectBatchId = (
  batches: Pick<BatchOption, 'id'>[],
  custom: Pick<BatchOption, 'id'>[]
): number | '' => (custom.length === 1 ? custom[0].id : batches.length === 1 ? batches[0].id : '')

/** The batch the user picked, while it is still on offer; otherwise the preselected one. */
export const chosenBatchId = (
  pick: number | '',
  batches: Pick<BatchOption, 'id'>[],
  custom: Pick<BatchOption, 'id'>[]
): number | '' =>
  pick !== '' && batches.some((batch) => batch.id === pick)
    ? pick
    : preselectBatchId(batches, custom)

/** The picker's label: name, fill date, cans left and source. */
export const batchLabel = (batch: BatchOption) =>
  [
    `${batchTitle(batch)}${batch.isCustom ? ' (Custom)' : ''}`,
    batch.fillDate,
    `${Number(batch.count ?? 0).toLocaleString('en-US')} left`,
    batch.source,
  ]
    .filter(Boolean)
    .join(' · ')
