'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import { listBlineMoves, listBlineStock, recordBlineMove, setBlineCount } from '@/lib/db/bline'
import { DbError, type DbErrorCode } from '@/lib/db/errors'
import type { Db } from '@/lib/db/types'
import type {
  BlineData,
  BlineLoadResult,
  BlineUpdate,
  BlineUpdateResult,
} from '@/components/Inventory/types'
import { formatCans } from '@/components/Inventory/units'
import { blineUpdateProblem } from '@/components/Inventory/validation'

// What BLine has, for the Inventory tab: cans sent there, brought back, and BLine's counts
// (src/lib/db/bline.ts). BLine orders take their cans off on their own. Problems are
// returned as { ok: false, error }, not thrown: production builds hide thrown messages.

const DB_MESSAGES: Partial<Record<DbErrorCode, string>> = {
  not_partner:
    'The database refused the app. Check that SUPABASE_SECRET_KEY in Vercel is the secret key (see SETUP.md).',
  batch_not_found: 'That batch no longer exists. Refresh and pick again.',
  batch_archived: 'That batch is archived. Unarchive it first.',
}

const failure = (action: string, err: unknown, fallback: string) => {
  if (err instanceof DbError) {
    const message = DB_MESSAGES[err.code]
    if (message) return message
    // The SQL functions word their own input errors for people (P0001 is RAISE).
    if (err.code === 'invalid_input' && err.pgCode === 'P0001') return err.message
  }
  console.error(`BLine: could not ${action}`, err)
  return fallback
}

const blineData = async (db: Db): Promise<BlineData> => {
  const [stock, moves] = await Promise.all([listBlineStock(db), listBlineMoves(db)])
  return { stock, moves }
}

/** What BLine should have of each batch, and the latest cans sent, brought back and counted. */
export const loadBlineStock = async (): Promise<BlineLoadResult | AuthFailure> => {
  const { failure: auth } = await requireUser()
  if (auth) return auth

  try {
    return { ok: true, ...(await blineData(await createClient())) }
  } catch (err) {
    return {
      ok: false,
      error: failure('load what BLine has', err, 'Could not load what BLine has. Try again.'),
    }
  }
}

/** Record cans sent to BLine or brought back, or set what BLine has to what they counted. */
export const updateBlineStock = async (
  update: BlineUpdate
): Promise<BlineUpdateResult | AuthFailure> => {
  const { failure: auth } = await requireUser()
  if (auth) return auth

  const problem = blineUpdateProblem(update)
  if (problem) return { ok: false, error: problem }

  try {
    const db = await createClient()
    try {
      if (update.kind === 'count') {
        await setBlineCount(db, {
          batchId: update.batchId,
          counted: update.counted,
          note: update.note.trim(),
          expectedCount: update.expectedCount,
        })
      } else {
        await recordBlineMove(db, {
          batchId: update.batchId,
          cans: update.cans,
          reason: update.kind,
          movedOn: update.movedOn,
          note: update.note?.trim() || null,
        })
      }
    } catch (err) {
      if (err instanceof DbError && err.code === 'count_changed') {
        const data = await blineData(db)
        const now = data.stock.find((row) => row.batch_id === update.batchId)?.on_hand ?? 0
        return {
          ok: false,
          error: `An order changed what BLine should have today to ${formatCans(now)} while you were counting. Check the count and save again.`,
          data,
        }
      }
      throw err
    }
    return { ok: true, ...(await blineData(db)) }
  } catch (err) {
    return {
      ok: false,
      error: failure('update what BLine has', err, 'Could not save that. Try again.'),
    }
  }
}
