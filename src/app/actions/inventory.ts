'use server'

import { createClient } from '@/lib/supabase/server'
import type { Inventory } from '@/types/orders'

export const getInventory = async (): Promise<Inventory[]> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('name')

  if (error) throw new Error(error.message)
  return data ?? []
}
