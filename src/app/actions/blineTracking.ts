'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import {
  clearBlineTracking,
  lastFindeliversImport,
  listBlineOrdersBooked,
  listBlineOrdersById,
  listBlineOrdersByRef,
  listBlineOrdersDeliveredSince,
  listUndeliveredBlineOrders,
  markBlineDelivered,
  recordBlineTracking,
  type BlineDelivery,
} from '@/lib/db/blineTracking'
import { DbError } from '@/lib/db/errors'
import { getSalesOrder, markInvoicedOutsideSquare } from '@/lib/db/orders'
import type { Db } from '@/lib/db/types'
import { pacificDate, pacificWallTime } from '@/lib/delivery'
import {
  MATCH_WINDOW,
  MAX_FILE_CHARS,
  MAX_FILE_ROWS,
  matchRows,
  parseFindeliversCsv,
  type FileOrder,
} from '@/lib/findelivers'
import { setTrelloCardComplete } from '@/lib/trello'
import type {
  BlineDeliveriesResult,
  BlineMonthFees,
  FindeliversChoice,
  FindeliversReadResult,
  FindeliversSaveResult,
} from '@/components/Inventory/types'
import type { DeliveryResult } from '@/types/orders'

// BLine deliveries as findelivers.com (BLine's delivery software) reports them: its Orders
// CSV read and matched to our BLine orders (src/lib/findelivers.ts), what the At BLine panel
// lists, and deliveries marked by hand from Order History. A newly delivered order's Trello
// card is checked off. Problems are returned, not thrown: production builds hide thrown
// messages.

const NOT_PARTNER =
  'The database refused the app. Check that SUPABASE_SECRET_KEY in Vercel is the secret key (see SETUP.md).'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

const isOrderId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const toFileOrder = (order: BlineDelivery): FileOrder => ({
  id: order.id,
  customerName: order.customer_name,
  address: order.delivery_address,
  orderDate: order.order_date,
  deliveryDate: order.delivery_date,
  totalCans: order.total_cans,
  voided: order.voided_at !== null,
  blineRef: order.bline_ref,
  blineStatus: order.bline_status,
  blineProblem: order.bline_problem,
  deliveredAt: order.delivered_at,
})

const shiftDate = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const monthOf = (iso: string) => pacificDate(new Date(iso)).slice(0, 7)

// Last month and this month in Portland: what BLine delivered and its fees, for its bill.
const monthFees = async (db: Db, now: Date): Promise<BlineMonthFees[]> => {
  const [year, month] = pacificDate(now).split('-').map(Number)
  const since = pacificWallTime(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1, 1)
  const delivered = await listBlineOrdersDeliveredSince(db, since.toISOString())
  const months = new Map<string, BlineMonthFees>()
  for (const order of delivered) {
    const key = monthOf(order.delivered_at!)
    const entry = months.get(key) ?? { month: key, orders: 0, fees: 0 }
    entry.orders += 1
    entry.fees = Math.round((entry.fees + Number(order.delivery_fee ?? 0)) * 100) / 100
    months.set(key, entry)
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/** BLine orders still to deliver, when findelivers was last imported, and fees by month. */
export const loadBlineDeliveries = async (): Promise<BlineDeliveriesResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  try {
    const db = await createClient()
    const [waiting, lastImport, months] = await Promise.all([
      listUndeliveredBlineOrders(db),
      lastFindeliversImport(db),
      monthFees(db, new Date()),
    ])
    return { ok: true, waiting: waiting.map(toFileOrder), lastImport, months }
  } catch (err) {
    if (err instanceof DbError && err.code === 'not_partner')
      return { ok: false, error: NOT_PARTNER }
    console.error('BLine: could not load deliveries', err)
    return { ok: false, error: "Could not load BLine's deliveries. Try again." }
  }
}

const tooBig = (csv: unknown) => typeof csv !== 'string' || csv.length > MAX_FILE_CHARS

/**
 * Read findelivers' Orders CSV and match its rows to BLine orders. Nothing is saved: the
 * matches are for a person to check, then saveFindeliversFile.
 */
export const readFindeliversFile = async (
  csv: string
): Promise<FindeliversReadResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (tooBig(csv)) {
    return {
      ok: false,
      error: 'That file is too big for an Orders CSV. Download a shorter date range.',
    }
  }

  const file = parseFindeliversCsv(csv)
  if (!file.ok) return file

  try {
    const db = await createClient()
    const dates = file.rows.flatMap((row) => (row.createdOn ? [row.createdOn] : [])).sort()
    const today = pacificDate(new Date())
    const [booked, linked, waiting] = await Promise.all([
      listBlineOrdersBooked(db, {
        from: shiftDate(dates[0] ?? today, -MATCH_WINDOW.latest),
        to: shiftDate(dates.at(-1) ?? today, -MATCH_WINDOW.earliest),
      }),
      listBlineOrdersByRef(
        db,
        file.rows.map((row) => row.ref)
      ),
      listUndeliveredBlineOrders(db),
    ])
    const byId = new Map([...booked, ...linked, ...waiting].map((order) => [order.id, order]))
    const orders = [...byId.values()].sort((a, b) => b.id - a.id).map(toFileOrder)
    return {
      ok: true,
      rows: file.rows,
      matches: matchRows(file.rows, orders),
      orders,
      pickups: file.pickups,
      unreadable: file.unreadable,
    }
  } catch (err) {
    if (err instanceof DbError && err.code === 'not_partner')
      return { ok: false, error: NOT_PARTNER }
    console.error('BLine: could not match the findelivers file', err)
    return { ok: false, error: "Could not match the file to BLine's orders. Try again." }
  }
}

