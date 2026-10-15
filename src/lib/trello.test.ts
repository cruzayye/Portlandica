// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { NewOrder } from '@/types/orders'
import { createTrelloCard, formatDeliveryDate, nextDeliveryDate } from './trello'

type TrelloRequest = { url: string; method: string; body?: Record<string, unknown> }

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  name: 'Dame',
  isBusiness: true,
  isNewBusiness: false,
  isDTC: false,
  isStill: false,
  isSpark: false,
  totalStill: null,
  totalSpark: null,
  IsCustomStill: false,
  isCustomSpark: false,
  price: null,
  isPaid: false,
  createInvoice: false,
  notes: '',
  address: null,
  businessType: null,
  streetAddress: null,
  city: null,
  state: null,
  zip: null,
  deliveryType: 'Drop',
  isDonation: false,
  ...over,
})

// Records every Trello call; labels on the board start empty.
const trello = { requests: [] as TrelloRequest[] }

const fakeFetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  trello.requests.push({ url, method, body })
  if (url.includes('/labels') && method === 'GET') return Response.json([])
  if (url.includes('/labels')) return Response.json({ id: `label:${body.name}` })
  return Response.json({ id: 'card-1' })
}

const postedCard = () =>
  trello.requests.find((r) => r.url === 'https://api.trello.com/1/cards' && r.method === 'POST')!
    .body!

describe('createTrelloCard', () => {
  beforeEach(() => {
    trello.requests.length = 0
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

  it('lists each product on the card', async () => {
    await createTrelloCard(
      order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48, IsCustomStill: true })
    )

    const card = postedCard()
    expect(card.name).toBe('Dame - Drop 120 Still (Custom) & 48 Sparkling')
    expect(card.desc).toContain('Still Cans: 120 (Custom)')
    expect(card.desc).toContain('Sparkling Cans: 48')
  })

  it('leaves off a switched-off product even if its quantity is still filled in', async () => {
    await createTrelloCard(
      order({ isStill: false, totalStill: 120, isSpark: true, totalSpark: 48 })
    )

    const card = postedCard()
    expect(card.name).toBe('Dame - Drop 48 Sparkling')
    expect(card.desc).not.toContain('Still')
  })

  it("puts an existing customer's address and the notes on separate lines", async () => {
    await createTrelloCard(
      order({
        isStill: true,
        totalStill: 120,
        address: '123 NE Broadway, Portland, OR 97232',
        notes: 'Leave at the back door',
      })
    )

    const lines = String(postedCard().desc).split('\n')
    expect(lines).toContain('Address: 123 NE Broadway, Portland, OR 97232')
    expect(lines).toContain('Notes: Leave at the back door')
  })

  it('uses the typed address for a new business', async () => {
    await createTrelloCard(
      order({
        isNewBusiness: true,
        isStill: true,
        totalStill: 120,
        streetAddress: '1 SW Main St',
        city: 'Portland',
        state: 'OR',
        zip: '97204',
      })
    )

    expect(String(postedCard().desc).split('\n')).toContain(
      'Address: 1 SW Main St, Portland, OR, 97204'
    )
  })

  it('never repeats the notes as the address', async () => {
    await createTrelloCard(order({ isStill: true, totalStill: 120, notes: 'Call ahead' }))

    const desc = String(postedCard().desc)
    expect(desc).not.toContain('Address:')
    expect(desc).toContain('Notes: Call ahead')
  })

  describe('fill-date labels', () => {
    const batches = {
      still: { id: 1, fillDate: '2026-06-20' },
      spark: { id: 2, fillDate: '2026-08-03' },
    }

    it('labels a Sparkling-only order with the Sparkling batch', async () => {
      await createTrelloCard(order({ isSpark: true, totalSpark: 48 }), batches)
      expect(postedCard().idLabels).toEqual(['label:2026-08-03'])
    })

    it('labels a Still-only order with the Still batch', async () => {
      await createTrelloCard(order({ isStill: true, totalStill: 120 }), batches)
      expect(postedCard().idLabels).toEqual(['label:2026-06-20'])
    })

    it('labels a mixed order with both batches', async () => {
      await createTrelloCard(
        order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48 }),
        batches
      )
      expect(postedCard().idLabels).toEqual(['label:2026-06-20', 'label:2026-08-03'])
    })

    it('adds a shared fill date once', async () => {
      await createTrelloCard(
        order({ isStill: true, totalStill: 120, isSpark: true, totalSpark: 48 }),
        { still: { id: 1, fillDate: '2026-08-03' }, spark: { id: 2, fillDate: '2026-08-03' } }
      )
      expect(postedCard().idLabels).toEqual(['label:2026-08-03'])
    })

    it('skips a batch with no fill date', async () => {
      await createTrelloCard(order({ isStill: true, totalStill: 120 }), {
        still: { id: 1, fillDate: null },
      })
      expect(postedCard().idLabels).toEqual([])
    })
  })
})

