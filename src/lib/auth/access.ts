/** The only page anyone may open without a session: the sign-in page. */
export const isPublicPath = (pathname: string) => pathname === '/login'

export type AccessRequest = {
  pathname: string
  /** A Server Action call: a POST with the Next-Action header. */
  isServerAction: boolean
  /** The request carries a valid team session cookie. */
  signedIn: boolean
}

export type AccessDecision = { allow: true } | { allow: false; redirectTo: string }

/**
 * The redirect rule src/proxy.ts applies to every request:
 * - no valid session: go to /login
 * - signed in and opening /login: go straight to the app
 *
 * Server Action calls are let through. The browser can't follow a redirect from one (the
 * call just fails with a generic error), and every action checks the session itself with
 * requireUser() and returns a clear message. The sign-in action is one of them.
 */
export const decideAccess = ({
  pathname,
  isServerAction,
  signedIn,
}: AccessRequest): AccessDecision => {
  if (isServerAction) return { allow: true }
  if (isPublicPath(pathname)) return signedIn ? { allow: false, redirectTo: '/' } : { allow: true }
  return signedIn ? { allow: true } : { allow: false, redirectTo: '/login' }
}
