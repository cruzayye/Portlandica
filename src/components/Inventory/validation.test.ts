import { describe, expect, it } from 'vitest'
import type { CountChange, NewBatchInput } from './types'
import {
  MAX_CANS,
  archiveProblem,
  blineUpdateProblem,
  countChangeProblem,
  fillProblem,
  isIsoDate,
  optionalNoteProblem,
} from './validation'

const fill = (over: Partial<NewBatchInput> = {}): NewBatchInput => ({
  kind: 'house',
  product: 'still',
  cans: 1440,
  name: 'Portlandica',
  customerId: null,
  source: 'North Powder',
  fillDate: '2026-10-15',
  totalCost: null,
  invoiceNumber: null,
  note: null,
  ...over,
})

const change = (over: Partial<CountChange> = {}): CountChange => ({
  batchId: 45,
  newCount: 216,
  expectedCount: 240,
  note: 'Recount',
  ...over,
})

describe('fillProblem', () => {
  it('accepts a complete house fill and a custom fill', () => {
    expect(fillProblem(fill())).toBeNull()
    expect(fillProblem(fill({ kind: 'custom', name: null, customerId: 5 }))).toBeNull()
    expect(
      fillProblem(fill({ product: 'sparkling', totalCost: 1200.5, invoiceNumber: 'A1' }))
    ).toBeNull()
  })

  it('needs a name for house stock and a customer for custom cans', () => {
    expect(fillProblem(fill({ name: '  ' }))).toBe('Name the batch.')
    expect(fillProblem(fill({ kind: 'custom', customerId: null }))).toBe(
      'Pick the customer these cans were filled for.'
    )
  })

  it('needs a positive whole number of cans, within reason', () => {
    expect(fillProblem(fill({ cans: 0 }))).toBe('Enter how many cases were filled.')
    expect(fillProblem(fill({ cans: 12.5 }))).toBe('Enter how many cases were filled.')
    expect(fillProblem(fill({ cans: MAX_CANS + 1 }))).toMatch(/more than 100,000 cans/)
  })

  it('needs a source and a real fill date', () => {
    expect(fillProblem(fill({ source: '' }))).toBe('Pick the water source.')
    expect(fillProblem(fill({ fillDate: '' }))).toBe('Enter the fill date.')
    expect(fillProblem(fill({ fillDate: '2026-02-30' }))).toBe('Enter the fill date.')
  })

  it('takes a cost in dollars or none', () => {
    expect(fillProblem(fill({ totalCost: NaN }))).toMatch(/total cost/)
    expect(fillProblem(fill({ totalCost: -1 }))).toMatch(/total cost/)
  })

  it('limits the note', () => {
    expect(fillProblem(fill({ note: 'x'.repeat(501) }))).toMatch(/under 500 characters/)
  })

  it('never throws on whatever a direct call sends', () => {
    const odd = [null, undefined, {}, 'text', 5, { kind: 'house', product: 'gin' }]
    for (const input of odd) {
      expect(fillProblem(input as unknown as NewBatchInput)).toEqual(expect.any(String))
    }
    expect(fillProblem(fill({ name: 42 as unknown as string }))).toBe('Name the batch.')
  })
})

describe('countChangeProblem', () => {
  it('accepts a counted number with a note', () => {
    expect(countChangeProblem(change())).toBeNull()
    expect(countChangeProblem(change({ newCount: 0 }))).toBeNull()
  })

  it('requires a note saying why', () => {
    expect(countChangeProblem(change({ note: ' ' }))).toBe('Say why the count is changing.')
  })

  it('refuses counts below zero, partial cans and typos', () => {
    expect(countChangeProblem(change({ newCount: -1 }))).toMatch(/0 or more/)
    expect(countChangeProblem(change({ newCount: 1.5 }))).toMatch(/0 or more/)
    expect(countChangeProblem(change({ newCount: MAX_CANS + 1 }))).toMatch(/more than/)
  })

  it('never throws on odd input', () => {
    expect(countChangeProblem(null as unknown as CountChange)).toBe('Pick a batch.')
    expect(countChangeProblem({} as CountChange)).toBe('Pick a batch.')
  })
})

describe('archiveProblem', () => {
  it('needs a reason when cans would be written off', () => {
    expect(archiveProblem(240, '')).toBe('Say why this batch is being archived.')
    expect(archiveProblem(-120, null)).toBe('Say why this batch is being archived.')
    expect(archiveProblem(240, 'Customer closed')).toBeNull()
  })

  it('does not need one for an empty batch', () => {
    expect(archiveProblem(0, '')).toBeNull()
    expect(archiveProblem(0, null)).toBeNull()
  })
})

describe('optionalNoteProblem and isIsoDate', () => {
  it('allows a blank note but not a long one', () => {
    expect(optionalNoteProblem(null)).toBeNull()
    expect(optionalNoteProblem('')).toBeNull()
    expect(optionalNoteProblem('x'.repeat(501))).toMatch(/under 500/)
    expect(optionalNoteProblem(7)).toMatch(/under 500/)
  })

  it('checks dates are real', () => {
    expect(isIsoDate('2026-10-15')).toBe(true)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('10/15/2026')).toBe(false)
  })
})

describe('blineUpdateProblem', () => {
  const sent = { kind: 'sent' as const, batchId: 45, cans: 1440, movedOn: '2026-11-02', note: null }
  const count = {
    kind: 'count' as const,
    batchId: 45,
    counted: 1380,
    expectedCount: 1392,
    note: "BLine's email",
  }

  it('accepts cans sent or brought back, and a count with where it came from', () => {
    expect(blineUpdateProblem(sent)).toBeNull()
    expect(blineUpdateProblem({ ...sent, kind: 'returned', cans: 24 })).toBeNull()
    expect(blineUpdateProblem(count)).toBeNull()
    expect(blineUpdateProblem({ ...count, counted: 0 })).toBeNull()
  })

  it('says what is missing or wrong', () => {
    expect(blineUpdateProblem({ ...sent, batchId: 0 })).toBe('Pick a batch.')
    expect(blineUpdateProblem({ ...sent, cans: 0 })).toBe('Enter how many cans.')
    expect(blineUpdateProblem({ ...sent, cans: 2.5 })).toBe('Enter how many cans.')
    expect(blineUpdateProblem({ ...sent, cans: 200_000 })).toMatch(/more than 100,000 cans/)
    expect(blineUpdateProblem({ ...sent, movedOn: '11/09/2026' })).toBe('Enter the date.')
    expect(blineUpdateProblem({ ...sent, note: 'x'.repeat(501) })).toMatch(/under 500 characters/)
    expect(blineUpdateProblem({ ...count, counted: -1 })).toMatch(/0 or more/)
    expect(blineUpdateProblem({ ...count, note: ' ' })).toBe('Say where the count came from.')
    expect(blineUpdateProblem({ ...sent, movedOn: '2099-01-01' })).toBe(
      "The date can't be after today."
    )
    expect(blineUpdateProblem({ ...count, expectedCount: Number.NaN })).toBe(
      'Reload and try again.'
    )
    expect(blineUpdateProblem({ ...sent, kind: 'lost' } as never)).toBe(
      'Choose sent, brought back or counted.'
    )
    expect(blineUpdateProblem(null as never)).toBe('Pick a batch.')
  })
})
