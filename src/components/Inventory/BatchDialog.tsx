import { Fragment, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'
import { getBatchHistory } from '@/app/actions/batches'
import type { Batch } from '@/lib/db/types'
import ArchiveForm from './ArchiveForm'
import ChangeCountForm from './ChangeCountForm'
import HistoryList, { HISTORY_FAILED, historyStateFrom, type HistoryState } from './HistoryList'
import { formatDay, formatPortlandDay } from './dates'
import { KIND_LABELS, PRODUCT_LABELS, kindOf, productOf } from './stock'
import { formatCans, toCases, toCost, toPallets } from './units'
import { useFullScreenDialog } from './useFullScreenDialog'

type Props = {
  batch: Batch
  /** The customer a custom batch is linked to, if any. */
  customerName: string | null
  onClose: () => void
  /** The batch after a change made here (or found to have changed meanwhile). */
  onSaved: (batch: Batch) => void
}

type Mode = 'view' | 'count' | 'archive'

/** One batch: its details, its history, and the ways to change it. */
const BatchDialog = ({ batch, customerName, onClose, onSaved }: Props) => {
  const fullScreen = useFullScreenDialog()
  const [mode, setMode] = useState<Mode>('view')
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' })
  const [historyVersion, setHistoryVersion] = useState(0)

  useEffect(() => {
    let active = true
    getBatchHistory(batch.id)
      .then((result) => {
        if (active) setHistory(historyStateFrom(result))
      })
      .catch(() => {
        if (active) setHistory({ status: 'error', message: HISTORY_FAILED })
      })
    return () => {
      active = false
    }
  }, [batch.id, historyVersion])

  const reloadHistory = () => {
    setHistory({ status: 'loading' })
    setHistoryVersion((version) => version + 1)
  }

  const saved = (updated: Batch) => {
    onSaved(updated)
    setMode('view')
    reloadHistory()
  }

  const stale = (current: Batch) => {
    onSaved(current)
    reloadHistory()
  }

  const archived = batch.archived_at !== null
  const negative = batch.count < 0
  // Facts without a value are left out.
  const facts: [string, string | null][] = [
    ['Customer', batch.isCustom ? (customerName ?? 'Not linked to a customer') : null],
    ['Filled', formatDay(batch.fillDate) ?? 'No fill date'],
    ['Source', batch.source],
    ['Cost', toCost(batch.totalCost)],
    ['Invoice', batch.invoiceNumber],
    ['Archived', formatPortlandDay(batch.archived_at)],
  ]

  return (
    <Dialog
      open
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="batch-dialog-title"
    >
      <DialogTitle id="batch-dialog-title" sx={{ pb: 1, overflowWrap: 'anywhere' }}>
        {batch.name}
        <Typography component="span" variant="body2" color="text.secondary" display="block">
          {PRODUCT_LABELS[productOf(batch)]} · {KIND_LABELS[kindOf(batch)]}
          {archived ? ' · Archived' : ''}
        </Typography>
      </DialogTitle>

      {mode === 'view' && (
        <>
          <DialogContent dividers>
            <Box display="flex" alignItems="baseline" columnGap={1} flexWrap="wrap">
              <Typography
                variant="h5"
                component="p"
                fontWeight={600}
                color={negative ? 'error' : undefined}
              >
                {formatCans(batch.count)}
              </Typography>
              <Typography color="text.secondary">
                {toCases(batch.count)} · {toPallets(batch.count)}
              </Typography>
              {negative && <Chip size="small" color="error" label="Below zero" />}
            </Box>
            <Box
              component="dl"
              sx={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: 2,
                rowGap: 0.5,
                my: 2,
                '& dt': { color: 'text.secondary' },
                '& dd': { m: 0, overflowWrap: 'anywhere' },
              }}
            >
              {facts
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
            </Box>
            <Box display="flex" gap={1} flexWrap="wrap" mb={3}>
              {!archived && (
                <Button variant="contained" onClick={() => setMode('count')}>
                  Change count
                </Button>
              )}
              <Button
                variant="outlined"
                color={archived ? 'primary' : 'warning'}
                onClick={() => setMode('archive')}
              >
                {archived ? 'Unarchive' : 'Archive'}
              </Button>
            </Box>
            <Typography variant="subtitle1" component="h3" fontWeight={600}>
              History
            </Typography>
            <HistoryList state={history} />
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
          </DialogActions>
        </>
      )}
      {mode === 'count' && (
        <ChangeCountForm
          batch={batch}
          onCancel={() => setMode('view')}
          onSaved={saved}
          onStale={stale}
        />
      )}
      {mode === 'archive' && (
        <ArchiveForm
          batch={batch}
          onCancel={() => setMode('view')}
          onSaved={saved}
          onStale={stale}
        />
      )}
    </Dialog>
  )
}

export default BatchDialog
