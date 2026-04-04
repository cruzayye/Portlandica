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

export const decrementInventory = async (order: NewOrder, stillInventoryId?: number, sparkInventoryId?: number): Promise<void> => {
  const supabase = await createClient()

  const decrements = [
    ...(order.totalStill ?? 0) > 0
      ? [{ id: stillInventoryId, isStill: true, isCustom: order.IsCustomStill ?? false, name: order.IsCustomStill ? (order.name ?? '') : 'Original', amount: order.totalStill! }]
      : [],
    ...(order.totalSpark ?? 0) > 0
      ? [{ id: sparkInventoryId, isStill: false, isCustom: order.isCustomSpark ?? false, name: order.isCustomSpark ? (order.name ?? '') : 'Original', amount: order.totalSpark! }]
      : [],
  ]

  for (const { id, isStill, isCustom, name, amount } of decrements) {
    let inventoryId = id
    if (!inventoryId) {
      const { data, error } = await supabase
        .from('inventory')
        .select('id, count')
        .eq('isStill', isStill)
        .eq('isCustom', isCustom)
        .eq('name', name)
        .single()

      if (error || !data) throw new Error(`Inventory item not found: ${name} (${isStill ? 'Still' : 'Spark'})`)
      inventoryId = data.id
    }

    const { data: item, error: fetchError } = await supabase
      .from('inventory')
      .select('count')
      .eq('id', inventoryId)
      .single()

    if (fetchError || !item) throw new Error(`Inventory item not found: id ${inventoryId}`)

    const { error: updateError } = await supabase
      .from('inventory')
      .update({ count: item.count - amount })
      .eq('id', inventoryId)

    if (updateError) throw new Error(updateError.message)
  }
}
