// @vitest-environment node
import { createHash, createHmac } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  passwordMatches,
  passwordVersion,
  sessionCookieOptions,
  verifySessionToken,
} from './session'
import { TEST_AUTH, rejectedTokens, validToken } from './testing/sessions'

const decodePayload = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))

// A correctly signed token, whatever its payload says.
const signedToken = (payload: string) => {
  const encoded = Buffer.from(payload).toString('base64url')
  const signature = createHmac('sha256', TEST_AUTH.sessionSecret)
    .update(encoded)
    .digest('base64url')
  return `${encoded}.${signature}`
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('passwordMatches', () => {
  it('accepts exactly the team password', () => {
    expect(passwordMatches(TEST_AUTH.password, TEST_AUTH.password)).toBe(true)
  })

  it('refuses anything else, however close', () => {
    for (const guess of [
      '',
      'made-up team password',
      `${TEST_AUTH.password} `,
      TEST_AUTH.password.toUpperCase(),
      `${TEST_AUTH.password}x`,
    ]) {
      expect(passwordMatches(guess, TEST_AUTH.password)).toBe(false)
    }
  })
})

describe('passwordVersion', () => {
  const version = () => passwordVersion(TEST_AUTH.password, TEST_AUTH.sessionSecret)

  it('is the first 16 hex characters of HMAC-SHA256(SESSION_SECRET, password)', () => {
    const hmac = createHmac('sha256', TEST_AUTH.sessionSecret)
      .update(TEST_AUTH.password)
      .digest('hex')
    expect(version()).toBe(hmac.slice(0, 16))
    expect(version()).toMatch(/^[0-9a-f]{16}$/)
  })

  it("can't be worked out from the password alone", () => {
    // A plain hash of a guess must not match, or a copied cookie could test guesses offline.
    const sha = createHash('sha256').update(TEST_AUTH.password).digest('hex')
    expect(version()).not.toBe(sha.slice(0, 16))
  })

  it('changes with the password and with the session secret', () => {
    expect(passwordVersion('another team password', TEST_AUTH.sessionSecret)).not.toBe(version())
    expect(passwordVersion(TEST_AUTH.password, 'a-brand-new-session-secret-0123456789')).not.toBe(
      version()
    )
  })
})

describe('createSessionToken', () => {
  it('carries when it was made, when it expires (90 days on) and the password version', () => {
    const now = Date.UTC(2026, 9, 15, 12, 0, 0)
    const payload = decodePayload(createSessionToken(TEST_AUTH, now))
    expect(payload).toEqual({
      iat: now / 1000,
      exp: now / 1000 + 90 * 24 * 60 * 60,
      pv: passwordVersion(TEST_AUTH.password, TEST_AUTH.sessionSecret),
    })
    expect(SESSION_MAX_AGE_SECONDS).toBe(7_776_000)
  })

  it('never contains the password or the secret', () => {
    const token = validToken()
    const decoded = Buffer.from(token.split('.')[0], 'base64url').toString('utf8')
    for (const text of [token, decoded]) {
      expect(text).not.toContain(TEST_AUTH.password)
      expect(text).not.toContain(TEST_AUTH.sessionSecret)
    }
  })
})

describe('verifySessionToken', () => {
  it('accepts a token it signed', () => {
    expect(verifySessionToken(validToken(), TEST_AUTH)).toBe(true)
  })

  it('refuses no token at all', () => {
    expect(verifySessionToken(undefined, TEST_AUTH)).toBe(false)
    expect(verifySessionToken('', TEST_AUTH)).toBe(false)
  })

  it.each(Object.entries(rejectedTokens()))('refuses a token that is %s', (_, token) => {
    expect(verifySessionToken(token, TEST_AUTH)).toBe(false)
  })

  it('expires 90 days after sign-in, to the second', () => {
    const signedInAt = Date.UTC(2026, 9, 15, 12, 0, 0)
    const token = createSessionToken(TEST_AUTH, signedInAt)
    const later = (seconds: number) => signedInAt + seconds * 1000

    expect(verifySessionToken(token, TEST_AUTH, later(SESSION_MAX_AGE_SECONDS - 1))).toBe(true)
    expect(verifySessionToken(token, TEST_AUTH, later(SESSION_MAX_AGE_SECONDS))).toBe(false)
  })

  it('signs everyone out when the password changes', () => {
    const token = validToken()
    const changed = { ...TEST_AUTH, password: 'the new team password' }
    expect(verifySessionToken(token, changed)).toBe(false)
    expect(verifySessionToken(createSessionToken(changed), changed)).toBe(true)
  })

  it('signs everyone out when the session secret changes', () => {
    const changed = { ...TEST_AUTH, sessionSecret: 'a-brand-new-session-secret-0123456789' }
    expect(verifySessionToken(validToken(), changed)).toBe(false)
  })

  it('refuses a signed token whose payload is not a session', () => {
    expect(verifySessionToken(signedToken('not json'), TEST_AUTH)).toBe(false)
    expect(verifySessionToken(signedToken('{"exp":9999999999}'), TEST_AUTH)).toBe(false)
    expect(verifySessionToken(signedToken('null'), TEST_AUTH)).toBe(false)
    expect(
      verifySessionToken(
        signedToken(
          JSON.stringify({
            iat: '1',
            exp: '9999999999',
            pv: passwordVersion(TEST_AUTH.password, TEST_AUTH.sessionSecret),
          })
        ),
        TEST_AUTH
      )
    ).toBe(false)
  })

  it('refuses extra parts', () => {
    expect(verifySessionToken(`${validToken()}.extra`, TEST_AUTH)).toBe(false)
  })
})

describe('sessionCookieOptions', () => {
  it('is HttpOnly, Secure, SameSite=Lax, site-wide, for 90 days', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7_776_000,
    })
  })

  it('drops Secure only for next dev, which serves http://localhost', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(sessionCookieOptions().secure).toBe(false)
    vi.stubEnv('NODE_ENV', 'test')
    expect(sessionCookieOptions().secure).toBe(true)
  })

  it('becomes a Set-Cookie header with every flag', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const response = NextResponse.next()
    response.cookies.set(SESSION_COOKIE, 'token', sessionCookieOptions())
    const header = response.headers.get('set-cookie') ?? ''

    expect(header).toMatch(/^portlandica_session=token;/)
    expect(header).toMatch(/; HttpOnly/i)
    expect(header).toMatch(/; Secure/i)
    expect(header).toMatch(/; SameSite=Lax/i)
    expect(header).toMatch(/; Path=\//i)
    expect(header).toMatch(/; Max-Age=7776000/i)
  })
})
