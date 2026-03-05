'use server'

import { createClient } from '@/lib/supabase/server'
import type { NewOrder } from '@/types/orders'

export async function createOrder(order: NewOrder) {
  const supabase = await createClient()

  const { data, error } = await supabase.from('orders').insert(order).select().single()

  if (error) throw new Error(error.message)

  return data
}
