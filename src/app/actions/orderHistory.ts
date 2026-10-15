'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import type { OrderHistory, RetryResult, VoidResult } from '@/types/orders'
import { listBatches } from '@/lib/db/inventory'
import {
  getSalesOrder,
  listRecentOrders,
  recordOrderStep,
  voidSalesOrder,
} from '@/lib/db/orders'
import { findOrderRows, untagOrderRows } from '@/lib/google/sheets'
import { archiveTrelloCard } from '@/lib/trello'
import { runOrderSteps } from '@/lib/orderSteps'
import { describeSheetRef } from '@/lib/orders'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

const isOrderId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** The most recent orders, voided ones included, newest first. */
export const listOrders = async (): Promise<OrderHistory | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  try {
    const db = await createClient()
    const [orders, batches] = await Promise.all([
      listRecentOrders(db, { limit: 50 }),
      listBatches(db, { includeArchived: true }),
    ])
    return {
      orders,
      batches: batches.map(({ id, name, isStill, fillDate }) => ({ id, name, isStill, fillDate })),
      error: null,
    }
  } catch (err) {
    console.error('listOrders failed', err)
    return { orders: [], batches: [], error: `Couldn't load the orders (${reason(err)}).` }
  }
}

/**
 * Run an order's unfinished steps again. Steps that are done are left alone. Pass
 * allowNegativeInventory once the user has agreed to take more cans than a batch has.
 */
export const retryOrder = async (
  orderId: number,
  { allowNegativeInventory = false }: { allowNegativeInventory?: boolean } = {}
): Promise<RetryResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (!isOrderId(orderId)) return { status: 'failed', message: 'No such order.' }

  try {
    const db = await createClient()
    const run = await runOrderSteps(db, orderId, {
      retry: true,
      allowNegativeInventory: allowNegativeInventory === true,
    })
    return { status: 'done', ...run }
  } catch (err) {
    console.error(`retryOrder ${orderId} failed`, err)
    return { status: 'failed', message: `The retry didn't run (${reason(err)}). Try again.` }
  }
}

/**
 * Void an order: its cans go back to their batches and its Trello card is archived.
 * The Sales sheet and Square are not changed; the result lists what to fix there by hand.
 */
export const voidOrder = async (
  orderId: number,
  why: string
): Promise<VoidResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (!isOrderId(orderId)) return { status: 'failed', message: 'No such order.' }
  if (typeof why !== 'string' || !why.trim()) {
    return { status: 'failed', message: 'Say why the order is being voided.' }
  }

  try {
    const db = await createClient()
    const voided = await voidSalesOrder(db, orderId, why.trim())
    const handFixes: string[] = []

    if (voided.trello_card_id) {
      try {
        await archiveTrelloCard(voided.trello_card_id)
      } catch (err) {
        console.error(`voidOrder ${orderId}: archiving the Trello card failed`, err)
        handFixes.push(`Archive this order's Trello card by hand (${reason(err)}).`)
      }
    }

    if (voided.sheet_status === 'done' && voided.sheet_ref) {
      handFixes.push(
        `${describeSheetRef(voided.sheet_ref)} still show this order. Fix them by hand (the app doesn't edit Sales rows).`
      )
    } else {
      // An attempt that didn't finish may still have written rows.
      try {
        const ref = await findOrderRows(voided.idempotency_key)
        if (ref) {
          handFixes.push(
            `${describeSheetRef(ref)} were written by an attempt that didn't finish. Remove them by hand.`
          )
          await recordOrderStep(db, orderId, 'sheet', 'failed', {
            externalId: ref,
            error: "Written by an attempt that didn't finish; the order is void.",
          })
          await untagOrderRows(voided.idempotency_key)
        }
      } catch (err) {
        console.error(`voidOrder ${orderId}: checking the sheet failed`, err)
        handFixes.push(
          `Check the Sales sheet for rows from this order; the check didn't run (${reason(err)}).`
        )
      }
    }

    if (voided.square_invoice_id) {
      handFixes.push(
        'Delete the draft invoice for this order in the Square Dashboard (Invoices). The app never changes Square invoices once made.'
      )
    }

    const order = await getSalesOrder(db, orderId)
    return { status: 'voided', order: order ?? { ...voided, lines: [] }, handFixes }
  } catch (err) {
    console.error(`voidOrder ${orderId} failed`, err)
    return { status: 'failed', message: `The order wasn't voided (${reason(err)}).` }
  }
}
