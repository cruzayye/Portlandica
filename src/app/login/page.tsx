import type { Metadata } from 'next'
import { connection } from 'next/server'
import Box from '@mui/material/Box'
import { getAuthConfig } from '@/lib/auth/config'
import LoginForm from './LoginForm'

export const metadata: Metadata = {
  title: 'Sign in',
}

const LoginPage = async () => {
  // Check the settings when the page is requested, not once when the site is built.
  await connection()
  const notSetUp = !getAuthConfig().ok

  return (
    <Box
      component="main"
      sx={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', p: { xs: 2, sm: 4 } }}
    >
      <LoginForm notSetUp={notSetUp} />
    </Box>
  )
}

export default LoginPage
