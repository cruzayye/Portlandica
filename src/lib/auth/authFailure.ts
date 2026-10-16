// Safe to import from client components (no server-only imports here).

/**
 * What a server action returns instead of its result when the caller isn't signed in with
 * the team password. It is returned, not thrown, because production builds replace thrown
 * messages with a generic one and this message is meant to be shown to the person using
 * the app.
 */
export type AuthFailure = { authError: string }

export const isAuthFailure = (value: unknown): value is AuthFailure =>
  typeof value === 'object' && value !== null && 'authError' in value

export const SIGNED_OUT = 'You are signed out. Reload the page to sign in again.'
export const SIGN_IN_NOT_SET_UP =
  'Sign-in is not set up on this site yet: the team password settings on the server are missing or too short. See SETUP.md.'
export const WRONG_PASSWORD = 'That is not the team password. Try again.'