const originalTz = process.env.TZ

const restoreTz = () => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
}

// Vercel runs in UTC; a laptop in Portland runs in Pacific time. Both must agree.
describe.each(['UTC', 'America/Los_Angeles'])('nextDeliveryDate with TZ=%s', (tz) => {
  beforeAll(() => {
    process.env.TZ = tz
  })
  afterAll(restoreTz)

  it('runs in the intended server time zone', () => {
    expect(new Date('2026-10-13T03:30:00Z').getHours()).toBe(tz === 'UTC' ? 3 : 20)
  })

  it.each([
    ['Monday morning', '2026-10-12T17:00:00Z', '2026-10-14T16:00:00.000Z'],
    [
      'Monday 8:30 PM Pacific (already Tuesday in UTC)',
      '2026-10-13T03:30:00Z',
      '2026-10-14T16:00:00.000Z',
    ],
    ['Tuesday', '2026-10-13T18:00:00Z', '2026-10-17T16:00:00.000Z'],
    ['Wednesday', '2026-10-14T18:00:00Z', '2026-10-17T16:00:00.000Z'],
    ['Thursday', '2026-10-15T18:00:00Z', '2026-10-17T16:00:00.000Z'],
    [
      'Thursday 11 PM Pacific (already Friday in UTC)',
      '2026-10-16T06:00:00Z',
      '2026-10-17T16:00:00.000Z',
    ],
    ['Friday', '2026-10-16T18:00:00Z', '2026-10-21T16:00:00.000Z'],
    ['Saturday', '2026-10-17T18:00:00Z', '2026-10-21T16:00:00.000Z'],
    ['Sunday', '2026-10-18T18:00:00Z', '2026-10-21T16:00:00.000Z'],
  ])('%s → Wednesday or Saturday at 9 AM PDT', (_, now, due) => {
    expect(nextDeliveryDate(new Date(now)).toISOString()).toBe(due)
  })

  it('uses 9 AM PST in winter', () => {
    expect(nextDeliveryDate(new Date('2026-12-07T18:00:00Z')).toISOString()).toBe(
      '2026-12-09T17:00:00.000Z'
    )
  })

  it('crosses the end of daylight saving time', () => {
    // Friday Oct 30 → Sunday Nov 1 (clocks fall back) → Wednesday Nov 4, 9 AM PST
    expect(nextDeliveryDate(new Date('2026-10-30T18:00:00Z')).toISOString()).toBe(
      '2026-11-04T17:00:00.000Z'
    )
  })

  it('crosses the start of daylight saving time', () => {
    // Friday Mar 6 → Sunday Mar 8 (clocks spring forward) → Wednesday Mar 11, 9 AM PDT
    expect(nextDeliveryDate(new Date('2026-03-06T19:00:00Z')).toISOString()).toBe(
      '2026-03-11T16:00:00.000Z'
    )
  })

  it('rolls over the year', () => {
    // Wednesday Dec 30 → Friday Jan 1 → Saturday Jan 2
    expect(nextDeliveryDate(new Date('2026-12-30T18:00:00Z')).toISOString()).toBe(
      '2027-01-02T17:00:00.000Z'
    )
  })

  it('formats the card date in Pacific time', () => {
    expect(formatDeliveryDate(new Date('2026-10-14T16:00:00.000Z'))).toBe('10/14/2026')
  })
})
