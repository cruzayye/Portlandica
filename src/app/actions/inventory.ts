'use server'

import { createClient } from '@/lib/supabase/server'
import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import type { Inventory, NewInventory } from '@/types/orders'

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
