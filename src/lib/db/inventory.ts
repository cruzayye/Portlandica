import { customerKey } from './customers'
import { unwrap } from './errors'
import type {
  Batch,
  BatchProduct,
  Db,
  InventoryMovement,
  LedgerCheckRow,
  LineProduct,
} from './types'

// Inventory batches and their ledger. Every count change goes through a SQL function that
// writes a movement in the same transaction (see 20261017000500_batch_functions.sql).

export const listBatches = async (
  db: Db,
  { includeArchived = false }: { includeArchived?: boolean } = {}
): Promise<Batch[]> => {
  let query = db.from('inventory').select('*')
  if (!includeArchived) query = query.is('archived_at', null)
  return unwrap<Batch[]>(await query.order('name').order('fillDate'))
}

export const getBatch = async (db: Db, id: number) =>
  unwrap<Batch | null>(await db.from('inventory').select('*').eq('id', id).maybeSingle())

/** Whether a batch holds what an order line is for. Dog water never fills a still line. */
export const batchHoldsProduct = (
  batch: Pick<Batch, 'isStill' | 'product'>,
  product: LineProduct
) =>
  product === 'dog_water'
    ? batch.product === 'dog_water'
    : batch.product === 'water' && batch.isStill === (product === 'still')

/**
 * Batches an order line may draw from: live batches of the right product that are house
 * stock or custom cans filled for this customer. A custom batch not yet linked to a
 * customer falls back to a trimmed, case-insensitive name match.
 */
export const batchesForLine = (
  batches: Batch[],
  product: LineProduct,
  customer: { id: number | null; name: string | null }
) =>
  batches.filter(
    (batch) =>
      batch.archived_at === null &&
      batchHoldsProduct(batch, product) &&
      (!batch.isCustom ||
        (batch.customer_id !== null
          ? batch.customer_id === customer.id
          : customer.name !== null && customerKey(batch.name) === customerKey(customer.name)))
  )

export type FillInput = {
  count: number
  is_still: boolean
  fill_date: string | null
  /** Required for house stock; a custom batch defaults to its customer's name. */
  name?: string | null
  /** Set for custom cans. */
  customer_id?: number | null
  product?: BatchProduct
  source?: string | null
  total_cost?: number | null
  invoice_number?: string | null
  note?: string | null
}

/** Add a new batch; its fill is recorded in the ledger. */
export const recordFill = async (db: Db, fill: FillInput) =>
  unwrap<Batch>(
    await db.rpc('record_fill', {
      p_count: fill.count,
      p_is_still: fill.is_still,
      p_fill_date: fill.fill_date,
      p_name: fill.name ?? null,
      p_customer_id: fill.customer_id ?? null,
      p_product: fill.product ?? 'water',
      p_source: fill.source ?? null,
      p_total_cost: fill.total_cost ?? null,
      p_invoice_number: fill.invoice_number ?? null,
      p_note: fill.note ?? null,
    })
  )

/**
 * Set a batch to a counted number of cans with a note saying why. Pass expectedCount (the
 * count the user was looking at) to fail with 'count_changed' instead of overwriting a
 * change someone else made in the meantime.
 */
export const adjustBatch = async (
  db: Db,
  batchId: number,
  newCount: number,
  note: string,
  { expectedCount }: { expectedCount?: number } = {}
) =>
  unwrap<Batch>(
    await db.rpc('adjust_batch', {
      p_batch_id: batchId,
      p_new_count: newCount,
      p_note: note,
      p_expected_count: expectedCount ?? null,
    })
  )

/** Archive instead of delete: remaining cans are written off in the ledger. */
export const archiveBatch = async (db: Db, batchId: number, note?: string) =>
  unwrap<Batch>(await db.rpc('archive_batch', { p_batch_id: batchId, p_note: note ?? null }))

/** Undo archiveBatch, restoring the cans it wrote off. */
export const unarchiveBatch = async (db: Db, batchId: number, note?: string) =>
  unwrap<Batch>(await db.rpc('unarchive_batch', { p_batch_id: batchId, p_note: note ?? null }))

/** A batch's history, oldest first. */
export const listMovements = async (db: Db, batchId: number) =>
  unwrap<InventoryMovement[]>(
    await db.from('inventory_movements').select('*').eq('batch_id', batchId).order('id')
  )

/** Batches whose count doesn't match their ledger. Should always be empty. */
export const ledgerMismatches = async (db: Db) =>
  unwrap<LedgerCheckRow[]>(
    await db.from('inventory_ledger_check').select('*').neq('difference', 0).order('batch_id')
  )
