import { describe, it, expect } from 'vitest'
import {
  countAsQuantity,
  formatCans,
  formatChange,
  parseDollars,
  quantityToCans,
  toCases,
  toCost,
  toPallets,
} from './units'

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

describe('formatCans', () => {
  it('adds separators and the unit', () => {
    expect(formatCans(12000)).toBe('12,000 cans')
    expect(formatCans(1)).toBe('1 can')
    expect(formatCans(-120)).toBe('-120 cans')
  })
})

describe('formatChange', () => {
  it('signs additions and keeps the minus on removals', () => {
    expect(formatChange(1440)).toBe('+1,440')
    expect(formatChange(-24)).toBe('-24')
  })
})

describe('toCases and toPallets', () => {
  it('never shows minus zero', () => {
    expect(toPallets(-1)).toBe('0 pallets')
    expect(toCases(-0)).toBe('0 cases')
  })

  it('separates thousands', () => {
    expect(toCases(120000)).toBe('5,000 cases')
  })

  it('says pallet once it rounds to one', () => {
    expect(toPallets(1438)).toBe('1 pallet')
  })
})

describe('quantityToCans', () => {
  it('converts cases to cans', () => {
    expect(quantityToCans('10', 'cases')).toBe(240)
    expect(quantityToCans('2.5', 'cases')).toBe(60)
    expect(quantityToCans('.5', 'cases')).toBe(12)
    expect(quantityToCans(' 1,000 ', 'cases')).toBe(24000)
  })

  it('takes whole cans as typed', () => {
    expect(quantityToCans('230', 'cans')).toBe(230)
    expect(quantityToCans('0', 'cans')).toBe(0)
  })

  it('refuses anything that is not a whole number of cans', () => {
    expect(quantityToCans('2.1', 'cases')).toBeNull()
    expect(quantityToCans('12.5', 'cans')).toBeNull()
    expect(quantityToCans('-5', 'cases')).toBeNull()
    expect(quantityToCans('1e3', 'cans')).toBeNull()
    expect(quantityToCans('ten', 'cans')).toBeNull()
    expect(quantityToCans('', 'cans')).toBeNull()
  })
})

describe('countAsQuantity', () => {
  it('starts in cases when the count fills whole cases', () => {
    expect(countAsQuantity(240)).toEqual({ unit: 'cases', text: '10' })
    expect(countAsQuantity(0)).toEqual({ unit: 'cases', text: '0' })
  })

  it('starts in cans otherwise', () => {
    expect(countAsQuantity(230)).toEqual({ unit: 'cans', text: '230' })
  })

  it('starts empty for a count below zero', () => {
    expect(countAsQuantity(-120)).toEqual({ unit: 'cases', text: '' })
  })
})

describe('parseDollars', () => {
  it('reads amounts with or without $ and separators', () => {
    expect(parseDollars('1200')).toBe(1200)
    expect(parseDollars('$1,284.50')).toBe(1284.5)
    expect(parseDollars('.5')).toBe(0.5)
  })

  it('is null when blank and NaN when not an amount', () => {
    expect(parseDollars('  ')).toBeNull()
    expect(parseDollars('12.345')).toBeNaN()
    expect(parseDollars('abc')).toBeNaN()
  })
})
