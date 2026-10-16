// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkAuthConfig, getAuthConfig } from './config'

const PASSWORD = 'twelve chars'
const SECRET = 'x'.repeat(32)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('checkAuthConfig', () => {
  it('accepts a password of 12 characters and a secret of 32', () => {
    expect(PASSWORD).toHaveLength(12)
    expect(checkAuthConfig({ TEAM_PASSWORD: PASSWORD, SESSION_SECRET: SECRET })).toEqual({
      ok: true,
      config: { password: PASSWORD, sessionSecret: SECRET },
    })
  })

  it('switches sign-in off when TEAM_PASSWORD is missing or empty', () => {
    expect(checkAuthConfig({ SESSION_SECRET: SECRET })).toEqual({
      ok: false,
      problems: ['TEAM_PASSWORD is not set'],
    })
    expect(checkAuthConfig({ TEAM_PASSWORD: '', SESSION_SECRET: SECRET })).toEqual({
      ok: false,
      problems: ['TEAM_PASSWORD is not set'],
    })
  })

  it('switches sign-in off when TEAM_PASSWORD is under 12 characters', () => {
    expect(checkAuthConfig({ TEAM_PASSWORD: 'eleven char', SESSION_SECRET: SECRET })).toEqual({
      ok: false,
      problems: ['TEAM_PASSWORD is shorter than 12 characters'],
    })
  })

  it('switches sign-in off when SESSION_SECRET is missing or under 32 characters', () => {
    expect(checkAuthConfig({ TEAM_PASSWORD: PASSWORD })).toEqual({
      ok: false,
      problems: ['SESSION_SECRET is not set'],
    })
    expect(checkAuthConfig({ TEAM_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(31) })).toEqual({
      ok: false,
      problems: ['SESSION_SECRET is shorter than 32 characters'],
    })
  })

  it('lists every problem at once', () => {
    expect(checkAuthConfig({})).toEqual({
      ok: false,
      problems: ['TEAM_PASSWORD is not set', 'SESSION_SECRET is not set'],
    })
  })
})

describe('getAuthConfig', () => {
  it('reads the environment', () => {
    vi.stubEnv('TEAM_PASSWORD', PASSWORD)
    vi.stubEnv('SESSION_SECRET', SECRET)
    expect(getAuthConfig()).toEqual({
      ok: true,
      config: { password: PASSWORD, sessionSecret: SECRET },
    })
  })

  it('logs what is wrong, without the values', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('TEAM_PASSWORD', 'short pw')
    vi.stubEnv('SESSION_SECRET', 'not-long-enough-secret')

    expect(getAuthConfig().ok).toBe(false)

    expect(log).toHaveBeenCalledOnce()
    const message = String(log.mock.calls[0][0])
    expect(message).toContain('TEAM_PASSWORD is shorter than 12 characters')
    expect(message).toContain('SESSION_SECRET is shorter than 32 characters')
    expect(message).not.toContain('short pw')
    expect(message).not.toContain('not-long-enough-secret')
  })

  it('logs nothing when the settings are fine', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('TEAM_PASSWORD', PASSWORD)
    vi.stubEnv('SESSION_SECRET', SECRET)
    getAuthConfig()
    expect(log).not.toHaveBeenCalled()
  })
})
