import { describe, it, expect } from 'vitest'
import { toCases, toPallets, toCost } from './Inventory'

describe('toCases', () => {
  it('converts cans to whole cases', () => {
    expect(toCases(24)).toBe('1 case')
    expect(toCases(48)).toBe('2 cases')
  })

  it('singularizes only at exactly one case', () => {
    expect(toCases(24)).toBe('1 case')
    expect(toCases(23)).toContain('cases')
  })

  it('trims trailing zeros on partial cases', () => {
    expect(toCases(36)).toBe('1.5 cases')
    expect(toCases(12)).toBe('0.5 cases')
  })

  it('reports zero stock', () => {
    expect(toCases(0)).toBe('0 cases')
  })

  it('handles oversold negative counts', () => {
    expect(toCases(-240)).toBe('-10 cases')
  })
})

describe('toPallets', () => {
  it('converts cans to whole pallets', () => {
    expect(toPallets(1440)).toBe('1 pallet')
    expect(toPallets(2880)).toBe('2 pallets')
  })

  it('rounds to two decimals', () => {
    expect(toPallets(504)).toBe('0.35 pallets')
  })

  it('reports zero stock', () => {
    expect(toPallets(0)).toBe('0 pallets')
  })

  it('handles oversold negative counts', () => {
    expect(toPallets(-8880)).toBe('-6.17 pallets')
  })
})

describe('toCost', () => {
  it('returns null when cost is unset', () => {
    expect(toCost(null)).toBeNull()
  })

  it('formats to two decimals with separators', () => {
    expect(toCost(1284)).toBe('$1,284.00')
    expect(toCost(1284.5)).toBe('$1,284.50')
  })

  it('formats zero as a real amount, not blank', () => {
    expect(toCost(0)).toBe('$0.00')
  })

  it('accepts numeric strings from PostgREST', () => {
    // Supabase can hand back `numeric` columns as strings.
    expect(toCost('1284.5' as unknown as number)).toBe('$1,284.50')
  })
})