const choicesProblem = (choices: unknown, refs: Set<string>): string | null => {
  if (!Array.isArray(choices) || choices.length === 0) return 'Pick at least one order to record.'
  if (choices.length > MAX_FILE_ROWS) return 'Too many rows. Download a shorter date range.'
  const seenRefs = new Set<string>()
  const seenOrders = new Set<number>()
  for (const choice of choices as Partial<FindeliversChoice>[]) {
    if (typeof choice?.ref !== 'string' || !refs.has(choice.ref)) {
      return 'A row is no longer in the file. Choose the file again.'
    }
    if (!isOrderId(choice.orderId)) return 'Pick an order for each row, or none.'
    if (seenRefs.has(choice.ref)) return `Row ${choice.ref} is in the list twice.`
    if (seenOrders.has(choice.orderId)) return `Order #${choice.orderId} is picked for two rows.`
    seenRefs.add(choice.ref)
    seenOrders.add(choice.orderId)
  }
  return null
}

const rowProblem = (err: unknown, ref: string, orderId: number) => {
  if (err instanceof DbError) {
    if (err.code === 'order_void')
      return `${ref}: order #${orderId} is void, so nothing was recorded.`
    if (err.code === 'not_bline') return `${ref}: order #${orderId} isn't a BLine order.`
    if (
      ['bline_ref_conflict', 'order_not_found', 'invalid_input'].includes(err.code) &&
      err.pgCode === 'P0001'
    ) {
      return `${ref}: ${err.message}.`
    }
  }
  console.error(`BLine: could not record ${ref} on order ${orderId}`, err)
  return `${ref}: couldn't be recorded on order #${orderId} (${reason(err)}).`
}

/**
 * Record the chosen rows of findelivers' Orders CSV on their orders. The file is read again
 * here; only the choice of order for each row comes from the browser. Orders found delivered
 * for the first time get their Trello card checked off.
 */
