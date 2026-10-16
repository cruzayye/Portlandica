import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AuthConfig } from './config'

// The team session: one shared password, and a signed cookie per device. Node's crypto
// only, no extra dependencies.

/** The session cookie. Its value is a signed token; the password itself is never stored. */
export const SESSION_COOKIE = 'portlandica_session'

/** How long a device stays signed in. */
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

/** How long a wrong password waits before the answer comes back. */
export const WRONG_PASSWORD_DELAY_MS = 750

type SessionPayload = {
  /** Issued at, in seconds since 1970. */
  iat: number
  /** Expires at, in seconds since 1970. */
  exp: number
  /** Password version: see passwordVersion(). */
  pv: string
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()

const sign = (data: string, secret: string) =>
  createHmac('sha256', secret).update(data, 'utf8').digest('base64url')

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

const inSeconds = (ms: number) => Math.floor(ms / 1000)

/**
 * Whether the typed password is the team password. Both sides are hashed to 32 bytes first,
 * so the comparison takes the same time whatever was typed.
 */
export const passwordMatches = (input: string, password: string) =>
  timingSafeEqual(sha256(input), sha256(password))

/**
 * Ties a session to the password it was made with: the first 16 hex characters of
 * SHA-256(TEAM_PASSWORD). Changing the password changes it, which signs everyone out.
 */
export const passwordVersion = (password: string) => sha256(password).toString('hex').slice(0, 16)

/** `<payload>.<signature>`: base64url JSON `{ iat, exp, pv }`, HMAC-SHA256 signed. */
export const createSessionToken = ({ password, sessionSecret }: AuthConfig, now = Date.now()) => {
  const iat = inSeconds(now)
  const payload: SessionPayload = {
    iat,
    exp: iat + SESSION_MAX_AGE_SECONDS,
    pv: passwordVersion(password),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded, sessionSecret)}`
}

const isPayload = (value: unknown): value is SessionPayload => {
  if (typeof value !== 'object' || value === null) return false
  const { iat, exp, pv } = value as Record<string, unknown>
  return Number.isInteger(iat) && Number.isInteger(exp) && typeof pv === 'string'
}

/**
 * True only for a token signed with SESSION_SECRET, not yet expired, and made with the
 * current TEAM_PASSWORD. Anything else (no cookie, a forged or edited token, an old one)
 * is false.
 */
export const verifySessionToken = (
  token: string | undefined,
  { password, sessionSecret }: AuthConfig,
  now = Date.now()
) => {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [encoded, signature] = parts
  if (!sameText(signature, sign(encoded, sessionSecret))) return false

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  return (
    isPayload(payload) &&
    inSeconds(now) < payload.exp &&
    sameText(payload.pv, passwordVersion(password))
  )
}

/**
 * HttpOnly (page scripts can't read it), Secure (HTTPS only, except `next dev` on
 * http://localhost), SameSite=Lax, for the whole site, for 90 days.
 */
export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
})
