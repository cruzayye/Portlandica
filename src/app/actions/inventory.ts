'use server'

import { createClient } from '@/lib/supabase/server'
import type { Inventory, NewInventory } from '@/types/orders'
import type { NewOrder } from '@/types/orders'
import { sparkCans, stillCans } from '@/lib/orders'

export const getInventory = async (): Promise<Inventory[]> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('name')
    .order('fillDate', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

export const createInventoryItem = async (item: NewInventory): Promise<Inventory> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .insert(item)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export const deleteInventoryItem = async (id: number): Promise<void> => {
  const supabase = await createClient()
  console.log(`Deleting inventory item with ID: ${id}`)
  const { error } = await supabase
    .from('inventory')
    .delete()
    .eq('id', id)

  if (error) throw new Error(error.message)
  
}

export const updateInventoryCount = async (id: number, count: number): Promise<void> => {
  const supabase = await createClient()
  const { error } = await supabase
    .from('inventory')
    .update({ count })
    .eq('id', id)

  if (error) throw new Error(error.message)
}

export const decrementInventory = async (order: NewOrder, stillInventoryId?: number, sparkInventoryId?: number): Promise<void> => {
  const supabase = await createClient()

  const decrements = [
    ...stillCans(order) > 0
      ? [{ id: stillInventoryId, product: 'Still', amount: stillCans(order) }]
      : [],
    ...sparkCans(order) > 0
      ? [{ id: sparkInventoryId, product: 'Sparkling', amount: sparkCans(order) }]
      : [],
  ]

  // Every product needs the batch it was picked from; check them all before changing any count.
  const unpicked = decrements.find(({ id }) => !id)
  if (unpicked) throw new Error(`No ${unpicked.product} batch was selected`)

  for (const { id: inventoryId, amount } of decrements) {
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