export const saveFindeliversFile = async (
  csv: string,
  choices: FindeliversChoice[]
): Promise<FindeliversSaveResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (tooBig(csv)) {
    return {
      ok: false,
      error: 'That file is too big for an Orders CSV. Download a shorter date range.',
    }
  }

  const file = parseFindeliversCsv(csv)
  if (!file.ok) return file
  const rows = new Map(file.rows.map((row) => [row.ref, row]))
  const problem = choicesProblem(choices, new Set(rows.keys()))
  if (problem) return { ok: false, error: problem }

  try {
    const db = await createClient()
    const problems: string[] = []
    const warnings: string[] = []
    let recorded = 0
    let delivered = 0
    let checkedOff = 0
    const before = new Map(
      (
        await listBlineOrdersById(
          db,
          choices.map((choice) => choice.orderId)
        )
      ).map((order) => [order.id, order])
    )

    for (const { ref, orderId } of choices) {
      const row = rows.get(ref)!
      let after
      try {
        after = await recordBlineTracking(db, {
          orderId,
          ref,
          status: row.status,
          deliveredAt: row.deliveredAt,
          problem: row.problem,
        })
      } catch (err) {
        if (err instanceof DbError && err.code === 'not_partner')
          return { ok: false, error: NOT_PARTNER }
        problems.push(rowProblem(err, ref, orderId))
        continue
      }
      recorded += 1
      if (before.get(orderId)?.delivered_at || !after.delivered_at) continue

      delivered += 1
      if (!after.trello_card_id) continue
      try {
        await setTrelloCardComplete(after.trello_card_id)
        checkedOff += 1
      } catch (err) {
        console.error(`BLine: could not check off order ${orderId}'s Trello card`, err)
        warnings.push(
          `Check off #${orderId} ${after.customer_name}'s Trello card by hand (${reason(err)}).`
        )
      }
    }
    return { ok: true, recorded, delivered, checkedOff, problems, warnings }
  } catch (err) {
    if (err instanceof DbError && err.code === 'not_partner')
      return { ok: false, error: NOT_PARTNER }
    console.error('BLine: could not save the findelivers file', err)
    return {
      ok: false,
      error: `Could not save the file (${reason(err)}). Saving it again is safe.`,
    }
  }
}

const orderNow = async (db: Db, orderId: number) => {
  const order = await getSalesOrder(db, orderId)
  if (!order) throw new Error(`Order ${orderId} does not exist`)
  return (await markInvoicedOutsideSquare(db, [order]))[0]
}

const deliveryFailure = (err: unknown, action: string): DeliveryResult => {
  if (err instanceof DbError) {
    if (err.code === 'not_partner') return { status: 'failed', message: NOT_PARTNER }
    if (err.code === 'order_void') return { status: 'failed', message: 'This order is void.' }
    if (err.code === 'not_bline') return { status: 'failed', message: "This isn't a BLine order." }
    if (err.code === 'order_not_found') return { status: 'failed', message: 'No such order.' }
  }
  console.error(`BLine: could not ${action}`, err)
  return { status: 'failed', message: `Could not ${action} (${reason(err)}). Try again.` }
}

/** Mark a BLine order delivered as of now, and check off its Trello card. */
export const markOrderDelivered = async (
  orderId: number
): Promise<DeliveryResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (!isOrderId(orderId)) return { status: 'failed', message: 'No such order.' }

  try {
    const db = await createClient()
    const before = await getSalesOrder(db, orderId)
    const marked = await markBlineDelivered(db, orderId)
    const warnings: string[] = []
    if (!before?.delivered_at && marked.trello_card_id) {
      try {
        await setTrelloCardComplete(marked.trello_card_id)
      } catch (err) {
        console.error(`BLine: could not check off order ${orderId}'s Trello card`, err)
        warnings.push(`Check off this order's Trello card by hand (${reason(err)}).`)
      }
    }
    return { status: 'done', order: await orderNow(db, orderId), warnings }
  } catch (err) {
    return deliveryFailure(err, 'mark the order delivered')
  }
}

/**
 * Forget a BLine order's delivery and findelivers match (a wrong match, or a delivery
 * marked by mistake), and uncheck its Trello card.
 */
export const clearOrderDelivery = async (
  orderId: number
): Promise<DeliveryResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  if (!isOrderId(orderId)) return { status: 'failed', message: 'No such order.' }

  try {
    const db = await createClient()
    const before = await getSalesOrder(db, orderId)
    const cleared = await clearBlineTracking(db, orderId)
    const warnings: string[] = []
    if (before?.delivered_at && cleared.trello_card_id && !cleared.voided_at) {
      try {
        await setTrelloCardComplete(cleared.trello_card_id, false)
      } catch (err) {
        console.error(`BLine: could not uncheck order ${orderId}'s Trello card`, err)
        warnings.push(`Uncheck this order's Trello card by hand (${reason(err)}).`)
      }
    }
    return { status: 'done', order: await orderNow(db, orderId), warnings }
  } catch (err) {
    return deliveryFailure(err, "clear the order's delivery")
  }
}
