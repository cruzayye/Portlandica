import { DEFAULT_PRICE_PER_CAN } from '@/globals/constants'
import { DbError, unwrap } from './errors'
import type { Customer, CustomerPatch, CustomerType, Db, NewCustomer } from './types'

/** Invoice terms for a business without its own: Net 30 (Sysco is on 65). */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30

/**
 * Invoice terms for an individual (DTC) without their own: due on receipt. They usually
 * pay on the website when they order.
 */
export const INDIVIDUAL_PAYMENT_TERMS_DAYS = 0

/** The key customers are matched on: trimmed and lowercased, same as customers.name_key. */
export const customerKey = (name: string) => name.trim().toLowerCase()

export const pricePerCan = (customer: Pick<Customer, 'price_per_can'> | null | undefined) =>
  customer?.price_per_can ?? DEFAULT_PRICE_PER_CAN

/**
 * Days until an invoice is due: the customer's own payment_terms_days, otherwise 30 for a
 * business and 0 (due on receipt) for an individual. An order with no customer row (a
 * one-off individual) goes by the order's type.
 */
export const paymentTermsDays = (
  customer: (Pick<Customer, 'payment_terms_days'> & { type?: CustomerType }) | null | undefined,
  orderType?: CustomerType
) =>
  customer?.payment_terms_days ??
  ((customer?.type ?? orderType) === 'individual'
    ? INDIVIDUAL_PAYMENT_TERMS_DAYS
    : DEFAULT_PAYMENT_TERMS_DAYS)

/** One-line address, e.g. "2310 NE Broadway, Portland, OR 97232". */
export const formatAddress = (
  customer: Pick<Customer, 'street_address' | 'city' | 'state' | 'zip'>
) =>
  [customer.street_address, customer.city, [customer.state, customer.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')

const TEXT_FIELDS = [
  'business_type',
  'parent_company',
  'street_address',
  'city',
  'state',
  'zip',
  'email',
  'square_customer_id',
  'notes',
] as const

const cleanText = (value: string | null | undefined) => {
  if (value === null || value === undefined) return value
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Trim text fields (blank becomes null), upper-case the state, lower-case the email, and require a name. */
const cleanCustomer = <T extends CustomerPatch>(input: T): T => {
  const cleaned: CustomerPatch = { ...input }
  for (const field of TEXT_FIELDS) {
    if (field in cleaned) cleaned[field] = cleanText(cleaned[field])
  }
  if (cleaned.state) cleaned.state = cleaned.state.toUpperCase()
  if (cleaned.email) cleaned.email = cleaned.email.toLowerCase()
  if (input.name !== undefined) {
    cleaned.name = input.name.trim()
    if (!cleaned.name)
      throw new DbError({ message: 'Customer name is required', hint: 'invalid_input' })
  }
  return cleaned as T
}

export const listCustomers = async (
  db: Db,
  { includeInactive = false }: { includeInactive?: boolean } = {}
): Promise<Customer[]> => {
  let query = db.from('customers').select('*')
  if (!includeInactive) query = query.eq('active', true)
  return unwrap<Customer[]>(await query.order('name'))
}

export const getCustomer = async (db: Db, id: number) =>
  unwrap<Customer | null>(await db.from('customers').select('*').eq('id', id).maybeSingle())

/** Case- and whitespace-insensitive: "hotel vintage " finds "Hotel Vintage". */
export const findCustomerByName = async (db: Db, name: string) =>
  unwrap<Customer | null>(
    await db.from('customers').select('*').eq('name_key', customerKey(name)).maybeSingle()
  )

/** Throws DbError 'duplicate' if a customer with the same name (any case) exists. */
export const createCustomer = async (db: Db, input: NewCustomer) =>
  unwrap<Customer>(await db.from('customers').insert(cleanCustomer(input)).select().single())

export const updateCustomer = async (db: Db, id: number, patch: CustomerPatch) =>
  unwrap<Customer>(
    await db.from('customers').update(cleanCustomer(patch)).eq('id', id).select().single()
  )
