// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}))

import { AUTH_UNAVAILABLE, NOT_A_PARTNER, SIGNED_OUT, isAuthFailure, requireUser } from './requireUser'

const signedInAs = (email: string | undefined) =>
  getUser.mockResolvedValue({ data: { user: { id: 'user-1', email } }, error: null })

describe('requireUser', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOWED_EMAILS', 'partner@example.com, second@example.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    getUser.mockReset()
  })

  it('accepts a signed-in partner', async () => {
    signedInAs('partner@example.com')
    const result = await requireUser()
    expect(result.failure).toBeNull()
    expect(result.user?.email).toBe('partner@example.com')
  })

  it('matches the partner email regardless of case', async () => {
    signedInAs('Second@Example.com')
    expect((await requireUser()).failure).toBeNull()
  })

  it('rejects a caller with no session', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() })
    expect(await requireUser()).toEqual({ user: null, failure: { authError: SIGNED_OUT } })
  })

  it('rejects a signed-in user who is not on the list', async () => {
    signedInAs('stranger@example.com')
    expect(await requireUser()).toEqual({ user: null, failure: { authError: NOT_A_PARTNER } })
  })

  it('rejects a signed-in user with no email', async () => {
    signedInAs(undefined)
    expect((await requireUser()).failure).toEqual({ authError: NOT_A_PARTNER })
  })

  it('rejects everyone when ALLOWED_EMAILS is not set', async () => {
    vi.stubEnv('ALLOWED_EMAILS', '')
    signedInAs('partner@example.com')
    expect((await requireUser()).failure).toEqual({ authError: NOT_A_PARTNER })
  })

  it('says to try again when Supabase Auth cannot be reached', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('fetch failed', 0),
    })
    expect((await requireUser()).failure).toEqual({ authError: AUTH_UNAVAILABLE })
  })
})

describe('isAuthFailure', () => {
  it('recognises the failure value and nothing else', () => {
    expect(isAuthFailure({ authError: SIGNED_OUT })).toBe(true)
    expect(isAuthFailure([])).toBe(false)
    expect(isAuthFailure(undefined)).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
    expect(isAuthFailure({ duplicate: false })).toBe(false)
  })
})
