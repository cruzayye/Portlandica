import { unwrap } from './errors'
import type { BlineStockMove, BlineStockRow, Db } from './types'

// What BLine holds, per batch (see 20261109000100_bline_delivery.sql). Cans sent to BLine,
// brought back and BLine's counts go through SQL functions; BLine orders take their cans off
// on their own, and voiding one puts them back.

/** What BLine should have of each batch it holds or delivered from. */
export const listBlineStock = async (db: Db) =>
  unwrap<BlineStockRow[]>(await db.from('bline_stock').select('*').order('batch_id'))

/** The latest cans sent, brought back and counted, newest first. */
export const listBlineMoves = async (db: Db, { limit = 20 }: { limit?: number } = {}) =>
  unwrap<BlineStockMove[]>(
    await db.from('bline_stock_moves').select('*').order('id', { ascending: false }).limit(limit)
  )

/** Cans of one batch sent to BLine or brought back. cans is how many, more than 0. */
export const recordBlineMove = async (
  db: Db,
  move: {
    batchId: number
    cans: number
    reason: 'sent' | 'returned'
    /** YYYY-MM-DD, not after today. Defaults to today in Portland. */
    movedOn?: string | null
    note?: string | null
  }
) =>
  unwrap<BlineStockMove>(
    await db.rpc('record_bline_move', {
      p_batch_id: move.batchId,
      p_cans: move.cans,
      p_reason: move.reason,
      p_moved_on: move.movedOn ?? null,
      p_note: move.note ?? null,
    })
  )

/**
 * BLine counted this many cans of a batch today: records the difference from what they
 * should have on their shelf today (on_hand). Pass expectedCount (the on_hand the user was
 * looking at) to fail with 'count_changed' instead, if an order changed it meanwhile. Null
 * when the count already matches.
 */
export const setBlineCount = async (
  db: Db,
  count: { batchId: number; counted: number; note: string; expectedCount?: number | null }
) =>
  unwrap<BlineStockMove[]>(
    await db.rpc('set_bline_count', {
      p_batch_id: count.batchId,
      p_counted: count.counted,
      p_note: count.note,
      p_expected_count: count.expectedCount ?? null,
    })
  )[0] ?? null
