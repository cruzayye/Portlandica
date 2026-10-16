import type { Batch, LedgerCheckRow, LineProduct, MovementReason } from '@/lib/db/types'

// Shapes shared by the Inventory tab and its server actions (src/app/actions/batches.ts).

/** What a batch holds, as the tab groups it: the same values an order line uses. */
export type StockProduct = LineProduct

/** House stock, or custom cans filled for one customer. */
export type StockKind = 'house' | 'custom'

/** A customer as the tab needs one: to name custom batches and to pick one for a fill. */
export type CustomerOption = { id: number; name: string; customCans: boolean; active: boolean }

/** Batches whose count doesn't match their history, or why that couldn't be checked. */
export type LedgerStatus = { mismatches: LedgerCheckRow[] } | { error: string }

export type InventoryData = {
  /** Every batch, archived ones included. */
  batches: Batch[]
  customers: CustomerOption[]
  ledger: LedgerStatus
}

/**
 * An action that couldn't do what was asked. `batch` is the batch as it is now, when the
 * reason is that it changed (so the tab can show the new count).
 */
export type ActionFailure = { ok: false; error: string; batch?: Batch }

export type LoadResult = ({ ok: true } & InventoryData) | ActionFailure

export type BatchResult = { ok: true; batch: Batch } | ActionFailure

export type NewBatchInput = {
  kind: StockKind
  product: StockProduct
  cans: number
  /** House stock only. A custom batch takes its customer's name. */
  name: string | null
  /** Custom cans only. */
  customerId: number | null
  source: string
  /** YYYY-MM-DD */
  fillDate: string
  totalCost: number | null
  invoiceNumber: string | null
  note: string | null
}

export type CountChange = {
  batchId: number
  /** The counted number of cans. */
  newCount: number
  /** The count the partner was looking at. The change is refused if it has moved since. */
  expectedCount: number
  note: string
}

/** Who made a change: the team, in the app, or the system (setup, the SQL Editor, the dashboard). */
export type ChangedBy = 'team' | 'system'

export type HistoryOrder = {
  id: number
  customerName: string | null
  orderDate: string | null
  voided: boolean
}

export type HistoryEntry = {
  id: number
  at: string
  /** Cans in (+) or out (-). */
  change: number
  /** The batch's count after this change, by its history. */
  balance: number
  reason: MovementReason
  order: HistoryOrder | null
  by: ChangedBy
  note: string | null
}

export type HistoryResult = { ok: true; entries: HistoryEntry[] } | ActionFailure
