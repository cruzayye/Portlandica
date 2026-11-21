import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { loadBlineDeliveries } from '@/app/actions/blineTracking'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { formatDeliveredAt } from '@/lib/findelivers'
import BlineImportDialog from './BlineImportDialog'
import { monthLine, waitingSummary, waitingTitle } from './blineDeliveryRows'
import { portlandToday } from './dates'
import type { BlineDeliveries as Deliveries } from './types'

type Props = {
  /** Changes when the tab is refreshed or BLine's numbers change, to load these again too. */
  reloadKey: number
  /** A findelivers import recorded deliveries: what BLine has on its shelf may have changed. */
  onImported: () => void
}

const LOAD_FAILED = "Could not load BLine's deliveries. Try again."

/** BLine orders still to deliver, findelivers imports, and BLine's fees by month. */
const BlineDeliveries = ({ reloadKey, onImported }: Props) => {
  const [data, setData] = useState<Deliveries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    let active = true
    loadBlineDeliveries()
      .then((result) => {
        if (!active) return
        if (isAuthFailure(result)) setError(result.authError)
        else if (!result.ok) setError(result.error)
        else {
          setData({ waiting: result.waiting, lastImport: result.lastImport, months: result.months })
          setError(null)
        }
      })
      .catch(() => {
        if (active) setError(LOAD_FAILED)
      })
    return () => {
      active = false
    }
  }, [reloadKey])

  const today = portlandToday()

  return (
    <Box
      component="section"
      aria-label="BLine deliveries"
      mt={2}
      pt={1.5}
      borderTop={1}
      borderColor="divider"
    >
      <Box display="flex" alignItems="center" gap={1} mb={1}>
        <Typography variant="subtitle2" component="h4" sx={{ flex: 1 }}>
          Deliveries
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setImporting(true)}>
          Import findelivers
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {!data && !error && <CircularProgress size={20} aria-label="Loading BLine's deliveries" />}

      {data && data.waiting.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing waiting on BLine.
        </Typography>
      )}
      {data && data.waiting.length > 0 && (
        <Typography variant="body2" fontWeight={600}>
          To deliver ({data.waiting.length})
        </Typography>
      )}
      {data?.waiting.map((order) => {
        const summary = waitingSummary(order, data.lastImport, today)
        return (
          <Box key={order.id} mb={0.5}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {waitingTitle(order)}
            </Typography>
            <Typography
              variant="caption"
              component="div"
              color={summary.warn ? 'warning.main' : 'text.secondary'}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {summary.text}
            </Typography>
          </Box>
        )
      })}

      {data && (
        <Typography variant="body2" color="text.secondary" mt={1}>
          {data.lastImport
            ? `Last findelivers import: ${formatDeliveredAt(data.lastImport)}`
            : 'No findelivers import yet. Download the Orders CSV in findelivers, then Import.'}
        </Typography>
      )}
      {data?.months.map((month) => (
        <Typography key={month.month} variant="body2" color="text.secondary">
          {monthLine(month)}
        </Typography>
      ))}

      {importing && <BlineImportDialog onClose={() => setImporting(false)} onSaved={onImported} />}
    </Box>
  )
}

export default BlineDeliveries
