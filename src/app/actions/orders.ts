'use server'

import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import type { Batch, Customer, Db } from '@/lib/db/types'
import type {
  CreateOrderResult,
  OrderFormData,
  OrderInput,
  SubmitOptions,
} from '@/types/orders'
import {
  createCustomer,
  findCustomerByName,
  formatAddress,
  getCustomer,
  updateCustomer,
} from '@/lib/db/customers'
import { listBatches } from '@/lib/db/inventory'
import {
  createSalesOrder,
  deliveryTypeFromForm,
  findSameDayOrders,
  getSalesOrderByKey,
  priceLines,
} from '@/lib/db/orders'
import {
  findSameDaySheetOrder,
  getLocationsFromSheet,
  type SheetLocation,
} from '@/lib/google/sheets'
import { batchesForCustomer } from '@/lib/batches'
import {
  businessTypes,
  customerOptions,
  geocodeNewCustomer,
  syncCustomers,
} from '@/lib/customerSync'
import { pacificDate } from '@/lib/delivery'
import { runOrderSteps, squareReady } from '@/lib/orderSteps'
import {
  PRODUCT_NAMES,
  autoTotal,
  dbCustomerType,
  linePrices,
  orderProblem,
  sameOrder,
  shortfalls,
} from '@/lib/orders'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

const SAFE_TO_RETRY =
  'Submitting again is safe: the same order is never booked twice.'

/**
 * Everything the order form needs: customers (names on the Current Locations Addresses
 * tab are added to the customers table first), business types and the batches on hand.
 */
export const getOrderFormData = async (): Promise<OrderFormData | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const warnings: string[] = []
  let locations: SheetLocation[] = []
  try {
    locations = await getLocationsFromSheet()
  } catch (err) {
    console.error('getOrderFormData: reading Current Locations Addresses failed', err)
    warnings.push(
      `Couldn't read the Current Locations Addresses tab (${reason(err)}), so names added there lately may be missing.`
    )
  }

  try {
    const db = await createClient()
    const [{ customers }, batches] = await Promise.all([
      syncCustomers(db, locations),
      listBatches(db),
    ])
    return {
      customers: customerOptions(customers, locations),
      businessTypes: businessTypes(customers, locations),
      batches: batches.map(
        ({ id, name, count, isStill, isCustom, customer_id, fillDate, source }) => ({
          id,
          name,
          count,
          isStill,
          isCustom,
          customer_id,
          fillDate,
          source,
        })
      ),
      squareReady: squareReady(),
      warnings,
    }
  } catch (err) {
    console.error('getOrderFormData: loading customers and batches failed', err)
    return {
      customers: [],
      businessTypes: [],
      batches: [],
      squareReady: squareReady(),
      warnings: [
        ...warnings,
        `Couldn't load customers and batches (${reason(err)}). Reload the page to try again.`,
      ],
    }
  }
}

// A line may only draw from a live batch of its product that is house stock or this
// customer's own custom cans.
const batchProblem = (input: OrderInput, batches: Batch[]) => {
  const customerId = input.customerType === 'existing' ? input.customerId : null
  for (const line of input.lines) {
    const batch = batches.find((b) => b.id === line.batchId)
    const product = PRODUCT_NAMES[line.product]
    if (!batch || batch.archived_at) {
      return `The ${product} batch you picked is no longer in inventory. Reload the page and pick another.`
    }
    if (!batchesForCustomer([batch], line.product, customerId).length) {
      return `The ${product} batch you picked can't be used for this customer. Pick another.`
    }
  }
  return null
}

const duplicateMessage = async (db: Db, input: OrderInput, orderDate: string) => {
  const sameDay = await findSameDayOrders(db, {
    orderDate,
    customerId: input.customerType === 'existing' ? input.customerId : null,
    customerName: input.name,
  })
  if (sameDay.length) {
    return `${input.name.trim()} already has an order today (order #${sameDay[0].id}).`
  }
  try {
    // Orders typed straight into the sheet count too.
    if (await findSameDaySheetOrder(orderDate, input.name)) {
      return `${input.name.trim()} already has an order today in the Sales sheet.`
    }
  } catch (err) {
    console.error('createOrder: the Sales sheet duplicate check failed', err)
  }
  return null
}

/**
 * The customer the order is for: the one picked, or for a new business one added now
 * (or found, if an earlier attempt or someone else already added it). A billing email
 * typed with the order is saved on the customer.
 */
const resolveCustomer = async (
  db: Db,
  input: OrderInput
): Promise<{ customer: Customer | null; isNew: boolean }> => {
  if (input.customerType === 'individual') return { customer: null, isNew: false }

  const email = input.email?.trim().toLowerCase() || null
  const withEmail = async (customer: Customer) =>
    email && email !== customer.email ? updateCustomer(db, customer.id, { email }) : customer

  if (input.customerType === 'existing') {
    const customer = await getCustomer(db, input.customerId!)
    if (!customer) {
      throw new Error('That customer is no longer on file. Reload the page and pick them again.')
    }
    return { customer: await withEmail(customer), isNew: false }
  }

  const found = await findCustomerByName(db, input.name)
  if (found) return { customer: await withEmail(found), isNew: true }
  const customer = await createCustomer(db, {
    name: input.name,
    type: 'business',
    business_type: input.businessType,
    street_address: input.streetAddress,
    city: input.city,
    state: input.state,
    zip: input.zip,
    email,
  })
  return { customer, isNew: true }
}

