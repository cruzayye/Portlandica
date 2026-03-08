'use server'

import { createClient } from '@supabase/supabase-js'
import { appendOrder, getLocationsFromSheet } from '@/lib/google/sheets'
import type { NewOrder } from '@/types/orders'

export type { SheetLocation } from '@/lib/google/sheets'

export async function getLocationTypes() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data, error } = await supabase.from('location_types').select('name')
  if (error) throw new Error(error.message)
  return data
}

export async function getLocations() {
  return getLocationsFromSheet()
}

export async function createOrder(order: NewOrder) {
  await appendOrder(order)
}
