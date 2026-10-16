import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import Typography from '@mui/material/Typography'
import { isAuthFailure, type AuthFailure } from '@/lib/auth/authFailure'
import { formatMoment } from './dates'
import { CHANGED_BY_LABELS, orderLabel, reasonLabel } from './history'
import type { HistoryEntry, HistoryResult } from './types'
import { formatChange, formatNumber } from './units'

export type HistoryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: HistoryEntry[] }

export const HISTORY_FAILED = 'Could not load the history. Try again.'

export const historyStateFrom = (result: HistoryResult | AuthFailure): HistoryState =>
  isAuthFailure(result)
    ? { status: 'error', message: result.authError }
    : result.ok
      ? { status: 'ready', entries: result.entries }
      : { status: 'error', message: result.error }

/** A batch's history, newest first. */
const HistoryList = ({ state }: { state: HistoryState }) => {
  if (state.status === 'loading') {
    return (
      <Box display="flex" justifyContent="center" py={2}>
        <CircularProgress size={24} aria-label="Loading history" />
      </Box>
    )
  }
  if (state.status === 'error') return <Alert severity="error">{state.message}</Alert>
  if (state.entries.length === 0) {
    return <Typography color="text.secondary">No history yet.</Typography>
  }

  return (
    <List disablePadding aria-label="History">
      {state.entries.map((entry) => (
        <ListItem key={entry.id} divider disableGutters sx={{ display: 'block' }}>
          <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={1}>
            <Typography variant="body2" fontWeight={600}>
              {reasonLabel(entry)}
            </Typography>
            <Typography
              variant="body2"
              fontWeight={600}
              color={entry.change > 0 ? 'success.dark' : 'text.primary'}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {formatChange(entry.change)} cans
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" component="p">
            {formatMoment(entry.at)} · {CHANGED_BY_LABELS[entry.by]} · count after{' '}
            {formatNumber(entry.balance)}
          </Typography>
          {entry.order && <Typography variant="body2">{orderLabel(entry.order)}</Typography>}
          {entry.note && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {entry.note}
            </Typography>
          )}
        </ListItem>
      ))}
    </List>
  )
}

export default HistoryList
