import type { Inventory } from '@/types/orders'

/**
 * Batches an order may draw from: standard stock, plus custom fills made for
 * this specific customer. Another customer's custom fill is never offered.
 */
export const batchesFor = (
  inventory: Inventory[],
  isStill: boolean,
  customerName: string | null,
) =>
  inventory.filter(
    (item) => item.isStill === isStill && (!item.isCustom || item.name === customerName),
  )

/** Custom fills made specifically for this customer. */
export const customBatchesFor = (batches: Inventory[], customerName: string | null) =>
  batches.filter((item) => item.isCustom && item.name === customerName)

/**
 * Which batch to preselect. A single custom fill for this customer wins
 * outright; otherwise the only available batch; otherwise nothing, so the
 * user has to choose rather than silently getting whichever sorted first.
 */
export const preselectBatchId = (
  batches: Inventory[],
  customBatches: Inventory[],
): number | '' =>
  customBatches.length === 1
    ? customBatches[0].id
    : batches.length === 1
      ? batches[0].id
      : ''

/** The batch the user picked, while it is still on offer; otherwise the preselected one. */
export const chosenBatchId = (
  pick: number | '',
  batches: Inventory[],
  customBatches: Inventory[],
): number | '' =>
  pick !== '' && batches.some((item) => item.id === pick)
    ? pick
    : preselectBatchId(batches, customBatches)
