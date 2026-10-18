import { describe, expect, it } from 'vitest'
import type { InventoryMovement } from '@/lib/db/types'
import { formatDay, formatMoment, formatPortlandDay, portlandToday } from './dates'
import { changedBy, historyEntries, orderLabel, reasonLabel } from './history'

// With the team password the app's changes have no created_by; made_in_app marks them.
const movement = (over: Partial<InventoryMovement> & { id: number }): InventoryMovement => ({
  batch_id: 22,
  delta: 0,
  reason: 'adjustment',
  order_id: null,
  order_line_id: null,
  note: null,
  created_by: null,
  made_in_app: false,
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
      made_in_app: true,
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
      made_in_app: true,
      note: 'Came off house stock',
    }),
    // Archived in the SQL Editor.
    movement({ id: 5, delta: -2640, reason: 'archive', note: 'Customer closed' }),
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
    expect(historyEntries(movements, orders).map((e) => [e.id, e.change, e.balance])).toEqual([
      [5, -2640, 0],
      [4, 1440, 2640],
      [3, -1440, 1200],
      [1, 2640, 2640],
    ])
  })

  it('says the team made the changes made in the app, and the system the rest', () => {
    expect(historyEntries(movements, orders).map((e) => e.by)).toEqual([
      'system',
      'team',
      'team',
      'system',
    ])
  })

  it('attaches the order, and still names it when the order details are missing', () => {
    const [, voided, ordered, opening] = historyEntries(movements, orders)
    expect(ordered.order).toEqual({
      id: 12,
      customerName: 'Hotel Vintage',
      orderDate: '2026-10-02',
      voided: true,
    })
    expect(voided.note).toBe('Came off house stock')
    expect(opening.order).toBeNull()
    expect(historyEntries(movements, [])[2].order).toEqual({
      id: 12,
      customerName: null,
      orderDate: null,
      voided: false,
    })
  })

  it('goes by whether the change came through the app', () => {
    expect(changedBy({ made_in_app: true })).toBe('team')
    expect(changedBy({ made_in_app: false })).toBe('system')
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
