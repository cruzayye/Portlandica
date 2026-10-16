'use server'

// Sign-in and sign-out. These live outside src/app/actions on purpose: signIn has to work
// before anyone is signed in, so it doesn't call requireUser().

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SIGN_IN_NOT_SET_UP, WRONG_PASSWORD } from '@/lib/auth/authFailure'
import { getAuthConfig } from '@/lib/auth/config'
import {
  SESSION_COOKIE,
  WRONG_PASSWORD_DELAY_MS,
  createSessionToken,
  passwordMatches,
  sessionCookieOptions,
} from '@/lib/auth/session'

export type SignInState = { status: 'idle' } | { status: 'error'; message: string }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const signIn = async (_previous: SignInState, formData: FormData): Promise<SignInState> => {
  const auth = getAuthConfig()
  if (!auth.ok) return { status: 'error', message: SIGN_IN_NOT_SET_UP }

  const input = formData.get('password')
  if (typeof input !== 'string' || !passwordMatches(input, auth.config.password)) {
    // Every wrong guess waits, which slows down anyone trying passwords one after another.
    await pause(WRONG_PASSWORD_DELAY_MS)
    return { status: 'error', message: WRONG_PASSWORD }
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, createSessionToken(auth.config), sessionCookieOptions())
  redirect('/')
}

/** Signs this device out. Other devices stay signed in. */
export const signOut = async () => {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 })
  redirect('/login')
}
