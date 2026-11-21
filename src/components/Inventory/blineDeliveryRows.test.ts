import { describe, expect, it } from 'vitest'
import type { FileOrder } from '@/lib/findelivers'
import { monthLine, monthName, shortDay, waitingSummary, waitingTitle } from './blineDeliveryRows'

const waiting = (over: Partial<FileOrder> = {}): FileOrder => ({
  id: 87,
  customerName: 'Cheese & Crackers Shop',
  address: '400 SE Pine St, Portland, OR 97214',
  orderDate: '2026-11-20',
  deliveryDate: '2026-11-25',
  totalCans: 96,
  voided: false,
  blineRef: null,
  blineStatus: null,
  blineProblem: null,
  deliveredAt: null,
  ...over,
})

// Imports at 9:52 PM in Portland on Nov 20 and on Nov 21.
const NOV_20 = '2026-11-21T05:52:00.000Z'
const NOV_21 = '2026-11-22T05:52:00.000Z'

describe('waitingSummary', () => {
  it("only says findelivers hasn't got an order once an import a day later didn't find it", () => {
    expect(waitingSummary(waiting(), null, '2026-11-20')).toEqual({
      text: 'Not in findelivers yet',
      warn: false,
    })
    expect(waitingSummary(waiting(), NOV_20, '2026-11-20')).toEqual({
      text: 'Not in findelivers yet',
      warn: false,
    })
    expect(waitingSummary(waiting(), NOV_21, '2026-11-21')).toEqual({
      text: 'Not in findelivers: email BLine if it should be',
      warn: true,
    })
  })

  it("says where findelivers has it, and warns when it isn't going to plan", () => {
    expect(
      waitingSummary(
        waiting({ blineRef: '261120.0040', blineStatus: 'in_transit' }),
        NOV_21,
        '2026-11-21'
      )
    ).toEqual({ text: 'findelivers 261120.0040: In transit', warn: false })
    expect(
      waitingSummary(
        waiting({ blineRef: '261120.0040', blineStatus: 'failed_attempt', blineProblem: 'Closed' }),
        NOV_21,
        '2026-11-21'
      )
    ).toEqual({ text: 'findelivers 261120.0040: Failed attempt (Closed)', warn: true })
  })

  it('warns once the delivery date it was booked for has passed', () => {
    expect(waitingSummary(waiting(), null, '2026-11-26')).toEqual({
      text: 'Not in findelivers yet · past its delivery date',
      warn: true,
    })
    // With no delivery date picked, its order date.
    expect(waitingSummary(waiting({ deliveryDate: null }), null, '2026-11-21').warn).toBe(true)
  })
})

describe('wording', () => {
  it('names an order, a day and a month the way the panel shows them', () => {
    expect(waitingTitle(waiting())).toBe('#87 Cheese & Crackers Shop · booked Nov 20 · for Nov 25')
    expect(waitingTitle(waiting({ deliveryDate: null }))).toBe(
      '#87 Cheese & Crackers Shop · booked Nov 20'
    )
    expect(shortDay('2026-11-01')).toBe('Nov 1')
    expect(monthName('2026-11')).toBe('November 2026')
    expect(monthLine({ month: '2026-10', orders: 1, fees: 10 })).toBe(
      'October 2026: 1 delivered, $10.00 in BLine fees'
    )
  })
})
