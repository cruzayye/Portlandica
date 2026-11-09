import type { SupabaseClient } from '@supabase/supabase-js'
import type { Inventory } from '@/types/orders'

// Row types for the tables in supabase/migrations/2026101700*. Hand-written to match the
// SQL; once Johnny generates types with `supabase gen types`, these can be derived instead.

/** Any Supabase client: the app's server client (the secret key) or a script's. */
export type Db = SupabaseClient

export type CustomerType = 'business' | 'individual'

export type Customer = {
  id: number
  name: string
  name_key: string
  type: CustomerType
  business_type: string | null
  parent_company: string | null
  price_per_can: number | null
  custom_cans: boolean
  payment_terms_days: number | null
  street_address: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  email: string | null
  square_customer_id: string | null
  /** Invoiced outside Square (Market of Choice): the order flow never makes a Square draft. */
  invoiced_outside_square: boolean
  active: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

/** Columns a caller may set; everything else has a default or is generated. */
export type CustomerInput = Omit<Customer, 'id' | 'name_key' | 'created_at' | 'updated_at'>
export type NewCustomer = Pick<CustomerInput, 'name'> & Partial<CustomerInput>
export type CustomerPatch = Partial<CustomerInput>

/** An inventory row with the columns the data-foundation migrations add. */
export type Batch = Inventory & {
  initialCount: number | null
  customer_id: number | null
  archived_at: string | null
}

/** What a customer buys on an order line: still or sparkling, as the batch's isStill says. */
export type LineProduct = 'still' | 'sparkling'

/** bline: delivered by BLine from the pallets it keeps for us (they bill us per delivery). */
export type DeliveryType = 'drop' | 'bline' | 'ship' | 'pickup'

export type OrderStep = 'sheet' | 'inventory' | 'trello' | 'square'

export type StepStatus = 'pending' | 'done' | 'failed' | 'skipped'

export type SalesOrder = {
  id: number
  idempotency_key: string
  order_date: string
  customer_id: number | null
  customer_name: string
  type: CustomerType
  delivery_type: DeliveryType
  delivery_date: string | null
  po_number: string | null
  notes: string | null
  total_cans: number
  total_price: number
  is_paid: boolean
  create_invoice: boolean
  is_donation: boolean
  sheet_status: StepStatus
  sheet_error: string | null
  inventory_status: StepStatus
  inventory_error: string | null
  trello_status: StepStatus
  trello_error: string | null
  trello_card_id: string | null
  square_status: StepStatus
  square_error: string | null
  square_invoice_id: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  /** Where the order goes, as shown on the Trello card. */
  delivery_address: string | null
  /** Billing email given with the order, for the Square invoice. */
  customer_email: string | null
  /** Where the sheet step wrote, e.g. 'Sales!A3126:V3127'. */
  sheet_ref: string | null
  /** This order added the customer, so the sheet step also lists them on the locations tab. */
  new_customer: boolean
  /** What BLine charges to deliver it, in dollars, as worked out when it was placed. BLine orders only. */
  delivery_fee: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type SalesOrderLine = {
  id: number
  order_id: number
  product: LineProduct
  cans: number
  batch_id: number
  is_custom: boolean
  unit_price: number
  line_total: number
  created_at: string
}

export type SalesOrderWithLines = SalesOrder & {
  lines: SalesOrderLine[]
  /** Set where Order History needs it: the order's customer is invoiced outside Square. */
  invoicedOutsideSquare?: boolean
}

export type MovementReason = 'opening' | 'fill' | 'order' | 'void' | 'adjustment' | 'archive'

export type InventoryMovement = {
  id: number
  batch_id: number
  delta: number
  reason: MovementReason
  order_id: number | null
  order_line_id: number | null
  note: string | null
  created_by: string | null
  /** Came through the app (a Data API request), not the SQL Editor, dashboard or a migration. */
  made_in_app: boolean
  created_at: string
}

export type LedgerCheckRow = {
  batch_id: number
  name: string | null
  count: number
  ledger_total: number
  difference: number
}

/** sent (+) and returned (-) cans, or count: BLine counted a different number (+ or -). */
export type BlineMoveReason = 'sent' | 'returned' | 'count'

/** A change in the cans BLine holds of one batch. BLine orders take cans off without one. */
export type BlineStockMove = {
  id: number
  batch_id: number
  cans: number
  reason: BlineMoveReason
  moved_on: string
  note: string | null
  created_by: string | null
  created_at: string
}

/** A row of the bline_stock view: what BLine should have of one batch. */
export type BlineStockRow = {
  batch_id: number
  name: string | null
  is_still: boolean | null
  /** Sent, less returned, plus count corrections. */
  moved: number
  /** Cans on live (not void) BLine orders. */
  booked: number
  /** Of those, cans for deliveries after today: still on BLine's shelf. */
  pending: number
  /** moved - booked: what BLine has left once every booked delivery is made. */
  remaining: number
  /** remaining + pending: what BLine should have on its shelf today. */
  on_hand: number
}
