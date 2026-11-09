import { describe, expect, it } from 'vitest'
import { blineFee, blineFeeNote, blineNotes, feePerRow } from './bline'

describe('blineFee', () => {
  it.each([
    [0, 10], // a donation still costs a delivery
    [36, 10], // one case
    [72, 10],
    [99.99, 10],
    [100, 10], // the two rules agree at $100
    [100.05, 10.01], // 10.005 rounds up
    [108, 10.8],
    [144, 14.4],
    [1353.74, 135.37],
  ])('charges $%s orders %s', (total, fee) => {
    expect(blineFee(total)).toBe(fee)
  })
})

describe('blineFeeNote', () => {
  it('says which rule applies', () => {
    expect(blineFeeNote(36)).toBe('$10.00 (flat fee under $100)')
    expect(blineFeeNote(0)).toBe('$10.00 (flat fee under $100)')
    expect(blineFeeNote(144)).toBe('$14.40 (10% of $144.00)')
  })
})

describe('feePerRow', () => {
  it('splits the fee over the rows in proportion to their amounts, to the cent', () => {
    expect(feePerRow(10.8, [72, 36])).toEqual([7.2, 3.6])
    expect(feePerRow(10, [36, 36])).toEqual([5, 5])
    expect(feePerRow(10, [180, 72, 0])).toEqual([7.14, 2.86, 0])
    const rows = feePerRow(13.33, [100, 100, 133.3])
    expect(rows.reduce((a, b) => a + Math.round(b * 100), 0)).toBe(1333)
  })

  it('spreads it evenly when no row has an amount (a donation)', () => {
    expect(feePerRow(10, [0, 0])).toEqual([5, 5])
    expect(feePerRow(10, [0])).toEqual([10])
  })
})

describe('blineNotes', () => {
  it('marks the notes of a BLine order, with the fee on a donation', () => {
    expect(blineNotes(null, 10, false)).toBe('BLine delivery')
    expect(blineNotes('Back door', 14.4, false)).toBe('BLine delivery · Back door')
    expect(blineNotes(null, 10, true)).toBe('BLine delivery ($10.00 fee)')
    expect(blineNotes('Gala', 10, true)).toBe('BLine delivery ($10.00 fee) · Gala')
  })
})
