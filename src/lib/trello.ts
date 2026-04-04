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
// right now we only can create one label per fill date, but if we wanted to get fancy we could encode the fill date in the label name and then parse it out here to assign multiple labels for different fill dates
// or we could send this data to our google sales sheet
const getOrCreateLabel = async (boardId: string, name: string, apiKey: string, token: string): Promise<string> => {
  const res = await fetch(`https://api.trello.com/1/boards/${boardId}/labels?key=${apiKey}&token=${token}`)
  if (!res.ok) throw new Error(`Trello API error fetching labels: ${res.status}`)
  const labels: { id: string; name: string }[] = await res.json()

  const existing = labels.find((l) => l.name === name)
  if (existing) return existing.id

  const createRes = await fetch(`https://api.trello.com/1/boards/${boardId}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: null, key: apiKey, token }),
  })
  if (!createRes.ok) throw new Error(`Trello API error creating label: ${createRes.status}`)
  const created: { id: string } = await createRes.json()
  return created.id
}

export async function createTrelloCard(order: NewOrder, fillDate?: string | null) {
  const apiKey = process.env.TRELLO_API_KEY
  const token = process.env.TRELLO_TOKEN
  const listId = process.env.TRELLO_LIST_ID
  const boardId = process.env.TRELLO_BOARD_ID

  if (!apiKey || !token || !listId || !boardId) {
    throw new Error(`Missing Trello env vars: ${[!apiKey && 'TRELLO_API_KEY', !token && 'TRELLO_TOKEN', !listId && 'TRELLO_LIST_ID', !boardId && 'TRELLO_BOARD_ID'].filter(Boolean).join(', ')}`)
  }

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

  const idLabels = fillDate
    ? [await getOrCreateLabel(boardId, fillDate, apiKey, token)]
    : []

  const res = await fetch('https://api.trello.com/1/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: cardTitle,
      desc: description.join('\n'),
      due: nextDeliveryDate.toISOString(),
      idList: listId,
      idLabels,
      key: apiKey,
      token,
    }),
  })

  if (!res.ok) {
    throw new Error(`Trello API error: ${res.status} ${await res.text()}`)
  }
}
