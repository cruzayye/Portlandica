// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  defaultDeliveryDate,
  deliveryDue,
  formatDeliveryDate,
  isIsoDate,
  nextDeliveryDate,
  pacificDate,
  sheetDate,
  sheetDateSerial,
} from './delivery'

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

  it("gives today's date in Portland, not the server's", () => {
    // 8:30 PM Pacific on the 12th is already the 13th in UTC.
    expect(pacificDate(new Date('2026-10-13T03:30:00Z'))).toBe('2026-10-12')
    expect(pacificDate(new Date('2026-10-13T18:00:00Z'))).toBe('2026-10-13')
  })

  it('defaults the form to the next delivery day', () => {
    expect(defaultDeliveryDate(new Date('2026-10-13T03:30:00Z'))).toBe('2026-10-14')
    expect(defaultDeliveryDate(new Date('2026-10-16T18:00:00Z'))).toBe('2026-10-21')
  })

  it('makes a picked date due at 9 AM Pacific, summer or winter', () => {
    expect(deliveryDue('2026-10-21').toISOString()).toBe('2026-10-21T16:00:00.000Z')
    expect(deliveryDue('2026-12-09').toISOString()).toBe('2026-12-09T17:00:00.000Z')
    expect(() => deliveryDue('2026-02-30')).toThrow()
  })
})

describe('isIsoDate', () => {
  it('takes real YYYY-MM-DD dates only', () => {
    expect(isIsoDate('2026-10-21')).toBe(true)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('10/21/2026')).toBe(false)
    expect(isIsoDate('')).toBe(false)
    expect(isIsoDate(null)).toBe(false)
  })
})

describe('sheet dates', () => {
  it('writes dates the way the Sales sheet shows them', () => {
    expect(sheetDate('2026-10-14')).toBe('10/14/2026')
  })

  it('stores them as the date serials the sheet uses', () => {
    // The Sales sheet holds 10/14/2026 as 46309 and 09/02/2026 as 46267.
    expect(sheetDateSerial('2026-10-14')).toBe(46309)
    expect(sheetDateSerial('2026-09-02')).toBe(46267)
  })
})
