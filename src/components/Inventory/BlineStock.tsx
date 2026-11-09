import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { loadBlineStock } from '@/app/actions/bline'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { BLINE_LOW_STOCK_CANS } from '@/lib/bline'
import type { Batch } from '@/lib/db/types'
import BlineMoveDialog from './BlineMoveDialog'
import {
  BLINE_REASON_LABELS,
  blineHoldings,
  blineLow,
  blineNegative,
  blineRowTitle,
} from './blineRows'
import { formatDay } from './dates'
import { PRODUCT_LABELS } from './stock'
import type { BlineData } from './types'
import { formatCans, formatChange, toCases } from './units'

type Props = {
  /** Every batch, archived ones included, to name what BLine has. */
  batches: Batch[]
  /** Changes when the tab is refreshed, to load BLine's numbers again too. */
  reloadKey: number
}

const LOAD_FAILED = 'Could not load what BLine has. Try again.'

/** What BLine has of our cans: per batch, with warnings, and a way to record changes. */
const BlineStock = ({ batches, reloadKey }: Props) => {
  const [data, setData] = useState<BlineData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    let active = true
    loadBlineStock()
      .then((result) => {
        if (!active) return
        if (isAuthFailure(result)) setError(result.authError)
        else if (!result.ok) setError(result.error)
        else {
          setData({ stock: result.stock, moves: result.moves })
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

  const holdings = data ? blineHoldings(data.stock) : []
  const low = data ? blineLow(data.stock) : []
  const negative = data ? blineNegative(data.stock) : []
  const latest = data?.moves[0] ?? null
  const latestRow = latest && data?.stock.find((row) => row.batch_id === latest.batch_id)
  const latestLine = latest
    ? [
        formatDay(latest.moved_on),
        BLINE_REASON_LABELS[latest.reason],
        `${
          latest.reason === 'count'
            ? `${formatChange(latest.cans)} cans`
            : formatCans(Math.abs(latest.cans))
        } of ${latestRow ? blineRowTitle(latestRow, batches) : `batch ${latest.batch_id}`}`,
        latest.note,
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <Box
      component="section"
      aria-label="At BLine"
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}
    >
      <Box display="flex" alignItems="center" gap={1} mb={1}>
        <Typography variant="subtitle1" component="h3" fontWeight={600} sx={{ flex: 1 }}>
          At BLine
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setUpdating(true)} disabled={!data}>
          Update
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {!data && !error && <CircularProgress size={20} aria-label="Loading what BLine has" />}

      {data && data.stock.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing at BLine yet. Use Update to record the pallets you send.
        </Typography>
      )}
      {data && data.stock.length > 0 && holdings.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          BLine has no cans left.
        </Typography>
      )}
      {holdings.map((row) => (
        <Box key={row.batch_id} mb={0.5}>
          <Box display="flex" justifyContent="space-between" gap={1}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {blineRowTitle(row, batches)}
            </Typography>
            <Typography variant="body2" fontWeight={600} flexShrink={0}>
              {formatCans(row.remaining)} ({toCases(row.remaining)})
            </Typography>
          </Box>
          {row.pending > 0 && (
            <Typography variant="caption" color="text.secondary" component="div">
              Left after booked deliveries. On the shelf today: {formatCans(row.on_hand)}, with{' '}
              {formatCans(row.pending)} still to deliver.
            </Typography>
          )}
        </Box>
      ))}

      {low.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          <AlertTitle>BLine is running low</AlertTitle>
          {low.map(({ product, cans }) => (
            <Box key={product}>
              {PRODUCT_LABELS[product]}: {formatCans(cans)} ({toCases(cans)})
            </Box>
          ))}
          <Box mt={0.5}>Under {formatCans(BLINE_LOW_STOCK_CANS)}. Time to send another pallet.</Box>
        </Alert>
      )}
      {negative.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          <AlertTitle>Below zero at BLine</AlertTitle>
          {negative.map((row) => (
            <Box key={row.batch_id}>
              {blineRowTitle(row, batches)}: {formatCans(row.remaining)}
            </Box>
          ))}
          <Box mt={0.5}>
            More cans went out on BLine orders than were sent. Record what you sent, or BLine&apos;s
            count.
          </Box>
        </Alert>
      )}

      {latestLine && (
        <Typography variant="body2" color="text.secondary" mt={1}>
          Latest: {latestLine}
        </Typography>
      )}

      {updating && data && (
        <BlineMoveDialog
          batches={batches}
          stock={data.stock}
          onClose={() => setUpdating(false)}
          onSaved={(next) => {
            setData(next)
            setUpdating(false)
          }}
          onStale={setData}
        />
      )}
    </Box>
  )
}

export default BlineStock
