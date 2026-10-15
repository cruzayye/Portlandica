'use server'

import { appendOrder, getLocationsFromSheet } from '@/lib/google/sheets'
import type { CreateOrderResult, NewOrder, OrderBatches } from '@/types/orders'
import { decrementInventory } from '@/app/actions/inventory'
import { createTrelloCard } from '@/lib/trello'
import { orderProblem } from '@/lib/orders'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

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

// Each step reports back in the return value: production builds hide the
// message of anything thrown from a server action.
export const createOrder = async (
  order: NewOrder,
  batches: OrderBatches,
  force = false,
): Promise<CreateOrderResult> => {
  const problem = orderProblem(order, batches)
  if (problem) return { status: 'failed', message: problem }

  try {
    const result = await appendOrder(order, force)
    if (result.duplicate) return { status: 'duplicate', message: result.message }
  } catch (err) {
    console.error('createOrder: Google Sheet write failed', err)
    return {
      status: 'failed',
      message: `The order may not have been saved: writing to the Google Sheet failed (${reason(err)}). Check the Sales sheet before submitting again.`,
    }
  }

  // The order is in the books from here on. A later step failing becomes a
  // warning, so nobody resubmits and books the order twice.
  const warnings: string[] = []
  try {
    await decrementInventory(order, batches.still?.id, batches.spark?.id)
  } catch (err) {
    console.error('createOrder: inventory update failed', err)
    warnings.push(
      `Order saved, but the inventory count was not updated (${reason(err)}). Adjust the batch on the Inventory tab.`
    )
  }
  try {
    await createTrelloCard(order, batches)
  } catch (err) {
    console.error('createOrder: Trello card failed', err)
    warnings.push(`Order saved, but the Trello card failed (${reason(err)}). Add the card by hand.`)
  }
  return { status: 'saved', warnings }
}
