import type { Batch, Customer, Db, OrderStep, SalesOrder, SalesOrderWithLines } from '@/lib/db/types'
import type { Shortfall } from '@/types/orders'
import { DbError } from '@/lib/db/errors'
import { formatAddress, getCustomer, paymentTermsDays, updateCustomer } from '@/lib/db/customers'
import { listBatches } from '@/lib/db/inventory'
import { applyOrderInventory, getSalesOrder, pendingSteps, recordOrderStep } from '@/lib/db/orders'
import { untagOrderRows, writeOrderToSheet, type SheetOrder } from '@/lib/google/sheets'
import {
  createDraftInvoice,
  deleteDraftInvoice,
  type DraftDeletion,
  type InvoiceLine,
} from '@/lib/square'
import { createTrelloCard, type TrelloOrder } from '@/lib/trello'
import { batchTitle } from '@/lib/batches'
import { lineAmounts, shortfallMessage } from '@/lib/orders'

// Runs an order's unfinished steps in order: Sales sheet, inventory, Trello, Square. Each
// step's outcome is recorded on the order, so a failed step can be retried later on its
// own (Order History) without repeating the ones that finished. Server only.

export const STEP_NAMES: Record<OrderStep, string> = {
  sheet: 'Sales sheet',
  inventory: 'Inventory',
  trello: 'Trello',
  square: 'Square',
}

export type StepRun = {
  order: SalesOrderWithLines
  /** Things a person should know or do, beyond each step's status. */
  warnings: string[]
  /** Batches that didn't have enough cans, when the inventory step stopped for that. */
  shortfalls: Shortfall[]
}

