'use server'

import { createClient } from '@supabase/supabase-js'
import type { NewOrder } from '@/types/orders'

export async function getLocations() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data, error } = await supabase.from('locations').select('*')
  if (error) throw new Error(error.message)
  return data
}

export async function createOrder(order: NewOrder) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data, error } = await supabase.from('orders').insert(order).select().single()
  if (error) throw new Error(error.message)

  return data
}
