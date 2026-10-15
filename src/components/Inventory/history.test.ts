import { describe, expect, it } from 'vitest'
import type { InventoryMovement } from '@/lib/db/types'
import { formatDay, formatMoment, formatPortlandDay, portlandToday } from './dates'
import { changedBy, historyEntries, orderLabel, reasonLabel } from './history'

const PAUL = 'paul-id'
const JOHNNY = 'johnny-id'

const movement = (over: Partial<InventoryMovement> & { id: number }): InventoryMovement => ({
  batch_id: 22,
  delta: 0,
  reason: 'adjustment',
  order_id: null,
  order_line_id: null,
  note: null,
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})

describe('historyEntries', () => {
  const movements = [
    movement({
      id: 3,
      delta: -1440,
      reason: 'order',
      order_id: 12,
      order_line_id: 30,
      created_by: JOHNNY,
    }),
    movement({
      id: 1,
      delta: 2640,
      reason: 'opening',
      note: 'Count on hand when the ledger started',
    }),
    movement({
      id: 4,
      delta: 1440,
      reason: 'void',
      order_id: 12,
      order_line_id: 30,
      created_by: PAUL,
      note: 'Came off house stock',
    }),
    movement({ id: 5, delta: -2640, reason: 'archive', created_by: PAUL, note: 'Customer closed' }),
  ]
  const orders = [
    {
      id: 12,
      customer_name: 'Hotel Vintage',
      order_date: '2026-10-02',
      voided_at: '2026-10-15T18:00:00Z',
    },
  ]

  it('lists the newest first, with the count each change left', () => {
    expect(historyEntries(movements, orders, PAUL).map((e) => [e.id, e.change, e.balance])).toEqual(
      [
        [5, -2640, 0],
        [4, 1440, 2640],
        [3, -1440, 1200],
        [1, 2640, 2640],
      ]
    )
  })

  it('says who made each change, from the viewer’s side', () => {
    expect(historyEntries(movements, orders, PAUL).map((e) => e.by)).toEqual([
      'you',
      'you',
      'partner',
      'system',
    ])
    expect(historyEntries(movements, orders, JOHNNY).map((e) => e.by)).toEqual([
      'partner',
      'partner',
      'you',
      'system',
    ])
  })

  it('attaches the order, and still names it when the order details are missing', () => {
    const [, voided, ordered, opening] = historyEntries(movements, orders, PAUL)
    expect(ordered.order).toEqual({
      id: 12,
      customerName: 'Hotel Vintage',
      orderDate: '2026-10-02',
      voided: true,
    })
    expect(voided.note).toBe('Came off house stock')
    expect(opening.order).toBeNull()
    expect(historyEntries(movements, [], PAUL)[2].order).toEqual({
      id: 12,
      customerName: null,
      orderDate: null,
      voided: false,
    })
  })

  it('treats a missing author as the system', () => {
    expect(changedBy(null, PAUL)).toBe('system')
  })
})

describe('reasonLabel and orderLabel', () => {
  it('names each reason, telling archive from unarchive by what is left', () => {
    expect(reasonLabel({ reason: 'opening', balance: 10 })).toBe('Opening count')
    expect(reasonLabel({ reason: 'fill', balance: 10 })).toBe('Filled')
    expect(reasonLabel({ reason: 'order', balance: 10 })).toBe('Order')
    expect(reasonLabel({ reason: 'void', balance: 10 })).toBe('Order voided')
    expect(reasonLabel({ reason: 'adjustment', balance: 10 })).toBe('Count changed')
    expect(reasonLabel({ reason: 'archive', balance: 0 })).toBe('Archived')
    expect(reasonLabel({ reason: 'archive', balance: 2640 })).toBe('Unarchived')
  })

  it('labels an order with its customer, date and status', () => {
    expect(
      orderLabel({ id: 12, customerName: 'Hotel Vintage', orderDate: '2026-10-02', voided: true })
    ).toBe('Order #12 · Hotel Vintage · Oct 2, 2026 · voided')
    expect(orderLabel({ id: 9, customerName: null, orderDate: null, voided: false })).toBe(
      'Order #9'
    )
  })
})

describe('dates', () => {
  it('takes today in Portland, not UTC', () => {
    // 10 PM on Oct 15 in Portland is already Oct 16 in UTC.
    expect(portlandToday(new Date('2026-10-16T05:00:00Z'))).toBe('2026-10-15')
    expect(portlandToday(new Date('2026-10-16T08:00:00Z'))).toBe('2026-10-16')
  })

  it('shows a fill date without shifting it a day', () => {
    expect(formatDay('2026-10-02')).toBe('Oct 2, 2026')
    expect(formatDay(null)).toBeNull()
    expect(formatDay('soon')).toBe('soon')
  })

  it('dates a timestamp by the Portland day, not the UTC one', () => {
    // 6 PM on Oct 15 in Portland is 1 AM on Oct 16 in UTC.
    expect(formatPortlandDay('2026-10-16T01:00:00Z')).toBe('Oct 15, 2026')
    expect(formatPortlandDay(null)).toBeNull()
  })

  it('shows a moment in Portland time', () => {
    // Newer ICU puts a narrow no-break space before PM.
    expect(formatMoment('2026-10-02T22:14:00Z').replace(/\s/g, ' ')).toBe('Oct 2, 2026, 3:14 PM')
  })
})
