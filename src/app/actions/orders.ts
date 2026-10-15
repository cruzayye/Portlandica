'use server'

import { appendOrder, getLocationsFromSheet } from '@/lib/google/sheets'
import type { NewOrder, OrderBatches } from '@/types/orders'
import { decrementInventory } from '@/app/actions/inventory'
import { createTrelloCard } from '@/lib/trello'

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

export const createOrder = async (
  order: NewOrder,
  batches: OrderBatches,
  force = false,
): Promise<{ duplicate: true; message: string } | { duplicate: false }> => {
  const result = await appendOrder(order, force)
  if (result.duplicate) return result
  await decrementInventory(order, batches.still?.id, batches.spark?.id)
  await createTrelloCard(order, batches)
  return { duplicate: false }
}
