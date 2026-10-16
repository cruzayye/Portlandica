'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import { listCustomers } from '@/lib/db/customers'
import { DbError, type DbErrorCode } from '@/lib/db/errors'
import {
  adjustBatch,
  archiveBatch,
  getBatch,
  ledgerMismatches,
  listBatches,
  listMovements,
  recordFill,
  unarchiveBatch,
} from '@/lib/db/inventory'
import { listOrderSummaries } from '@/lib/db/orderSummaries'
import type { Batch, Customer, Db } from '@/lib/db/types'
import { historyEntries } from '@/components/Inventory/history'
import { fillColumns } from '@/components/Inventory/stock'
import { formatCans } from '@/components/Inventory/units'
import {
  archiveProblem,
  countChangeProblem,
  fillProblem,
  isId,
  optionalNoteProblem,
} from '@/components/Inventory/validation'
import type {
  ActionFailure,
  BatchResult,
  CountChange,
  CustomerOption,
  HistoryResult,
  LedgerStatus,
  LoadResult,
  NewBatchInput,
} from '@/components/Inventory/types'

// The Inventory tab's actions. Every count change goes through the ledger functions in
// src/lib/db/inventory.ts, so each one is recorded with who made it and why. Problems are
// returned as { ok: false, error }, not thrown: production builds hide thrown messages.

const BATCH_GONE = 'This batch no longer exists. Refresh the list.'

const DB_MESSAGES: Partial<Record<DbErrorCode, string>> = {
  not_partner:
    "The database doesn't recognize this account as a partner. Its email also has to be on the partner list in Supabase.",
  batch_not_found: BATCH_GONE,
  batch_archived: 'This batch is archived. Unarchive it first.',
  customer_not_found: 'That customer no longer exists. Refresh and pick again.',
}

const failed = (action: string, err: unknown, fallback: string): ActionFailure => {
  if (err instanceof DbError) {
    const message = DB_MESSAGES[err.code]
    if (message) return { ok: false, error: message }
    // The ledger functions word their own input errors for people (P0001 is RAISE).
    if (err.code === 'invalid_input' && err.pgCode === 'P0001') {
      return { ok: false, error: err.message }
    }
  }
  console.error(`Inventory: could not ${action}`, err)
  return { ok: false, error: fallback }
}

/** Some live rows have no count or name. The tab shows 0 cans (as the ledger counts them). */
const tidy = (batch: Batch): Batch => ({
  ...batch,
  count: batch.count ?? 0,
  name: batch.name ?? 'Unnamed batch',
})

const cleanNote = (note: unknown) => (typeof note === 'string' && note.trim()) || undefined

const customerOption = (customer: Customer): CustomerOption => ({
  id: customer.id,
  name: customer.name,
  customCans: customer.custom_cans,
  active: customer.active,
})

const ledgerStatus = async (db: Db): Promise<LedgerStatus> => {
  try {
    return { mismatches: await ledgerMismatches(db) }
  } catch (err) {
    console.error('Inventory: could not check the ledger', err)
    return { error: 'Could not check that every count matches its history.' }
  }
}

/** Every batch (archived too), the customers, and any batch whose count doesn't match its history. */
export const loadInventory = async (): Promise<LoadResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  try {
    const db = await createClient()
    const [batches, customers, ledger] = await Promise.all([
      listBatches(db, { includeArchived: true }),
      listCustomers(db, { includeInactive: true }),
      ledgerStatus(db),
    ])
    return {
      ok: true,
      batches: batches.map(tidy),
      customers: customers.map(customerOption),
      ledger,
    }
  } catch (err) {
    return failed('load the inventory', err, 'Could not load the inventory. Try again.')
  }
}

