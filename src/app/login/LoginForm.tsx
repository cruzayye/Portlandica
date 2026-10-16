'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { SIGN_IN_NOT_SET_UP } from '@/lib/auth/authFailure'
import { signIn, type SignInState } from './actions'

type LoginFormProps = {
  /** The server's TEAM_PASSWORD or SESSION_SECRET is missing or too short. */
  notSetUp: boolean
}

const initialState: SignInState = { status: 'idle' }

// Must render inside the <form> so useFormStatus can see it submitting.
const SubmitButton = ({ disabled }: { disabled: boolean }) => {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="contained" size="large" fullWidth disabled={disabled || pending}>
      {pending ? 'Signing in...' : 'Sign in'}
    </Button>
  )
}

const LoginForm = ({ notSetUp }: LoginFormProps) => {
  const [state, formAction] = useActionState(signIn, initialState)

  return (
    <Paper
      elevation={2}
      sx={{
        p: { xs: 3, sm: 4 },
        width: '100%',
        maxWidth: 400,
        alignSelf: 'flex-start',
        mt: { xs: 4, sm: 10 },
      }}
    >
      <Typography variant="h5" fontWeight={600}>
        Portlandica
      </Typography>
      <Typography color="text.secondary" mb={3}>
        Team sign-in
      </Typography>

      {notSetUp && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {SIGN_IN_NOT_SET_UP}
        </Alert>
      )}

      <Box component="form" action={formAction} display="flex" flexDirection="column" gap={2}>
        <TextField
          label="Team password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          fullWidth
          autoFocus
          disabled={notSetUp}
          slotProps={{
            htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false },
          }}
        />
        {state.status === 'error' && <Alert severity="error">{state.message}</Alert>}
        <SubmitButton disabled={notSetUp} />
      </Box>
    </Paper>
  )
}

export default LoginForm
