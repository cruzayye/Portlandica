import { vi } from 'vitest'
import type { AuthConfig } from '../config'
import { SESSION_MAX_AGE_SECONDS, createSessionToken, passwordVersion } from '../session'

// Test helpers: made-up team-password settings, and session cookies of every kind the app
// must turn away. None of these values is used anywhere real.

export const TEST_AUTH: AuthConfig = {
  password: 'made-up team password for tests',
  sessionSecret: 'made-up-session-secret-for-tests-0123456789',
}

/** Sets TEAM_PASSWORD and SESSION_SECRET to TEST_AUTH. Undo with vi.unstubAllEnvs(). */
export const stubTestAuthEnv = (over: Partial<AuthConfig> = {}) => {
  const { password, sessionSecret } = { ...TEST_AUTH, ...over }
  vi.stubEnv('TEAM_PASSWORD', password)
  vi.stubEnv('SESSION_SECRET', sessionSecret)
}

export const validToken = (now = Date.now()) => createSessionToken(TEST_AUTH, now)

/** A valid token's signature on a payload someone edited to last ten years. */
const tamperedToken = () => {
  const [, signature] = validToken().split('.')
  const iat = Math.floor(Date.now() / 1000)
  const payload = {
    iat,
    exp: iat + 10 * 365 * 24 * 60 * 60,
    pv: passwordVersion(TEST_AUTH.password),
  }
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`
}

/** Cookies that must never count as signed in, by name. */
export const rejectedTokens = () => ({
  forged: createSessionToken({
    ...TEST_AUTH,
    sessionSecret: 'someone-elses-session-secret-0123456789',
  }),
  expired: validToken(Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000),
  'from before the password changed': createSessionToken({
    ...TEST_AUTH,
    password: 'the team password before this one',
  }),
  tampered: tamperedToken(),
  'not a token': 'hello',
})
