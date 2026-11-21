'use client'

import { useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { clearOrderDelivery, markOrderDelivered } from '@/app/actions/blineTracking'
import { isAuthFailure } from '@/lib/auth/authFailure'
import type { SalesOrderWithLines } from '@/lib/db/types'
import { trackingSummary } from '@/lib/findelivers'

type Props = {
  order: SalesOrderWithLines
  onChange: (order: SalesOrderWithLines) => void
}

/** A BLine order's delivery, from findelivers or marked by hand, and a way to mark or clear it. */
const BlineDelivery = ({ order, onChange }: Props) => {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, startBusy] = useTransition()

  const delivered = Boolean(order.delivered_at)
  // Older code paths and a database without the tracking change leave these out.
  const summary = trackingSummary({
    deliveredAt: order.delivered_at ?? null,
    blineRef: order.bline_ref ?? null,
    blineStatus: order.bline_status ?? null,
    blineProblem: order.bline_problem ?? null,
  })

  const confirm = () => {
    startBusy(async () => {
      try {
        const result = delivered
          ? await clearOrderDelivery(order.id)
          : await markOrderDelivered(order.id)
        if (isAuthFailure(result)) setError(result.authError)
        else if (result.status === 'failed') setError(result.message)
        else {
          setError(null)
          setWarnings(result.warnings)
          setConfirming(false)
          onChange(result.order)
        }
      } catch {
        setError("Couldn't reach the server. Reload to see if it changed.")
      }
    })
  }

  return (
    <Box>
      <Box display="flex" alignItems="center" gap={1}>
        <Typography
          variant="body2"
          color={summary.warn ? 'warning.main' : delivered ? 'success.main' : 'text.secondary'}
          sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {summary.text}
        </Typography>
        <Button
          size="small"
          sx={{ flexShrink: 0 }}
          onClick={() => {
            setError(null)
            setConfirming(true)
          }}
        >
          {delivered ? 'Clear' : 'Mark delivered'}
        </Button>
      </Box>
      {!confirming && error && (
        <Alert severity="error" sx={{ mt: 0.5 }}>
          {error}
        </Alert>
      )}
      {warnings.map((warning) => (
        <Alert key={warning} severity="warning" sx={{ mt: 0.5 }}>
          {warning}
        </Alert>
      ))}

      <Dialog open={confirming} onClose={() => setConfirming(false)} fullWidth>
        <DialogTitle>
          {delivered ? `Clear #${order.id}'s delivery?` : `Mark #${order.id} delivered?`}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {delivered
              ? 'It counts as not delivered again, and its Trello card is unchecked. What findelivers said about it is forgotten: the next import matches it again.'
              : 'As of now, and its Trello card is checked off. A findelivers import later fills in when BLine delivered it.'}
          </Typography>
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="contained" onClick={confirm} disabled={busy}>
            {busy ? 'Saving...' : delivered ? 'Clear' : 'Mark delivered'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default BlineDelivery
