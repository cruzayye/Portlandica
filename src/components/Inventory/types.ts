import type {
  Batch,
  BlineStockMove,
  BlineStockRow,
  LedgerCheckRow,
  LineProduct,
  MovementReason,
} from '@/lib/db/types'
import type { FileOrder, FindeliversRow, RowMatch } from '@/lib/findelivers'

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

/** What BLine has: per batch, and the latest cans sent, brought back and counted. */
export type BlineData = { stock: BlineStockRow[]; moves: BlineStockMove[] }

export type BlineLoadResult = ({ ok: true } & BlineData) | ActionFailure

/** Cans sent to BLine or brought back from it, or what BLine counted. */
export type BlineUpdate =
  | {
      kind: 'sent' | 'returned'
      batchId: number
      /** How many, more than 0. */
      cans: number
      /** YYYY-MM-DD, not after today */
      movedOn: string
      note: string | null
    }
  | {
      kind: 'count'
      batchId: number
      /** What BLine counted today, 0 or more. */
      counted: number
      /** What BLine should have on its shelf today, as the partner saw it. Refused if it has moved since. */
      expectedCount: number
      note: string
    }

/** After an update: what BLine has now. On failure, `data` is fresh when it was read. */
export type BlineUpdateResult =
  | ({ ok: true } & BlineData)
  | { ok: false; error: string; data?: BlineData }

/** BLine orders delivered in one month and BLine's fees for them, to check its bill against. */
export type BlineMonthFees = {
  /** YYYY-MM, in Portland. */
  month: string
  orders: number
  /** Dollars. */
  fees: number
}

/** BLine's deliveries, for the At BLine panel. */
export type BlineDeliveries = {
  /** Live BLine orders not delivered yet, oldest first. */
  waiting: FileOrder[]
  /** When a findelivers import last ran (ISO), or null if none has. */
  lastImport: string | null
  /** Last month and this month, when BLine delivered anything. */
  months: BlineMonthFees[]
}

export type BlineDeliveriesResult = ({ ok: true } & BlineDeliveries) | { ok: false; error: string }

/** A findelivers Orders CSV, read: its rows, the order each is matched to, and the orders to pick from. */
export type FindeliversReadResult =
  | {
      ok: true
      rows: FindeliversRow[]
      matches: RowMatch[]
      /** BLine orders booked around the file's dates, matched to its rows, or not delivered yet. */
      orders: FileOrder[]
      pickups: number
      unreadable: number
    }
  | { ok: false; error: string }

/** Record this row of the file on this order. */
export type FindeliversChoice = { ref: string; orderId: number }

export type FindeliversSaveResult =
  | {
      ok: true
      /** Rows recorded on their orders. */
      recorded: number
      /** Orders this import found delivered for the first time. */
      delivered: number
      /** Of those, Trello cards checked off. */
      checkedOff: number
      /** Rows that couldn't be recorded, and why. */
      problems: string[]
      /** Done, but something to finish by hand (a Trello card). */
      warnings: string[]
    }
  | { ok: false; error: string }
