// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config, proxy } from './proxy'
import { SESSION_COOKIE } from '@/lib/auth/session'
import { rejectedTokens, stubTestAuthEnv, validToken } from '@/lib/auth/testing/sessions'

const request = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) =>
  new NextRequest(new URL(path, 'https://portlandica.example'), init)

const withSession = (token: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE}=${token}` },
})

const location = (response: Response) => response.headers.get('location')
const passedThrough = (response: Response) =>
  location(response) === null && response.headers.get('x-middleware-next') === '1'

beforeEach(() => {
  stubTestAuthEnv()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proxy', () => {
  it('redirects a page load without a session to /login', async () => {
    const response = await proxy(request('/'))
    expect(response.status).toBe(307)
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('lets a signed-in device through', async () => {
    expect(passedThrough(await proxy(request('/', withSession(validToken()))))).toBe(true)
  })

  it.each(Object.entries(rejectedTokens()))(
    'redirects a page load with a cookie that is %s to /login',
    async (_, token) => {
      const response = await proxy(request('/', withSession(token)))
      expect(location(response)).toBe('https://portlandica.example/login')
    }
  )

  it('shows /login to visitors without a session', async () => {
    expect(passedThrough(await proxy(request('/login')))).toBe(true)
  })

  it('sends a signed-in device that opens /login to the app', async () => {
    const response = await proxy(request('/login', withSession(validToken())))
    expect(location(response)).toBe('https://portlandica.example/')
  })

  it('redirects the old sign-in link callback like any other private page', async () => {
    const response = await proxy(request('/auth/callback?code=abc'))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('lets a Server Action call without a session reach the action', async () => {
    const response = await proxy(
      request('/', { method: 'POST', headers: { 'next-action': 'abc123' } })
    )
    expect(passedThrough(response)).toBe(true)
  })

  it('does not treat a plain POST as a Server Action call', async () => {
    const response = await proxy(request('/', { method: 'POST' }))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('does not let a page load through just because it sends the action header', async () => {
    const response = await proxy(request('/', { headers: { 'next-action': 'abc123' } }))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('refuses every cookie when TEAM_PASSWORD is not set', async () => {
    const token = validToken()
    vi.stubEnv('TEAM_PASSWORD', '')
    const response = await proxy(request('/', withSession(token)))
    expect(location(response)).toBe('https://portlandica.example/login')
    expect(passedThrough(await proxy(request('/login', withSession(token))))).toBe(true)
  })

  it('refuses every cookie when SESSION_SECRET is too short', async () => {
    const token = validToken()
    vi.stubEnv('SESSION_SECRET', 'too-short')
    const response = await proxy(request('/', withSession(token)))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('sets no cookies of its own', async () => {
    for (const response of [
      await proxy(request('/')),
      await proxy(request('/', withSession(validToken()))),
    ]) {
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })
})

describe('proxy matcher', () => {
  const runsOn = (path: string) =>
    unstable_doesMiddlewareMatch({ config, url: `https://portlandica.example${path}` })

  it('runs on the app and the sign-in page', () => {
    expect(runsOn('/')).toBe(true)
    expect(runsOn('/login')).toBe(true)
  })

  it('skips static assets, so the sign-in page can load them', () => {
    expect(runsOn('/_next/static/chunks/main.js')).toBe(false)
    expect(runsOn('/_next/image?url=%2Flogo.png&w=64&q=75')).toBe(false)
    expect(runsOn('/favicon.ico')).toBe(false)
    expect(runsOn('/logo.png')).toBe(false)
  })

  it('skips only the A.I.P Numbers page, which holds no data', () => {
    expect(runsOn('/aip/index.html')).toBe(false)
    expect(runsOn('/aip')).toBe(true)
    expect(runsOn('/aipx/index.html')).toBe(true)
    expect(runsOn('/api/aip')).toBe(true)
  })
})
