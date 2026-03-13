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

export type NewOrder = Omit<Order, 'id' | 'created_at'>

export type Inventory = {
  id: number
  created_at: string
  name: string 
  count: number 
  isCustom: boolean
  isStill: boolean
}
