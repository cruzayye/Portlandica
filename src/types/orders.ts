import type { Batch, Customer, SalesOrderWithLines } from '@/lib/db/types'

export type Inventory = {
  id: number
  created_at: string
  name: string
  count: number
  isCustom: boolean
  isStill: boolean
  fillDate: string | null
  totalCost: number | null
  invoiceNumber: string | null
  source: string | null
}

export type NewInventory = Omit<Inventory, 'id' | 'created_at'>

/** Who the order is for. Both kinds of business book as "Business" in the Sales sheet. */
export type CustomerType = 'existing' | 'new' | 'individual'

/** The order form's delivery choices. */
export type FormDeliveryType = 'Drop' | 'Ship' | 'Pickup'

/** The products the order form sells. */
export type OrderProduct = 'still' | 'sparkling'

/**
 * One product on the order, for each product that is switched on. Cans and batch stay
 * null until they are filled in, so orderProblem can say what is missing.
 */
export type OrderLineInput = {
  product: OrderProduct
  cans: number | null
  batchId: number | null
}

/** What the order form submits. */
export type OrderInput = {
  customerType: CustomerType
  /** The customer picked from the list (existing business). */
  customerId: number | null
  name: string
  /** New business only. */
  businessType: string | null
  streetAddress: string | null
  city: string | null
  state: string | null
  zip: string | null
  /** For the Trello card: an existing business's address, or one typed for an individual. */
  deliveryAddress: string | null
  /** Billing email, optional. Saved on the customer. */
  email: string | null
  /** The customer's purchase order number, optional. */
  poNumber: string | null
  lines: OrderLineInput[]
  /** What to charge in dollars: the automatic price or one typed in. 0 for a donation. */
  price: number | null
  isPaid: boolean
  createInvoice: boolean
  isDonation: boolean
  deliveryType: FormDeliveryType | null
  /** YYYY-MM-DD. Drives the Trello due date. */
  deliveryDate: string
  notes: string | null
}

export type SubmitOptions = {
  /** Made once per order by the form and sent again on every retry of that order. */
  idempotencyKey: string
  /** Book it even though the customer already has an order today. */
  force?: boolean
  /** Book it even though a batch has fewer cans than the order needs. */
  allowOversell?: boolean
}

/** A batch with fewer cans than an order needs from it. */
export type Shortfall = { batchId: number; batchName: string; available: number; needed: number }

/** What happened to a submitted order. */
export type CreateOrderResult =
  // Saved. The order shows how each step went; warnings say what needs a person.
  | { status: 'saved'; order: SalesOrderWithLines; warnings: string[]; shortfalls: Shortfall[] }
  // Nothing written: this customer already has an order today.
  | { status: 'duplicate'; message: string }
  // Nothing written: a batch is short. Submit again with allowOversell to book it anyway.
  | { status: 'short'; shortfalls: Shortfall[] }
  // Nothing written: this form's key already saved a different order.
  | { status: 'already_saved'; orderId: number; message: string }
  // Not saved, or not confirmed. Submitting again with the same key is safe.
  | { status: 'failed'; message: string }

/** What a retry of an order's unfinished steps did. */
export type RetryResult =
  | { status: 'done'; order: SalesOrderWithLines; warnings: string[]; shortfalls: Shortfall[] }
  | { status: 'failed'; message: string }

/** What voiding an order did, and what is left for a person to fix by hand. */
export type VoidResult =
  | { status: 'voided'; order: SalesOrderWithLines; handFixes: string[] }
  | { status: 'failed'; message: string }

/** A customer the order form can pick, with what pricing and invoicing need. */
export type CustomerOption = Pick<
  Customer,
  'id' | 'name' | 'business_type' | 'price_per_can' | 'custom_cans' | 'email'
> & {
  /** One-line address, as on the Current Locations Addresses tab. */
  address: string
}

/** A batch the order form can draw from. */
export type BatchOption = Pick<
  Batch,
  | 'id'
  | 'name'
  | 'count'
  | 'isStill'
  | 'isCustom'
  | 'customer_id'
  | 'product'
  | 'fillDate'
  | 'source'
>

export type OrderFormData = {
  customers: CustomerOption[]
  businessTypes: string[]
  batches: BatchOption[]
  /** False when SQUARE_ACCESS_TOKEN isn't set: Create Invoice makes no draft. */
  squareReady: boolean
  /** Problems loading, e.g. the locations tab couldn't be read. */
  warnings: string[]
}

/** Recent orders for the Order History tab, with the batches their lines came from. */
export type OrderHistory = {
  orders: SalesOrderWithLines[]
  batches: Pick<Batch, 'id' | 'name' | 'isStill' | 'fillDate'>[]
  /** Why the orders couldn't be loaded, if they couldn't. */
  error: string | null
}
