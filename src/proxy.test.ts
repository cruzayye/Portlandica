// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

type CookieMethods = {
  setAll: (cookies: { name: string; value: string; options: object }[]) => void
}

// Fake Supabase client: getClaims() returns whatever `claims` holds, and can
// simulate a session refresh by writing new cookies through setAll().
const supabase = vi.hoisted(() => ({
  claims: null as { email?: string } | null,
  refreshedCookies: [] as { name: string; value: string; options: object }[],
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, { cookies }: { cookies: CookieMethods }) => ({
    auth: {
      getClaims: async () => {
        if (supabase.refreshedCookies.length) cookies.setAll(supabase.refreshedCookies)
        return supabase.claims
          ? { data: { claims: supabase.claims }, error: null }
          : { data: null, error: null }
      },
    },
  }),
}))

import { proxy } from './proxy'

const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(path, 'https://portlandica.example'), init)

const location = (response: Response) => response.headers.get('location')

describe('proxy', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOWED_EMAILS', 'partner@example.com')
    supabase.claims = null
    supabase.refreshedCookies = []
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('redirects a signed-out page load to /login', async () => {
    const response = await proxy(request('/'))
    expect(response.status).toBe(307)
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('lets a signed-in partner through', async () => {
    supabase.claims = { email: 'partner@example.com' }
    const response = await proxy(request('/'))
    expect(location(response)).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('redirects a signed-in non-partner to /login with an explanation', async () => {
    supabase.claims = { email: 'stranger@example.com' }
    const response = await proxy(request('/'))
    expect(location(response)).toBe('https://portlandica.example/login?error=not_allowed')
  })

  it('shows /login to signed-out visitors', async () => {
    const response = await proxy(request('/login'))
    expect(location(response)).toBeNull()
  })

  it('lets a signed-out Server Action call reach the action', async () => {
    const response = await proxy(
      request('/', { method: 'POST', headers: { 'next-action': 'abc123' } })
    )
    expect(location(response)).toBeNull()
  })

  it('does not treat a plain POST as a Server Action call', async () => {
    const response = await proxy(request('/', { method: 'POST' }))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('does not let a page load through just because it sends the action header', async () => {
    const response = await proxy(request('/', { headers: { 'next-action': 'abc123' } }))
    expect(location(response)).toBe('https://portlandica.example/login')
  })

  it('keeps refreshed session cookies when it redirects', async () => {
    supabase.claims = { email: 'partner@example.com' }
    supabase.refreshedCookies = [{ name: 'sb-test-auth-token', value: 'fresh', options: { path: '/' } }]
    const response = await proxy(request('/login'))
    expect(location(response)).toBe('https://portlandica.example/')
    expect(response.headers.get('set-cookie')).toContain('sb-test-auth-token=fresh')
  })

  it('keeps refreshed session cookies when it lets the request through', async () => {
    supabase.claims = { email: 'partner@example.com' }
    supabase.refreshedCookies = [{ name: 'sb-test-auth-token', value: 'fresh', options: { path: '/' } }]
    const response = await proxy(request('/'))
    expect(response.headers.get('set-cookie')).toContain('sb-test-auth-token=fresh')
  })
})
