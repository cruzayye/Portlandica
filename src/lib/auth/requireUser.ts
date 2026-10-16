import { cookies } from 'next/headers'
import { getAuthConfig } from './config'
import { SESSION_COOKIE, verifySessionToken } from './session'
import { SIGNED_OUT, SIGN_IN_NOT_SET_UP, type AuthFailure } from './authFailure'

export type { AuthFailure } from './authFailure'

/**
 * Call this first in every server action:
 *
 *   const { failure } = await requireUser()
 *   if (failure) return failure
 *
 * Server actions can be called directly over HTTP, so each one checks the team session
 * cookie itself; the redirect in src/proxy.ts only covers page loads. The check needs no
 * network call: the cookie is valid when it is signed with SESSION_SECRET, hasn't expired
 * and was made with the current TEAM_PASSWORD.
 */
export const requireUser = async (): Promise<{ failure: AuthFailure | null }> => {
  const auth = getAuthConfig()
  if (!auth.ok) return { failure: { authError: SIGN_IN_NOT_SET_UP } }

  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!verifySessionToken(token, auth.config)) return { failure: { authError: SIGNED_OUT } }
  return { failure: null }
}
