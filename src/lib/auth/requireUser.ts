import { isAuthRetryableFetchError, type User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getAllowlist, isAllowedEmail } from './allowlist'

/**
 * What a server action returns instead of its result when the caller isn't a
 * signed-in partner. It is returned, not thrown, because production builds
 * replace thrown messages with a generic one and this message is meant to be
 * shown to the person using the app.
 */
export type AuthFailure = { authError: string }

export const isAuthFailure = (value: unknown): value is AuthFailure =>
  typeof value === 'object' && value !== null && 'authError' in value

export const SIGNED_OUT = 'You are signed out. Reload the page to sign in again.'
export const NOT_A_PARTNER = 'This account is not on the partner list.'
export const AUTH_UNAVAILABLE = 'Could not check your sign-in just now. Please try again.'

/**
 * Call this first in every server action. Server actions can be called
 * directly over HTTP, so each one checks the caller itself; the redirect in
 * src/proxy.ts only covers page loads.
 *
 * getUser() asks Supabase Auth to validate the session on every call, so a
 * deleted user stops working straight away.
 */
export const requireUser = async (): Promise<
  { user: User; failure: null } | { user: null; failure: AuthFailure }
> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (!data.user) {
    const authError = isAuthRetryableFetchError(error) ? AUTH_UNAVAILABLE : SIGNED_OUT
    return { user: null, failure: { authError } }
  }
  if (!isAllowedEmail(data.user.email, getAllowlist())) {
    return { user: null, failure: { authError: NOT_A_PARTNER } }
  }
  return { user: data.user, failure: null }
}
