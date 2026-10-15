'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import type { Inventory, NewInventory } from '@/types/orders'
import type { NewOrder } from '@/types/orders'

export const getInventory = async (): Promise<Inventory[] | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .order('name')
    .order('fillDate', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

export const createInventoryItem = async (item: NewInventory): Promise<Inventory | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('inventory')
    .insert(item)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export const deleteInventoryItem = async (id: number): Promise<void | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const supabase = await createClient()
  console.log(`Deleting inventory item with ID: ${id}`)
  const { error } = await supabase
    .from('inventory')
    .delete()
    .eq('id', id)

  if (error) throw new Error(error.message)
  
}

export const updateInventoryCount = async (id: number, count: number): Promise<void | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure

  const supabase = await createClient()
  const { error } = await supabase
    .from('inventory')
    .update({ count })
    .eq('id', id)

  if (error) throw new Error(error.message)
}

export const decrementInventory = async (order: NewOrder, stillInventoryId?: number, sparkInventoryId?: number): Promise<void> => {
  // Exported from a 'use server' file, so it gets the check too. Only
  // createOrder calls it (after its own check), so it throws on failure like
  // the rest of this function instead of returning the failure.
  const { failure } = await requireUser()
  if (failure) throw new Error(failure.authError)

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
