import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * The app's Supabase client. Server-only: it uses the secret key, so every request runs as
 * the service role, which the database functions trust and which skips row level
 * security. That is why every server action checks the team session with requireUser()
 * before it calls this.
 *
 * SUPABASE_SECRET_KEY has no NEXT_PUBLIC_ prefix, so Next.js never puts it in the browser
 * bundle. There is no browser Supabase client; keep it that way.
 */
export const createClient = async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set. See SETUP.md.')
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set. See SETUP.md.')
  if (secretKey.startsWith('sb_publishable_')) {
    throw new Error(
      'SUPABASE_SECRET_KEY holds the publishable key. Use a secret key. See SETUP.md.'
    )
  }

  return createSupabaseClient(url, secretKey, {
    // No user session: nothing to store, refresh or read from the URL.
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}
