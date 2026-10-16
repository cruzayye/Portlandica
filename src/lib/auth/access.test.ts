import { describe, it, expect } from 'vitest'
import { decideAccess, isPublicPath, type AccessRequest } from './access'

const decide = (over: Partial<AccessRequest>) =>
  decideAccess({ pathname: '/', isServerAction: false, signedIn: false, ...over })

describe('decideAccess', () => {
  it('sends a visitor without a session to /login', () => {
    expect(decide({ pathname: '/' })).toEqual({ allow: false, redirectTo: '/login' })
    expect(decide({ pathname: '/inventory' })).toEqual({ allow: false, redirectTo: '/login' })
  })

  it('lets a signed-in device use the app', () => {
    expect(decide({ pathname: '/', signedIn: true })).toEqual({ allow: true })
  })

  it('always shows the sign-in page to visitors without a session', () => {
    expect(decide({ pathname: '/login' })).toEqual({ allow: true })
  })

  it('sends a signed-in device that opens /login straight to the app', () => {
    expect(decide({ pathname: '/login', signedIn: true })).toEqual({
      allow: false,
      redirectTo: '/',
    })
  })

  it('lets Server Action calls through so the action can return its own message', () => {
    expect(decide({ pathname: '/', isServerAction: true })).toEqual({ allow: true })
    expect(decide({ pathname: '/login', isServerAction: true })).toEqual({ allow: true })
    expect(decide({ pathname: '/login', isServerAction: true, signedIn: true })).toEqual({
      allow: true,
    })
  })
})

describe('isPublicPath', () => {
  it('covers only the sign-in page', () => {
    expect(isPublicPath('/login')).toBe(true)
    expect(isPublicPath('/')).toBe(false)
  })

  it('no longer opens the old sign-in link callback', () => {
    expect(isPublicPath('/auth/callback')).toBe(false)
  })

  it('does not open paths that merely start with the same letters', () => {
    expect(isPublicPath('/login-admin')).toBe(false)
    expect(isPublicPath('/loginx')).toBe(false)
    expect(isPublicPath('/login/')).toBe(false)
  })
})
