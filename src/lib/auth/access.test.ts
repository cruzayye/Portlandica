import { describe, it, expect } from 'vitest'
import { decideAccess, isPublicPath, type AccessRequest } from './access'

const allowlist = ['partner@example.com']
const partner = { email: 'partner@example.com' }
const stranger = { email: 'stranger@example.com' }

const decide = (over: Partial<AccessRequest>) =>
  decideAccess({ pathname: '/', isServerAction: false, user: null, allowlist, ...over })

describe('decideAccess', () => {
  it('sends a signed-out visitor to /login', () => {
    expect(decide({ pathname: '/' })).toEqual({ allow: false, redirectTo: '/login' })
  })

  it('sends a signed-out visitor to /login from any private path', () => {
    expect(decide({ pathname: '/inventory' })).toEqual({ allow: false, redirectTo: '/login' })
  })

  it('lets a partner use the app', () => {
    expect(decide({ pathname: '/', user: partner })).toEqual({ allow: true })
  })

  it('matches the partner email regardless of case', () => {
    expect(decide({ user: { email: 'Partner@Example.com' } })).toEqual({ allow: true })
  })

  it('sends a signed-in non-partner to /login with an explanation', () => {
    expect(decide({ user: stranger })).toEqual({
      allow: false,
      redirectTo: '/login?error=not_allowed',
    })
  })

  it('treats a session without an email as a non-partner', () => {
    expect(decide({ user: {} })).toEqual({ allow: false, redirectTo: '/login?error=not_allowed' })
  })

  it('lets nobody in when the allowlist is empty', () => {
    expect(decide({ user: partner, allowlist: [] })).toEqual({
      allow: false,
      redirectTo: '/login?error=not_allowed',
    })
  })

  it('always shows the sign-in page and callback to people who are not partners', () => {
    expect(decide({ pathname: '/login' })).toEqual({ allow: true })
    expect(decide({ pathname: '/login', user: stranger })).toEqual({ allow: true })
    expect(decide({ pathname: '/auth/callback' })).toEqual({ allow: true })
  })

  it('sends a partner who opens /login straight to the app', () => {
    expect(decide({ pathname: '/login', user: partner })).toEqual({ allow: false, redirectTo: '/' })
  })

  it('lets a partner finish the callback', () => {
    expect(decide({ pathname: '/auth/callback', user: partner })).toEqual({ allow: true })
  })

  it('lets Server Action calls through so the action can return its own error', () => {
    expect(decide({ pathname: '/', isServerAction: true })).toEqual({ allow: true })
    expect(decide({ pathname: '/', isServerAction: true, user: stranger })).toEqual({ allow: true })
  })
})

describe('isPublicPath', () => {
  it('covers only the sign-in page and the /auth routes', () => {
    expect(isPublicPath('/login')).toBe(true)
    expect(isPublicPath('/auth/callback')).toBe(true)
    expect(isPublicPath('/')).toBe(false)
  })

  it('does not open paths that merely start with the same letters', () => {
    expect(isPublicPath('/login-admin')).toBe(false)
    expect(isPublicPath('/loginx')).toBe(false)
    expect(isPublicPath('/authors')).toBe(false)
    expect(isPublicPath('/auth')).toBe(false)
  })
})