// The automatic price books each line at its own price per can (linePrices): custom cans
// at the customer's price, house stock at $1.50 unless the customer's price isn't tied to
// custom cans. Any other price (typed in, or a total the form worked out before a price
// changed) replaces the total and is spread over the lines in proportion to those prices.
const priceOrder = (input: OrderInput, customer: Customer | null, batches: Batch[]) => {
  const lines = input.lines.map((line) => ({
    product: line.product,
    cans: line.cans!,
    batch_id: line.batchId!,
  }))
  if (input.isDonation) return { lines: priceLines(lines, { isDonation: true }), totalPrice: 0 }

  const pricePerCan = linePrices(input.lines, batches, customer)
  const cans = lines.map((line) => line.cans)
  const autoCents = Math.round((autoTotal(cans, pricePerCan) ?? 0) * 100)
  const typedCents = Math.round((input.price ?? 0) * 100)
  return autoCents === typedCents
    ? { lines: priceLines(lines, { pricePerCan }), totalPrice: null }
    : {
        lines: priceLines(lines, { pricePerCan, totalPrice: typedCents / 100 }),
        totalPrice: typedCents / 100,
      }
}

const deliveryAddress = (input: OrderInput, customer: Customer | null) =>
  input.customerType === 'new'
    ? formatAddress({
        street_address: input.streetAddress,
        city: input.city,
        state: input.state?.toUpperCase() ?? null,
        zip: input.zip,
      })
    : input.deliveryAddress?.trim() || (customer ? formatAddress(customer) : '')

// Look up a new business's coordinates once the response has gone out.
const geocodeLater = async (db: Db, customerId: number | null) => {
  if (customerId === null) return
  const customer = await getCustomer(db, customerId)
  if (customer && customer.latitude === null) after(() => geocodeNewCustomer(db, customer))
}

/**
 * Book an order. The order is saved first, under the form's idempotency key; then the
 * Sales sheet, inventory, Trello and Square steps run, each recorded on the order. A
 * second submission with the same key finishes that order instead of booking another.
 * Results are returned, never thrown: production builds hide thrown messages.
 */
export const createOrder = async (
  input: OrderInput,
  options: SubmitOptions
): Promise<CreateOrderResult | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const problem = orderProblem(input)
  if (problem) return { status: 'failed', message: problem }
  const key = options.idempotencyKey?.trim()
  if (!key || /\s/.test(key) || key.length > 200) {
    return { status: 'failed', message: 'The form is missing its order key. Reload the page.' }
  }

  try {
    const db = await createClient()

    // The same key again: an earlier attempt saved the order, so finish it.
    const saved = await getSalesOrderByKey(db, key)
    if (saved) {
      if (!sameOrder(saved, input)) {
        return {
          status: 'already_saved',
          orderId: saved.id,
          message: `This form already saved order #${saved.id} with different details. Check Order History before booking it again; submitting now books a new order.`,
        }
      }
      const run = await runOrderSteps(db, saved.id, {
        allowNegativeInventory: options.allowOversell,
        retry: true,
      })
      if (run.order.new_customer) await geocodeLater(db, run.order.customer_id)
      return { status: 'saved', ...run }
    }

    const orderDate = pacificDate(new Date())
    if (!options.force) {
      const duplicate = await duplicateMessage(db, input, orderDate)
      if (duplicate) return { status: 'duplicate', message: duplicate }
    }

    const batches = await listBatches(db, { includeArchived: true })
    const badBatch = batchProblem(input, batches)
    if (badBatch) return { status: 'failed', message: badBatch }
    const short = shortfalls(input.lines, batches)
    if (short.length && !options.allowOversell) return { status: 'short', shortfalls: short }

    const { customer, isNew } = await resolveCustomer(db, input)
    const priced = priceOrder(input, customer, batches)
    const created = await createSalesOrder(db, {
      idempotency_key: key,
      order_date: orderDate,
      customer_id: customer?.id ?? null,
      customer_name: customer?.name ?? input.name,
      type: dbCustomerType(input.customerType),
      delivery_type: deliveryTypeFromForm(input.deliveryType)!,
      delivery_date: input.deliveryDate,
      delivery_address: deliveryAddress(input, customer),
      po_number: input.poNumber,
      notes: input.notes,
      lines: priced.lines,
      total_price: priced.totalPrice,
      is_paid: input.isPaid,
      create_invoice: input.createInvoice && !input.isDonation,
      is_donation: input.isDonation,
      customer_email: input.email?.trim() || null,
      new_customer: isNew,
    })

    const run = await runOrderSteps(db, created.order.id, {
      allowNegativeInventory: options.allowOversell,
      retry: !created.created,
    })
    if (isNew) await geocodeLater(db, customer?.id ?? null)
    return { status: 'saved', ...run }
  } catch (err) {
    console.error('createOrder failed', err)
    return {
      status: 'failed',
      message: `The order wasn't saved, or saving it couldn't be confirmed (${reason(err)}). ${SAFE_TO_RETRY}`,
    }
  }
}
