export type Order = {
  id: number
  created_at: string
  isBusiness: boolean | null
  isNewBusiness: boolean | null
  isDTC: boolean | null
  name: string | null
  isStill: boolean | null
  isSpark: boolean | null
  totalStill: number | null
  totalSpark: number | null
  IsCustomStill: boolean | null
  isCustomSpark: boolean | null
  price: number | null
  isPaid: boolean | null
  createInvoice: boolean | null
  notes: string | null
  businessType: string | null
  streetAddress: string | null
  city: string | null
  state: string | null
  zip: string | null
  deliveryType: string | null
  isDonation: boolean | null
}

/** Who the order is for. Both kinds of business book as "Business" in the Sales sheet. */
export type CustomerType = 'existing' | 'new' | 'individual'

export type NewOrder = Omit<
  Order,
  'id' | 'created_at' | 'isBusiness' | 'isNewBusiness' | 'isDTC'
> & {
  customerType: CustomerType
  /** An existing customer's address from Current Locations Addresses, for the Trello card. */
  address: string | null
}

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

/** The inventory batch each product in an order is drawn from. */
export type OrderBatches = {
  still?: Pick<Inventory, 'id' | 'fillDate'>
  spark?: Pick<Inventory, 'id' | 'fillDate'>
}

/** What happened to a submitted order. */
export type CreateOrderResult =
  // Written to the Sales sheet. Warnings name any later step (inventory, Trello) that failed.
  | { status: 'saved'; warnings: string[] }
  // Not written: this customer already has an order today.
  | { status: 'duplicate'; message: string }
  // Not written, or the sheet write could not be confirmed.
  | { status: 'failed'; message: string }
