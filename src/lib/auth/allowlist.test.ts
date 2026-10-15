import { describe, it, expect } from 'vitest'
import { isAllowedEmail, parseAllowlist } from './allowlist'

describe('parseAllowlist', () => {
  it('splits a comma-separated list and trims spaces', () => {
    expect(parseAllowlist('a@example.com, b@example.com ,c@example.com')).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ])
  })

  it('lower-cases every entry', () => {
    expect(parseAllowlist('Partner@Example.COM')).toEqual(['partner@example.com'])
  })

  it('accepts newlines and semicolons as separators too', () => {
    expect(parseAllowlist('a@example.com\nb@example.com;c@example.com')).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ])
  })

  it('drops blank entries and duplicates', () => {
    expect(parseAllowlist(',a@example.com,, A@example.com,')).toEqual(['a@example.com'])
  })

  it('is empty when the variable is unset or blank', () => {
    expect(parseAllowlist(undefined)).toEqual([])
    expect(parseAllowlist('')).toEqual([])
    expect(parseAllowlist(' , ')).toEqual([])
  })
})

describe('isAllowedEmail', () => {
  const allowlist = parseAllowlist('partner@example.com,second@example.com')

  it('lets in an email on the list', () => {
    expect(isAllowedEmail('partner@example.com', allowlist)).toBe(true)
    expect(isAllowedEmail('second@example.com', allowlist)).toBe(true)
  })

  it('ignores case and surrounding spaces', () => {
    expect(isAllowedEmail(' Partner@Example.com ', allowlist)).toBe(true)
  })

  it('rejects an email that is not on the list', () => {
    expect(isAllowedEmail('stranger@example.com', allowlist)).toBe(false)
  })

  it('matches whole addresses only, never parts of one', () => {
    expect(isAllowedEmail('xpartner@example.com', allowlist)).toBe(false)
    expect(isAllowedEmail('partner@example.co', allowlist)).toBe(false)
    expect(isAllowedEmail('partner@example.com.attacker.io', allowlist)).toBe(false)
    expect(isAllowedEmail('partner@example.com,second@example.com', allowlist)).toBe(false)
  })

  it('rejects a missing email', () => {
    expect(isAllowedEmail(null, allowlist)).toBe(false)
    expect(isAllowedEmail(undefined, allowlist)).toBe(false)
    expect(isAllowedEmail('', allowlist)).toBe(false)
  })

  it('lets nobody in when the allowlist is empty', () => {
    expect(isAllowedEmail('partner@example.com', [])).toBe(false)
    expect(isAllowedEmail('', [])).toBe(false)
  })
})
