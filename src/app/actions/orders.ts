'use server'

import { appendOrder, getLocationsFromSheet } from '@/lib/google/sheets'
import type { NewOrder } from '@/types/orders'
import { decrementInventory } from '@/app/actions/inventory'

export async function getLocations() {
  const locations = await getLocationsFromSheet()
  const seen = new Set<string>()
  return locations.filter((l) => {
    if (seen.has(l.name)) return false
    seen.add(l.name)
    return true
  })
}

export async function getLocationTypes() {
  const locations = await getLocationsFromSheet()
  const types = [...new Set(locations.map((l) => l.businessType).filter(Boolean))]
  return types.map((name) => ({ name }))
}

export async function createOrder(order: NewOrder, stillInventoryId?: number, sparkInventoryId?: number) {
  await appendOrder(order)
  await decrementInventory(order, stillInventoryId, sparkInventoryId)
}
