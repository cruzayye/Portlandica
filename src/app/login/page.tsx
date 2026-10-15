import type { Metadata } from 'next'
import Box from '@mui/material/Box'
import { getAllowlist } from '@/lib/auth/allowlist'
import LoginForm from './LoginForm'

export const metadata: Metadata = {
  title: 'Sign in',
}

// Messages for the ?error= values that /auth/callback and the proxy redirect with.
const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: 'That account is not on the partner list. Sign in with your partner email.',
  link: 'That sign-in link did not work. Links can only be used once and expire after an hour. Request a new one below.',
  other_browser:
    'Open the sign-in link in the same browser you requested it from. Request a new link below, then open it on this device.',
  google: 'Google sign-in did not start. Try the email link instead.',
}

type LoginPageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

const LoginPage = async ({ searchParams }: LoginPageProps) => {
  const { error } = await searchParams
  const errorMessage = typeof error === 'string' ? (ERROR_MESSAGES[error] ?? null) : null

  return (
    <Box
      component="main"
      sx={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', p: { xs: 2, sm: 4 } }}
    >
      <LoginForm
        errorMessage={errorMessage}
        googleEnabled={process.env.ENABLE_GOOGLE_LOGIN === 'true'}
        allowlistMissing={getAllowlist().length === 0}
      />
    </Box>
  )
}

export default LoginPage
