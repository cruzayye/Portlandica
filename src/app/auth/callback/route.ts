import { NextResponse, type NextRequest } from 'next/server'
import { isAuthPKCECodeVerifierMissingError, type EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getAllowlist, isAllowedEmail } from '@/lib/auth/allowlist'

const redirectTo = (request: NextRequest, path: string) =>
  NextResponse.redirect(new URL(path, request.url))

/**
 * Where the email sign-in link and Google sign-in land. Supabase sends one of:
 * - ?code=...  (Google, and the default magic-link email). The code can only
 *   be exchanged in the browser that asked for the link.
 * - ?token_hash=...&type=email  (the optional email template in SETUP.md),
 *   which works in any browser.
 */
export const GET = async (request: NextRequest) => {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  if (!code && !(tokenHash && type)) return redirectTo(request, '/login?error=link')

  const supabase = await createClient()
  const { data, error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! })

  if (error || !data.user) {
    console.error('Sign-in callback failed:', error?.message)
    const reason = isAuthPKCECodeVerifierMissingError(error) ? 'other_browser' : 'link'
    return redirectTo(request, `/login?error=${reason}`)
  }

  // Signed in, but not a partner (for example a Google account that isn't on
  // the list): end that session straight away.
  if (!isAllowedEmail(data.user.email, getAllowlist())) {
    await supabase.auth.signOut({ scope: 'local' })
    return redirectTo(request, '/login?error=not_allowed')
  }

  return redirectTo(request, '/')
}
