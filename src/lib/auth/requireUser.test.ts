// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined,
  }),
}))

import { requireUser } from './requireUser'
import { SESSION_COOKIE } from './session'
import { SIGNED_OUT, SIGN_IN_NOT_SET_UP, isAuthFailure } from './authFailure'
import { rejectedTokens, stubTestAuthEnv, validToken } from './testing/sessions'

beforeEach(() => {
  jar.cookies.clear()
  stubTestAuthEnv()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('requireUser', () => {
  it('accepts a device signed in with the team password', async () => {
    jar.cookies.set(SESSION_COOKIE, validToken())
    expect(await requireUser()).toEqual({ failure: null })
  })

  it('refuses a caller with no session cookie', async () => {
    expect(await requireUser()).toEqual({ failure: { authError: SIGNED_OUT } })
  })

  it.each(Object.entries(rejectedTokens()))('refuses a cookie that is %s', async (_, token) => {
    jar.cookies.set(SESSION_COOKIE, token)
    expect(await requireUser()).toEqual({ failure: { authError: SIGNED_OUT } })
  })

  it('ignores a session token under any other cookie name', async () => {
    jar.cookies.set('session', validToken())
    expect(await requireUser()).toEqual({ failure: { authError: SIGNED_OUT } })
  })

  it.each([
    ['TEAM_PASSWORD is missing', { TEAM_PASSWORD: '' }],
    ['TEAM_PASSWORD is under 12 characters', { TEAM_PASSWORD: 'short' }],
    ['SESSION_SECRET is missing', { SESSION_SECRET: '' }],
    ['SESSION_SECRET is under 32 characters', { SESSION_SECRET: 'not-thirty-two-characters' }],
  ])('refuses everyone, and logs it, when %s', async (_, env) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    jar.cookies.set(SESSION_COOKIE, validToken())

    expect(await requireUser()).toEqual({ failure: { authError: SIGN_IN_NOT_SET_UP } })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Team sign-in is switched off'))
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
