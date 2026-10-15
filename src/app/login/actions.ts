'use server'

// Sign-in actions. These live outside src/app/actions on purpose: they must
// work for people who are not signed in yet, so they don't call requireUser().

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAllowlist, isAllowedEmail } from '@/lib/auth/allowlist'

export type LoginState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; message: string }

// Where Supabase sends people back to after they click the email link or
// finish Google sign-in. It has to be listed under Redirect URLs in Supabase
// (see SETUP.md). Server Actions reject cross-origin requests, so the Origin
// header is this site's own address.
const callbackUrl = async () => {
  const requestHeaders = await headers()
  const origin =
    requestHeaders.get('origin') ??
    `${requestHeaders.get('x-forwarded-proto') ?? 'https'}://${requestHeaders.get('host')}`
  return `${origin}/auth/callback`
}

export const sendMagicLink = async (_prev: LoginState, formData: FormData): Promise<LoginState> => {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  if (!email.includes('@')) return { status: 'error', message: 'Enter your email address.' }

  // Only partners are sent a link. Everyone gets the same reply, so this
  // form can't be used to find out who is on the list.
  if (!isAllowedEmail(email, getAllowlist())) return { status: 'sent', email }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: await callbackUrl() },
  })
  if (error) {
    console.error('Magic link failed:', error.message)
    return { status: 'error', message: `Could not send the sign-in email: ${error.message}` }
  }
  return { status: 'sent', email }
}

export const signInWithGoogle = async () => {
  if (process.env.ENABLE_GOOGLE_LOGIN !== 'true') redirect('/login')

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: await callbackUrl(),
      // Let partners with several Google accounts pick the right one.
      queryParams: { prompt: 'select_account' },
    },
  })
  if (error || !data.url) {
    console.error('Google sign-in failed:', error?.message)
    redirect('/login?error=google')
  }
  redirect(data.url)
}

export const signOut = async () => {
  const supabase = await createClient()
  // 'local' signs out this browser only, not the partner's other devices.
  await supabase.auth.signOut({ scope: 'local' })
  redirect('/login')
}