/** Record a new fill. A custom batch is named after its customer. */
export const addBatch = async (input: NewBatchInput): Promise<BatchResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const problem = fillProblem(input)
  if (problem) return { ok: false, error: problem }

  try {
    const db = await createClient()
    const custom = input.kind === 'custom'
    const batch = await recordFill(db, {
      count: input.cans,
      ...fillColumns(input.product),
      fill_date: input.fillDate,
      name: custom ? null : input.name?.trim(),
      customer_id: custom ? input.customerId : null,
      source: input.source.trim(),
      total_cost: input.totalCost,
      invoice_number: input.invoiceNumber?.trim() || null,
      note: cleanNote(input.note),
    })
    return { ok: true, batch: tidy(batch) }
  } catch (err) {
    return failed('add a batch', err, 'Could not add the batch. Try again.')
  }
}

/** The batch as it is now, after someone else changed it while this partner was editing. */
const changedMeanwhile = async (db: Db, batchId: number): Promise<ActionFailure> => {
  const batch = await getBatch(db, batchId)
  if (!batch) return { ok: false, error: BATCH_GONE }
  const current = tidy(batch)
  return {
    ok: false,
    error: `Someone changed this batch to ${formatCans(current.count)} while you were editing. Check your count and save again.`,
    batch: current,
  }
}

/** Set a batch to a counted number of cans, with a note saying why. */
export const changeBatchCount = async (change: CountChange): Promise<BatchResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const problem = countChangeProblem(change)
  if (problem) return { ok: false, error: problem }

  try {
    const db = await createClient()
    try {
      const batch = await adjustBatch(db, change.batchId, change.newCount, change.note.trim(), {
        expectedCount: change.expectedCount,
      })
      return { ok: true, batch: tidy(batch) }
    } catch (err) {
      if (err instanceof DbError && err.code === 'count_changed') {
        return await changedMeanwhile(db, change.batchId)
      }
      throw err
    }
  } catch (err) {
    return failed('change a count', err, 'Could not change the count. Try again.')
  }
}

/** Archive instead of delete: whatever is left is written off, and the history stays. */
export const archiveInventoryBatch = async (
  batchId: number,
  note: string | null
): Promise<BatchResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  if (!isId(batchId)) return { ok: false, error: 'Pick a batch.' }

  try {
    const db = await createClient()
    const found = await getBatch(db, batchId)
    if (!found) return { ok: false, error: BATCH_GONE }
    const batch = tidy(found)
    if (batch.archived_at !== null) return { ok: true, batch }

    const problem = archiveProblem(batch.count, note)
    if (problem) return { ok: false, error: problem, batch }

    return { ok: true, batch: tidy(await archiveBatch(db, batchId, cleanNote(note))) }
  } catch (err) {
    return failed('archive a batch', err, 'Could not archive the batch. Try again.')
  }
}

/** Undo an archive, putting back the cans it wrote off. */
export const unarchiveInventoryBatch = async (
  batchId: number,
  note: string | null
): Promise<BatchResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  if (!isId(batchId)) return { ok: false, error: 'Pick a batch.' }
  const problem = optionalNoteProblem(note)
  if (problem) return { ok: false, error: problem }

  try {
    const db = await createClient()
    return { ok: true, batch: tidy(await unarchiveBatch(db, batchId, cleanNote(note))) }
  } catch (err) {
    return failed('unarchive a batch', err, 'Could not unarchive the batch. Try again.')
  }
}

/** A batch's history, newest first. */
export const getBatchHistory = async (batchId: number): Promise<HistoryResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  if (!isId(batchId)) return { ok: false, error: 'Pick a batch.' }

  try {
    const db = await createClient()
    const movements = await listMovements(db, batchId)
    const orderIds = movements.flatMap((m) => (m.order_id === null ? [] : [m.order_id]))
    // Order details only label the entries, so the history still shows without them.
    const orders = await listOrderSummaries(db, orderIds).catch((err: unknown) => {
      console.error('Inventory: could not look up orders for a batch history', err)
      return []
    })
    return { ok: true, entries: historyEntries(movements, orders) }
  } catch (err) {
    return failed('load a batch history', err, 'Could not load the history. Try again.')
  }
}
