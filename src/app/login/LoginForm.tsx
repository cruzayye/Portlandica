'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { sendMagicLink, signInWithGoogle, type LoginState } from './actions'

type LoginFormProps = {
  errorMessage: string | null
  googleEnabled: boolean
  allowlistMissing: boolean
}

type SubmitButtonProps = {
  label: string
  pendingLabel: string
  variant: 'contained' | 'outlined'
}

const initialState: LoginState = { status: 'idle' }

// Must render inside the <form> so useFormStatus can see it submitting.
const SubmitButton = ({ label, pendingLabel, variant }: SubmitButtonProps) => {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant={variant} size="large" fullWidth disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  )
}

const LoginForm = ({ errorMessage, googleEnabled, allowlistMissing }: LoginFormProps) => {
  const [email, setEmail] = useState('')
  const [state, formAction] = useActionState(sendMagicLink, initialState)

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
        Partner sign-in
      </Typography>

      {allowlistMissing && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Sign-in is not set up yet: ALLOWED_EMAILS is empty.
        </Alert>
      )}
      {errorMessage && state.status === 'idle' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}
      {state.status === 'sent' && (
        <Alert severity="success" sx={{ mb: 2 }}>
          If {state.email} is on the partner list, a sign-in link is on its way. Open it in this
          browser. Check spam if it hasn&apos;t arrived in a few minutes.
        </Alert>
      )}

      <Box component="form" action={formAction} display="flex" flexDirection="column" gap={2}>
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          fullWidth
          autoFocus
        />
        {state.status === 'error' && <Alert severity="error">{state.message}</Alert>}
        <SubmitButton
          label="Email me a sign-in link"
          pendingLabel="Sending..."
          variant="contained"
        />
      </Box>

      {googleEnabled && (
        <>
          <Divider sx={{ my: 3 }}>or</Divider>
          <form action={signInWithGoogle}>
            <SubmitButton
              label="Continue with Google"
              pendingLabel="Opening Google..."
              variant="outlined"
            />
          </form>
        </>
      )}
    </Paper>
  )
}

export default LoginForm
