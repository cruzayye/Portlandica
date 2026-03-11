import type { NewOrder } from '@/types/orders'

function calculateNextDeliveryDate(): Date {
  const today = new Date()
  const deliveryDate = new Date(today)
  deliveryDate.setDate(today.getDate() + 2)

  const day = deliveryDate.getDay()
  if (day !== 3 && day !== 6) {
    if (day < 3) {
      deliveryDate.setDate(deliveryDate.getDate() + (3 - day))
    } else {
      deliveryDate.setDate(deliveryDate.getDate() + (6 - day))
    }
  }

  deliveryDate.setHours(9, 0, 0, 0)
  return deliveryDate
}

export async function createTrelloCard(order: NewOrder) {
  const apiKey = process.env.TRELLO_API_KEY!
  const token = process.env.TRELLO_TOKEN!
  const listId = process.env.TRELLO_LIST_ID!

  const nextDeliveryDate = calculateNextDeliveryDate()
  const customerName = order.name ?? ''
  const deliveryType = order.deliveryType 

  const titleParts: string[] = []
  if ((order.totalStill ?? 0) > 0) {
    const label = order.IsCustomStill ? ' (Custom)' : ''
    titleParts.push(`${order.totalStill} Still${label}`)
  }
  if ((order.totalSpark ?? 0) > 0) {
    const label = order.isCustomSpark ? ' (Custom)' : ''
    titleParts.push(`${order.totalSpark} Sparkling${label}`)
  }

  const cardTitle = `${customerName} - ${deliveryType} ${titleParts.join(' & ')}`

  const description: string[] = [`Delivery Type: ${deliveryType}`]

  if ((order.totalStill ?? 0) > 0) {
    description.push(
      order.IsCustomStill
        ? `Still Cans: ${order.totalStill} (Custom)`
        : `Still Cans: ${order.totalStill}`
    )
  }
  if ((order.totalSpark ?? 0) > 0) {
    description.push(
      order.isCustomSpark
        ? `Sparkling Cans: ${order.totalSpark} (Custom)`
        : `Sparkling Cans: ${order.totalSpark}`
    )
  }

  description.push(`Delivery Date: ${nextDeliveryDate.toLocaleDateString()}`)

  const address = order.isNewBusiness
    ? [order.streetAddress, order.city, order.state, order.zip].filter(Boolean).join(', ')
    : (order.notes ?? '')

  if (address) description.push(`Address: ${address}`)
  if (order.notes) description.push(`Notes: ${order.notes}`)

  const res = await fetch('https://api.trello.com/1/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: cardTitle,
      desc: description.join('\n'),
      due: nextDeliveryDate.toISOString(),
      idList: listId,
      key: apiKey,
      token,
    }),
  })

  if (!res.ok) {
    throw new Error(`Trello API error: ${res.status} ${await res.text()}`)
  }
}
