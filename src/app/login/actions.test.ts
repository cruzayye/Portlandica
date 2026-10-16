// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// signIn and signOut with a stand-in cookie store. redirect() throws in Next.js; here it
// throws a recognisable error instead.

const jar = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  set: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined,
    set: (name: string, value: string, options: object) => {
      jar.set(name, value, options)
      jar.cookies.set(name, value)
    },
  }),
}))

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect to ${url}`)
  },
}))

import { signIn, signOut, type SignInState } from './actions'
import { requireUser } from '@/lib/auth/requireUser'
import { SESSION_COOKIE, WRONG_PASSWORD_DELAY_MS, verifySessionToken } from '@/lib/auth/session'
import { SIGNED_OUT, SIGN_IN_NOT_SET_UP, WRONG_PASSWORD } from '@/lib/auth/authFailure'
import { TEST_AUTH, stubTestAuthEnv } from '@/lib/auth/testing/sessions'

const idle: SignInState = { status: 'idle' }

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

beforeEach(() => {
  jar.cookies.clear()
  jar.set.mockClear()
  stubTestAuthEnv()
  vi.stubEnv('NODE_ENV', 'production')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('signIn with the right password', () => {
  it('sets a signed session cookie and opens the app', async () => {
    await expect(signIn(idle, form({ password: TEST_AUTH.password }))).rejects.toThrow(
      'redirect to /'
    )

    expect(jar.set).toHaveBeenCalledOnce()
    const [name, token, options] = jar.set.mock.calls[0]
    expect(name).toBe('portlandica_session')
    expect(verifySessionToken(token, TEST_AUTH)).toBe(true)
    expect(token).not.toContain(TEST_AUTH.password)
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 90 * 24 * 60 * 60,
    })
  })

  it('leaves Secure off under next dev, which serves http://localhost', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    await expect(signIn(idle, form({ password: TEST_AUTH.password }))).rejects.toThrow()
    expect(jar.set.mock.calls[0][2]).toMatchObject({ secure: false, httpOnly: true })
  })

  it('answers straight away', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    signIn(idle, form({ password: TEST_AUTH.password })).catch(settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalled()
  })

  it('gives a session that server actions accept until the password changes', async () => {
    await expect(signIn(idle, form({ password: TEST_AUTH.password }))).rejects.toThrow()
    expect(await requireUser()).toEqual({ failure: null })

    vi.stubEnv('TEAM_PASSWORD', 'the new team password')
    expect(await requireUser()).toEqual({ failure: { authError: SIGNED_OUT } })
  })
})

describe('signIn with a wrong password', () => {
  it.each([
    ['a wrong password', form({ password: 'not the team password' })],
    ['the password with a trailing space', form({ password: `${TEST_AUTH.password} ` })],
    ['an empty password', form({ password: '' })],
    ['no password field', form({})],
  ])('refuses %s without setting a cookie', async (_, data) => {
    vi.useFakeTimers()
    const result = signIn(idle, data)
    await vi.advanceTimersByTimeAsync(WRONG_PASSWORD_DELAY_MS)

    expect(await result).toEqual({ status: 'error', message: WRONG_PASSWORD })
    expect(jar.set).not.toHaveBeenCalled()
  })

  it('waits about 750 ms before answering', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    signIn(idle, form({ password: 'not the team password' })).then(settled)

    await vi.advanceTimersByTimeAsync(WRONG_PASSWORD_DELAY_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledWith({ status: 'error', message: WRONG_PASSWORD })
    expect(WRONG_PASSWORD_DELAY_MS).toBe(750)
  })
})

describe('signIn when the server is not set up', () => {
  it.each<[string, Record<string, string>]>([
    ['TEAM_PASSWORD is missing', { TEAM_PASSWORD: '' }],
    ['TEAM_PASSWORD is under 12 characters', { TEAM_PASSWORD: 'eleven char' }],
    ['SESSION_SECRET is missing', { SESSION_SECRET: '' }],
    ['SESSION_SECRET is under 32 characters', { SESSION_SECRET: 'x'.repeat(31) }],
  ])('lets nobody in when %s, and logs why', async (_, env) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const password = env.TEAM_PASSWORD ?? TEST_AUTH.password

    expect(await signIn(idle, form({ password }))).toEqual({
      status: 'error',
      message: SIGN_IN_NOT_SET_UP,
    })
    expect(jar.set).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Team sign-in is switched off'))
  })
})

describe('signOut', () => {
  it('clears the session cookie and goes to /login', async () => {
    await expect(signOut()).rejects.toThrow('redirect to /login')

    expect(jar.set).toHaveBeenCalledWith(SESSION_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
  })

  it('leaves the device signed out', async () => {
    await expect(signIn(idle, form({ password: TEST_AUTH.password }))).rejects.toThrow()
    await expect(signOut()).rejects.toThrow()
    expect(await requireUser()).toEqual({ failure: { authError: SIGNED_OUT } })
  })
})