export type RunOptions = {
  /** Take the cans even if a batch goes below zero (the user confirmed it). */
  allowNegativeInventory?: boolean
  /** Not the first attempt: look for a Trello card an earlier attempt made. */
  retry?: boolean
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Errors are stored on the order and shown in the app, so keep credentials out of them.
export const cleanError = (message: string) =>
  message.replace(/\b(key|token)=[^&\s"']+/gi, '$1=…').slice(0, 500)

/** Square drafts are made only when the app has a Square access token. */
export const squareReady = () => Boolean(process.env.SQUARE_ACCESS_TOKEN)

export const SQUARE_NOT_SET_UP =
  "Square isn't set up here (no SQUARE_ACCESS_TOKEN), so no invoice draft was made. Make the invoice in Square by hand."

/** Customers invoiced outside Square (Market of Choice) never get a Square draft. */
export const invoicedOutsideSquare = (customerName: string) =>
  `${customerName} is invoiced outside Square, so no Square draft was made.`

export const SQUARE_NOT_SET_UP_FOR_VOID =
  "Square isn't set up here (no SQUARE_ACCESS_TOKEN), so the app couldn't delete this order's invoice. In the Square Dashboard (Invoices), delete it if it's still a draft, or cancel or refund it if it was sent."

/**
 * The order's reference in Square, at most 40 characters. The id keeps it readable, and
 * the start of the idempotency key keeps it from ever matching another order, even if the
 * database were rebuilt and ids started again.
 */
export const squareOrderRef = (order: Pick<SalesOrder, 'id' | 'idempotency_key'>) =>
  `${order.id}-${order.idempotency_key.slice(0, 8)}`

const PRODUCT_NAMES = { still: 'Still Cans', sparkling: 'Sparkling Cans' }

const isWholeCents = (dollars: number) => Math.abs(dollars * 100 - Math.round(dollars * 100)) < 1e-6

/**
 * Invoice lines for an order, one per order line at its own price, matching the Sales
 * rows. Billed per can when every price is whole cents and the lines add up to the
 * order's total; otherwise (a typed total that doesn't divide evenly) each line is billed
 * as one lot of its amount (lineAmounts), so the invoice comes to exactly the order's
 * total.
 */
export const invoiceLines = (
  order: Pick<SalesOrderWithLines, 'total_price' | 'lines'>
): InvoiceLine[] => {
  const name = (line: SalesOrderWithLines['lines'][number]) =>
    `${PRODUCT_NAMES[line.product]}${line.is_custom ? ' (Custom)' : ''}`
  const totalCents = Math.round(Number(order.total_price) * 100)
  const lineCents = order.lines.reduce(
    (sum, line) => sum + Math.round(Number(line.unit_price) * 100) * line.cans,
    0
  )
  if (order.lines.every((line) => isWholeCents(Number(line.unit_price))) && lineCents === totalCents) {
    return order.lines.map((line) => ({
      name: name(line),
      cans: line.cans,
      unitPrice: Number(line.unit_price),
    }))
  }
  const amounts = lineAmounts(order)
  return order.lines.map((line, i) => ({
    name: `${name(line)} (${line.cans})`,
    cans: line.cans,
    unitPrice: amounts[i] / line.cans,
    caseSize: line.cans,
  }))
}

const sheetOrderFor = (order: SalesOrderWithLines, customer: Customer | null): SheetOrder => {
  const amounts = lineAmounts(order)
  return {
    key: order.idempotency_key,
    orderDate: order.order_date,
    type: order.type,
    customerName: order.customer_name,
    lines: order.lines.map((line, i) => ({
      product: line.product,
      cans: line.cans,
      batchId: line.batch_id,
      isCustom: line.is_custom,
      amount: amounts[i],
    })),
    isPaid: order.is_paid,
    createInvoice: order.create_invoice,
    isDonation: order.is_donation,
    notes: order.notes,
    newLocation:
      order.new_customer && customer
        ? {
            name: customer.name,
            address: formatAddress(customer),
            latitude: customer.latitude,
            longitude: customer.longitude,
            businessType: customer.business_type ?? '',
          }
        : null,
  }
}

const trelloOrderFor = (order: SalesOrderWithLines, batches: Map<number, Batch>): TrelloOrder => ({
  orderId: order.id,
  customerName: order.customer_name,
  deliveryType: order.delivery_type,
  deliveryDate: order.delivery_date,
  lines: order.lines.map((line) => ({
    product: line.product,
    cans: line.cans,
    isCustom: line.is_custom,
    fillDate: batches.get(line.batch_id)?.fillDate ?? null,
  })),
  address: order.delivery_address,
  poNumber: order.po_number,
  notes: order.notes,
})

/**
 * Run the order's pending and failed steps, in order, recording each outcome. Never
 * throws for a failed step: the step is marked failed with its error and the next one
 * runs. Throws only if the order itself can't be read.
 */
export const runOrderSteps = async (
  db: Db,
  orderId: number,
  { allowNegativeInventory = false, retry = false }: RunOptions = {}
): Promise<StepRun> => {
  const warnings: string[] = []
  const shortfalls: Shortfall[] = []
  const loaded = await getSalesOrder(db, orderId)
  if (!loaded) throw new Error(`Order ${orderId} doesn't exist`)
  let order: SalesOrderWithLines = loaded
  if (order.voided_at) return { order, warnings: ['This order is void.'], shortfalls }

  const steps = pendingSteps(order)
  if (!steps.length) return { order, warnings, shortfalls }

  const customer = order.customer_id ? await getCustomer(db, order.customer_id) : null
  const batches = new Map(
    (await listBatches(db, { includeArchived: true })).map((batch) => [batch.id, batch])
  )

  const keep = (row: SalesOrder) => {
    order = { ...row, lines: order.lines }
  }
  const record = async (
    step: OrderStep,
    status: SalesOrder['sheet_status'],
    extra: { externalId?: string | null; error?: string | null } = {}
  ) => {
    try {
      keep(await recordOrderStep(db, order.id, step, status, extra))
      return true
    } catch (err) {
      console.error(`Order ${order.id}: recording the ${step} step failed`, err)
      warnings.push(
        `Couldn't save how the ${STEP_NAMES[step]} step went (${reason(err)}). Check Order History before retrying.`
      )
      return false
    }
  }
  const fail = (step: OrderStep, err: unknown) => {
    console.error(`Order ${order.id}: ${step} step failed`, err)
    return record(step, 'failed', { error: cleanError(reason(err)) })
  }

  for (const step of steps) {
    if (step === 'sheet') {
      try {
        const { ref } = await writeOrderToSheet(sheetOrderFor(order, customer))
        if (await record('sheet', 'done', { externalId: ref })) {
          // The rows only need their tag until the step is recorded.
          await untagOrderRows(order.idempotency_key).catch((err) =>
            console.error(`Order ${order.id}: removing the sheet row tags failed`, err)
          )
        }
      } catch (err) {
        await fail('sheet', err)
      }
    }

    if (step === 'inventory') {
      try {
        keep(await applyOrderInventory(db, order.id, { allowNegative: allowNegativeInventory }))
      } catch (err) {
        if (err instanceof DbError && err.code === 'insufficient_stock' && err.shortfall) {
          const batch = batches.get(err.shortfall.batchId)
          const shortfall: Shortfall = {
            batchId: err.shortfall.batchId,
            batchName: batch ? batchTitle(batch) : `Batch ${err.shortfall.batchId}`,
            available: err.shortfall.available,
            needed: err.shortfall.needed,
          }
          shortfalls.push(shortfall)
          console.error(`Order ${order.id}: inventory step stopped`, err)
          await record('inventory', 'failed', {
            error: `${shortfallMessage(shortfall)} Retry and confirm to take the cans anyway.`,
          })
        } else {
          await fail('inventory', err)
        }
      }
    }

    if (step === 'trello') {
      try {
        const cardId = await createTrelloCard(trelloOrderFor(order, batches), {
          findExisting: retry,
        })
        await record('trello', 'done', { externalId: cardId })
      } catch (err) {
        await fail('trello', err)
      }
    }

    if (step === 'square') {
      if (customer?.invoiced_outside_square) {
        await record('square', 'skipped')
        warnings.push(invoicedOutsideSquare(customer.name))
        continue
      }
      if (!squareReady()) {
        await record('square', 'skipped')
        warnings.push(SQUARE_NOT_SET_UP)
        continue
      }
      try {
        const draft = await createDraftInvoice({
          orderId: squareOrderRef(order),
          orderDate: new Date(order.created_at),
          customer: {
            name: customer?.name ?? order.customer_name,
            email: order.customer_email ?? customer?.email ?? null,
            squareCustomerId: customer?.square_customer_id ?? null,
            paymentTermsDays: paymentTermsDays(customer, order.type),
          },
          lines: invoiceLines(order),
          poNumber: order.po_number,
        })
        await record('square', 'done', { externalId: draft.squareInvoiceId })
        if (customer && customer.square_customer_id !== draft.squareCustomerId) {
          await updateCustomer(db, customer.id, { square_customer_id: draft.squareCustomerId }).catch(
            (err) => {
              console.error(`Order ${order.id}: saving the Square customer id failed`, err)
              warnings.push(
                `The invoice draft is made, but its Square customer id wasn't saved on ${customer.name} (${reason(err)}).`
              )
            }
          )
        }
      } catch (err) {
        await fail('square', err)
      }
    }
  }

  return { order, warnings, shortfalls }
}

// Square's invoice statuses past DRAFT, as people say them.
const INVOICE_STATUS_WORDS: Record<string, string> = {
  UNPAID: 'sent and unpaid',
  SCHEDULED: 'scheduled to be sent',
  PARTIALLY_PAID: 'partly paid',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'partly refunded',
  REFUNDED: 'refunded',
  CANCELED: 'canceled',
  FAILED: 'canceled by Square',
  PAYMENT_PENDING: 'waiting on a payment',
}

/**
 * After a void: delete the order's Square invoice if it is still a draft, and record that
 * on the order (its Square step becomes skipped; the invoice id stays). An invoice that
 * was already sent, scheduled, paid and so on is left alone. Returns what a person still
 * has to do in Square, if anything. Never throws.
 */
export const deleteVoidedOrderDraft = async (
  db: Db,
  order: Pick<SalesOrder, 'id' | 'square_status' | 'square_invoice_id'>
): Promise<string[]> => {
  const invoiceId = order.square_invoice_id
  if (!invoiceId || order.square_status !== 'done') return []
  if (!squareReady()) return [SQUARE_NOT_SET_UP_FOR_VOID]

  let deletion: DraftDeletion
  try {
    deletion = await deleteDraftInvoice(invoiceId)
  } catch (err) {
    console.error(`Order ${order.id}: deleting the Square draft failed`, err)
    return [
      `Couldn't delete this order's draft invoice in Square (${cleanError(reason(err))}). Delete it in the Square Dashboard (Invoices) by hand, or cancel or refund it if it was sent.`,
    ]
  }

  if (deletion.outcome === 'not_draft') {
    const status = INVOICE_STATUS_WORDS[deletion.status] ?? deletion.status.toLowerCase()
    return [
      `This order's Square invoice is already ${status}, so the app left it alone. Cancel or refund it in Square by hand.`,
    ]
  }
  if (deletion.outcome === 'not_found') {
    return [
      `Square has no invoice ${invoiceId}, so nothing was deleted. If it wasn't deleted in Square already, find it in the Square Dashboard (Invoices) and delete, cancel or refund it by hand.`,
    ]
  }

  try {
    await recordOrderStep(db, order.id, 'square', 'skipped')
  } catch (err) {
    console.error(`Order ${order.id}: recording the deleted Square draft failed`, err)
    return [
      `The draft invoice is deleted in Square, but that couldn't be saved on the order (${reason(err)}).`,
    ]
  }
  return []
}
