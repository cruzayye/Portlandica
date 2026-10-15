import type { DeliveryType, LineProduct } from '@/lib/db/types'
import { deliveryDue, formatDeliveryDate, nextDeliveryDate } from '@/lib/delivery'

export { formatDeliveryDate, nextDeliveryDate } from '@/lib/delivery'

/** An order as its delivery card shows it. */
export type TrelloOrder = {
  orderId: number
  customerName: string
  deliveryType: DeliveryType
  /** YYYY-MM-DD; the card is due at 9 AM Pacific that day. Null: the next delivery day. */
  deliveryDate: string | null
  lines: { product: LineProduct; cans: number; isCustom: boolean; fillDate: string | null }[]
  address: string | null
  poNumber: string | null
  notes: string | null
}

type TrelloConfig = { apiKey: string; token: string; listId: string; boardId: string }

const DELIVERY_LABELS: Record<DeliveryType, string> = { drop: 'Drop', ship: 'Ship', pickup: 'Pickup' }
const PRODUCT_LABELS: Record<LineProduct, string> = {
  still: 'Still',
  sparkling: 'Sparkling',
  dog_water: 'Dog Water',
}

const trelloConfig = (): TrelloConfig => {
  const apiKey = process.env.TRELLO_API_KEY
  const token = process.env.TRELLO_TOKEN
  const listId = process.env.TRELLO_LIST_ID
  const boardId = process.env.TRELLO_BOARD_ID
  if (!apiKey || !token || !listId || !boardId) {
    const missing = [
      !apiKey && 'TRELLO_API_KEY',
      !token && 'TRELLO_TOKEN',
      !listId && 'TRELLO_LIST_ID',
      !boardId && 'TRELLO_BOARD_ID',
    ].filter(Boolean)
    throw new Error(`Missing Trello env vars: ${missing.join(', ')}`)
  }
  return { apiKey, token, listId, boardId }
}

const auth = (config: TrelloConfig) =>
  `key=${encodeURIComponent(config.apiKey)}&token=${encodeURIComponent(config.token)}`

/** The card's last line. A retry looks for it to find a card an earlier attempt made. */
export const orderMarker = (orderId: number) => `Order #${orderId}`

/** The card's title, description, due date and the fill dates to label it with. */
export const cardFor = (order: TrelloOrder, now = new Date()) => {
  const due = order.deliveryDate ? deliveryDue(order.deliveryDate) : nextDeliveryDate(now)
  const deliveryType = DELIVERY_LABELS[order.deliveryType]
  const custom = (isCustom: boolean) => (isCustom ? ' (Custom)' : '')

  const name = `${order.customerName} - ${deliveryType} ${order.lines
    .map((line) => `${line.cans} ${PRODUCT_LABELS[line.product]}${custom(line.isCustom)}`)
    .join(' & ')}`
  const desc = [
    `Delivery Type: ${deliveryType}`,
    ...order.lines.map(
      (line) => `${PRODUCT_LABELS[line.product]} Cans: ${line.cans}${custom(line.isCustom)}`
    ),
    `Delivery Date: ${formatDeliveryDate(due)}`,
    ...(order.address ? [`Address: ${order.address}`] : []),
    ...(order.poNumber ? [`PO: ${order.poNumber}`] : []),
    ...(order.notes ? [`Notes: ${order.notes}`] : []),
    orderMarker(order.orderId),
  ].join('\n')
  // One label per batch fill date, once each.
  const fillDates = [...new Set(order.lines.map((line) => line.fillDate).filter(Boolean))] as string[]
  return { name, desc, due, fillDates }
}

// Board labels are named after a batch's fill date.
const getOrCreateLabel = async (config: TrelloConfig, name: string): Promise<string> => {
  const res = await fetch(
    `https://api.trello.com/1/boards/${config.boardId}/labels?${auth(config)}`
  )
  if (!res.ok) throw new Error(`Trello API error fetching labels: ${res.status}`)
  const labels: { id: string; name: string }[] = await res.json()

  const existing = labels.find((l) => l.name === name)
  if (existing) return existing.id

  const createRes = await fetch(`https://api.trello.com/1/boards/${config.boardId}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: null, key: config.apiKey, token: config.token }),
  })
  if (!createRes.ok) throw new Error(`Trello API error creating label: ${createRes.status}`)
  const created: { id: string } = await createRes.json()
  return created.id
}

/** An open card on the board made for this order, if there is one. */
const findOrderCard = async (config: TrelloConfig, orderId: number) => {
  const res = await fetch(
    `https://api.trello.com/1/boards/${config.boardId}/cards/open?fields=desc&${auth(config)}`
  )
  if (!res.ok) throw new Error(`Trello API error fetching cards: ${res.status}`)
  const cards: { id: string; desc?: string }[] = await res.json()
  const marker = orderMarker(orderId)
  return cards.find((card) => (card.desc ?? '').split('\n').includes(marker))?.id ?? null
}

/**
 * Create the delivery card and return its id. With findExisting, a card an earlier
 * attempt made for this order is returned instead of making a second one.
 */
export const createTrelloCard = async (
  order: TrelloOrder,
  { findExisting = false }: { findExisting?: boolean } = {}
): Promise<string> => {
  const config = trelloConfig()
  if (findExisting) {
    const existing = await findOrderCard(config, order.orderId)
    if (existing) return existing
  }

  const card = cardFor(order)
  const idLabels: string[] = []
  for (const fillDate of card.fillDates) {
    idLabels.push(await getOrCreateLabel(config, fillDate))
  }

  const res = await fetch('https://api.trello.com/1/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: card.name,
      desc: card.desc,
      due: card.due.toISOString(),
      idList: config.listId,
      idLabels,
      key: config.apiKey,
      token: config.token,
    }),
  })
  if (!res.ok) {
    throw new Error(`Trello API error: ${res.status} ${await res.text()}`)
  }
  const created: { id?: string } = await res.json()
  if (!created.id) throw new Error('Trello created the card but sent back no id')
  return created.id
}

/** Archive a card (Trello's "closed"), e.g. when its order is voided. */
export const archiveTrelloCard = async (cardId: string) => {
  const config = trelloConfig()
  const res = await fetch(`https://api.trello.com/1/cards/${encodeURIComponent(cardId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ closed: true, key: config.apiKey, token: config.token }),
  })
  if (!res.ok) throw new Error(`Trello API error archiving the card: ${res.status}`)
}
