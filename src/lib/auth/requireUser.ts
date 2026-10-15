import { isAuthRetryableFetchError, type User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getAllowlist, isAllowedEmail } from './allowlist'
import { AUTH_UNAVAILABLE, NOT_A_PARTNER, SIGNED_OUT, type AuthFailure } from './authFailure'

export type { AuthFailure } from './authFailure'

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
