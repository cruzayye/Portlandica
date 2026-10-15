import { describe, it, expect } from 'vitest'
import { sparkCans, stillCans } from './orders'

describe('stillCans / sparkCans', () => {
  it('counts a product that is switched on', () => {
    expect(stillCans({ isStill: true, totalStill: 120 })).toBe(120)
    expect(sparkCans({ isSpark: true, totalSpark: 48 })).toBe(48)
  })

  it('ignores a leftover quantity once the product is switched off', () => {
    expect(stillCans({ isStill: false, totalStill: 120 })).toBe(0)
    expect(sparkCans({ isSpark: null, totalSpark: 48 })).toBe(0)
  })

  it('treats a blank quantity as zero', () => {
    expect(stillCans({ isStill: true, totalStill: null })).toBe(0)
  })
})
