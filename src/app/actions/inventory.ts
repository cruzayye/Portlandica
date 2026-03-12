'use server'

import { createClient } from '@/lib/supabase/server'
import type { Inventory } from '@/types/orders'
import type { NewOrder } from '@/types/orders'

export const getInventory = async (): Promise<Inventory[]> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('name')

  if (error) throw new Error(error.message)
  return data ?? []
}

export const decrementInventory = async (order: NewOrder): Promise<void> => {
  const supabase = await createClient()

  const decrements = [
    ...(order.totalStill ?? 0) > 0
      ? [{ isStill: true, isCustom: order.IsCustomStill ?? false, name: order.IsCustomStill ? (order.name ?? '') : 'Original', amount: order.totalStill! }]
      : [],
    ...(order.totalSpark ?? 0) > 0
      ? [{ isStill: false, isCustom: order.isCustomSpark ?? false, name: order.isCustomSpark ? (order.name ?? '') : 'Original', amount: order.totalSpark! }]
      : [],
  ]

  for (const { isStill, isCustom, name, amount } of decrements) {
    const { data, error } = await supabase
      .from('inventory')
      .select('id, count')
      .eq('isStill', isStill)
      .eq('isCustom', isCustom)
      .eq('name', name)
      .single()

    if (error || !data) throw new Error(`Inventory item not found: ${name} (${isStill ? 'Still' : 'Spark'})`)

    const { error: updateError } = await supabase
      .from('inventory')
      .update({ count: data.count - amount })
      .eq('id', data.id)

    if (updateError) throw new Error(updateError.message)
  }
}
