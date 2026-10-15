import type { NewOrder } from '@/types/orders'

// Deliveries run on Portland time, not the server's (Vercel runs in UTC).
const DELIVERY_TIME_ZONE = 'America/Los_Angeles'
const DELIVERY_DAYS = [3, 6] // Wednesday, Saturday
const DELIVERY_HOUR = 9

const pacificDateParts = (now: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DELIVERY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { year: part('year'), month: part('month'), day: part('day') }
}

// 9:00 AM Pacific on the given calendar date, whether that falls in PST or PDT.
const atDeliveryHour = (date: Date) => {
  const assumingPst = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    DELIVERY_HOUR + 8
  )
  const pacificHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: DELIVERY_TIME_ZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(assumingPst)
  )
  return new Date(assumingPst - (pacificHour - DELIVERY_HOUR) * 60 * 60 * 1000)
}

/**
 * First Wednesday or Saturday at least two days after today's date in
 * Portland, due at 9:00 AM Pacific.
 */
export const nextDeliveryDate = (now: Date): Date => {
  const { year, month, day } = pacificDateParts(now)
  // A UTC-midnight date used only as a calendar, so the server's zone can't shift the day.
  const date = new Date(Date.UTC(year, month - 1, day + 2))
  while (!DELIVERY_DAYS.includes(date.getUTCDay())) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return atDeliveryHour(date)
}

export const formatDeliveryDate = (date: Date) =>
  date.toLocaleDateString('en-US', { timeZone: DELIVERY_TIME_ZONE })
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

  const deliveryDate = nextDeliveryDate(new Date())
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

  description.push(`Delivery Date: ${formatDeliveryDate(deliveryDate)}`)

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
      due: deliveryDate.toISOString(),
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
