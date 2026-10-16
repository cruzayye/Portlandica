// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { archiveTrelloCard, cardFor, createTrelloCard, type TrelloOrder } from './trello'

type TrelloRequest = { url: string; method: string; body?: Record<string, unknown> }

const order = (over: Partial<TrelloOrder> = {}): TrelloOrder => ({
  orderId: 42,
  customerName: 'Dame',
  deliveryType: 'drop',
  deliveryDate: '2026-10-21',
  lines: [{ product: 'still', cans: 120, isCustom: false, fillDate: '2026-09-26' }],
  address: null,
  poNumber: null,
  notes: null,
  ...over,
})

// Records every Trello call. Labels on the board start empty; the board's open cards are
// whatever a test puts in `cards`.
const trello = {
  requests: [] as TrelloRequest[],
  cards: [] as { id: string; desc: string }[],
  failCreate: false,
}

const fakeFetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  trello.requests.push({ url, method, body })
  if (url.includes('/labels') && method === 'GET') return Response.json([])
  if (url.includes('/labels')) return Response.json({ id: `label:${body.name}` })
  if (url.includes('/cards/open')) return Response.json(trello.cards)
  if (method === 'PUT') return Response.json({ id: 'card-1', closed: true })
  if (trello.failCreate) return new Response('board is full', { status: 400 })
  return Response.json({ id: 'card-1' })
}

const postedCard = () =>
  trello.requests.find((r) => r.url === 'https://api.trello.com/1/cards' && r.method === 'POST')
    ?.body

describe('cardFor', () => {
  it('titles the card with the customer, delivery type and cans', () => {
    const card = cardFor(
      order({
        deliveryType: 'ship',
        lines: [
          { product: 'still', cans: 240, isCustom: true, fillDate: '2026-08-25' },
          { product: 'sparkling', cans: 48, isCustom: false, fillDate: '2026-08-03' },
        ],
      })
    )
    expect(card.name).toBe('Dame - Ship 240 Still (Custom) & 48 Sparkling')
    expect(card.desc.split('\n')).toEqual([
      'Delivery Type: Ship',
      'Still Cans: 240 (Custom)',
      'Sparkling Cans: 48',
      'Delivery Date: 10/21/2026',
      'Order #42',
    ])
  })

  it('is due at 9 AM Pacific on the picked delivery date', () => {
    expect(cardFor(order({ deliveryDate: '2026-10-24' })).due.toISOString()).toBe(
      '2026-10-24T16:00:00.000Z'
    )
  })

  it('falls back to the next delivery day when no date was picked', () => {
    const card = cardFor(order({ deliveryDate: null }), new Date('2026-10-16T18:00:00Z'))
    expect(card.due.toISOString()).toBe('2026-10-21T16:00:00.000Z')
  })

  it('puts the address, PO and notes on their own lines', () => {
    const lines = cardFor(
      order({
        address: '2310 NE Broadway, Portland, OR 97232',
        poNumber: '40012345',
        notes: 'Leave at the back door',
      })
    ).desc.split('\n')
    expect(lines).toContain('Address: 2310 NE Broadway, Portland, OR 97232')
    expect(lines).toContain('PO: 40012345')
    expect(lines).toContain('Notes: Leave at the back door')
    expect(lines.at(-1)).toBe('Order #42')
  })

  it('labels the card with each batch fill date once', () => {
    expect(
      cardFor(
        order({
          lines: [
            { product: 'still', cans: 24, isCustom: false, fillDate: '2026-08-25' },
            { product: 'sparkling', cans: 24, isCustom: false, fillDate: '2026-08-25' },
          ],
        })
      ).fillDates
    ).toEqual(['2026-08-25'])
    expect(
      cardFor(order({ lines: [{ product: 'still', cans: 24, isCustom: false, fillDate: null }] }))
        .fillDates
    ).toEqual([])
  })
})

describe('createTrelloCard', () => {
  beforeEach(() => {
    trello.requests.length = 0
    trello.cards = []
    trello.failCreate = false
    vi.stubGlobal('fetch', fakeFetch)
    vi.stubEnv('TRELLO_API_KEY', 'key')
    vi.stubEnv('TRELLO_TOKEN', 'token')
    vi.stubEnv('TRELLO_LIST_ID', 'list')
    vi.stubEnv('TRELLO_BOARD_ID', 'board')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('posts the card to the list with its labels and returns its id', async () => {
    expect(await createTrelloCard(order())).toBe('card-1')
    expect(postedCard()).toMatchObject({
      name: 'Dame - Drop 120 Still',
      due: '2026-10-21T16:00:00.000Z',
      idList: 'list',
      idLabels: ['label:2026-09-26'],
    })
  })

  it('reuses a card an earlier attempt made for the same order', async () => {
    trello.cards = [
      { id: 'card-7', desc: 'Delivery Type: Drop\nOrder #4' },
      { id: 'card-9', desc: 'Delivery Type: Drop\nOrder #42' },
    ]
    expect(await createTrelloCard(order(), { findExisting: true })).toBe('card-9')
    expect(postedCard()).toBeUndefined()
  })

  it('makes a new card when no earlier one is on the board', async () => {
    trello.cards = [{ id: 'card-7', desc: 'Order #421' }]
    expect(await createTrelloCard(order(), { findExisting: true })).toBe('card-1')
    expect(postedCard()).toBeDefined()
  })

  it('says what Trello answered when it refuses', async () => {
    trello.failCreate = true
    await expect(createTrelloCard(order())).rejects.toThrow('Trello API error: 400 board is full')
  })

  it('names the missing settings', async () => {
    vi.stubEnv('TRELLO_LIST_ID', '')
    await expect(createTrelloCard(order())).rejects.toThrow(
      'Missing Trello env vars: TRELLO_LIST_ID'
    )
    expect(trello.requests).toEqual([])
  })

  it('archives a card', async () => {
    await archiveTrelloCard('card-1')
    expect(trello.requests).toEqual([
      {
        url: 'https://api.trello.com/1/cards/card-1',
        method: 'PUT',
        body: { closed: true, key: 'key', token: 'token' },
      },
    ])
  })
})
