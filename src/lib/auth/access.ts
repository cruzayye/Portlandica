import { isAllowedEmail } from './allowlist'

/** Pages anyone may open: the sign-in page and the sign-in link callback. */
export const isPublicPath = (pathname: string) =>
  pathname === '/login' || pathname.startsWith('/auth/')

export type AccessRequest = {
  pathname: string
  /** A Server Action call: a POST with the Next-Action header. */
  isServerAction: boolean
  /** The user from the verified session, or null when signed out. */
  user: { email?: string | null } | null
  allowlist: string[]
}

export type AccessDecision = { allow: true } | { allow: false; redirectTo: string }

/**
 * The redirect rule src/proxy.ts applies to every request:
 * - signed out: go to /login
 * - signed in but not on the partner list: go to /login with an explanation
 * - a partner opening /login: go straight to the app
 *
 * Server Action calls are let through. The browser can't follow a redirect
 * from one (the call just fails with a generic error), and every action
 * checks the caller itself with requireUser() and returns a clear message.
 */
export const decideAccess = ({
  pathname,
  isServerAction,
  user,
  allowlist,
}: AccessRequest): AccessDecision => {
  const isPartner = isAllowedEmail(user?.email, allowlist)

  if (isPublicPath(pathname)) {
    return isPartner && pathname === '/login' ? { allow: false, redirectTo: '/' } : { allow: true }
  }
  if (isPartner || isServerAction) return { allow: true }
  return { allow: false, redirectTo: user ? '/login?error=not_allowed' : '/login' }
}
