import { useState, useTransition, type ChangeEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { readFindeliversFile, saveFindeliversFile } from '@/app/actions/blineTracking'
import { isAuthFailure } from '@/lib/auth/authFailure'
import {
  MAX_FILE_CHARS,
  alreadyRecorded,
  blineStatusLabel,
  formatDeliveredAt,
  notInFile,
  type FileOrder,
  type FindeliversRow,
} from '@/lib/findelivers'
import { shortDay, waitingTitle } from './blineDeliveryRows'
import type { FindeliversReadResult, FindeliversSaveResult } from './types'
import { useFullScreenDialog } from './useFullScreenDialog'

type Props = {
  onClose: () => void
  /** Rows were recorded: what BLine has and its deliveries may have changed. */
  onSaved: () => void
}

type Read = Extract<FindeliversReadResult, { ok: true }>
type Saved = Extract<FindeliversSaveResult, { ok: true }>

const READ_FAILED = 'Could not read that file. Try again.'
const SAVE_FAILED = 'Could not save. Saving again is safe.'

/** "Delivered Nov 20, 9:51 AM", "Failed attempt (Refused by recipient)", "Unassigned". */
const rowStatus = (row: FindeliversRow) =>
  row.status === 'delivered'
    ? `Delivered${row.deliveredAt ? ` ${formatDeliveredAt(row.deliveredAt)}` : ''}`
    : `${blineStatusLabel(row.status)}${row.problem ? ` (${row.problem})` : ''}`

const orderLabel = (order: FileOrder, ref: string) =>
  [
    `#${order.id} ${order.customerName}`,
    shortDay(order.orderDate),
    `${order.totalCans.toLocaleString('en-US')} cans`,
    order.blineRef && order.blineRef !== ref ? `matched to ${order.blineRef}` : null,
    order.deliveredAt && order.blineStatus !== 'delivered' ? 'marked delivered' : null,
  ]
    .filter(Boolean)
    .join(' · ')

const savedLine = (saved: Saved) =>
  [
    `Recorded ${saved.recorded} ${saved.recorded === 1 ? 'row' : 'rows'}.`,
    saved.delivered
      ? `${saved.delivered} newly delivered; ${saved.checkedOff} Trello ${saved.checkedOff === 1 ? 'card' : 'cards'} checked off.`
      : 'No new deliveries.',
  ].join(' ')

/** Read findelivers' Orders CSV, check which order each delivery goes with, and record them. */
const BlineImportDialog = ({ onClose, onSaved }: Props) => {
  const fullScreen = useFullScreenDialog()
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [picks, setPicks] = useState<Record<string, number | ''>>({})
  const [saved, setSaved] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, startBusy] = useTransition()

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    // So choosing the same file again reads it again.
    event.target.value = ''
    if (!picked) return
    if (picked.size > MAX_FILE_CHARS) {
      setError('That file is too big for an Orders CSV. Download a shorter date range.')
      return
    }
    startBusy(async () => {
      try {
        const csv = await picked.text()
        const result = await readFindeliversFile(csv)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (!result.ok) {
          setError(result.error)
          return
        }
        setFile({ name: picked.name, csv })
        setRead(result)
        setPicks(
          Object.fromEntries(
            result.rows.map((row, i) => [row.ref, result.matches[i].orderId ?? ''])
          )
        )
        setSaved(null)
        setError(null)
      } catch {
        setError(READ_FAILED)
      }
    })
  }

  const ordersById = new Map((read?.orders ?? []).map((order) => [order.id, order]))
  const pickable = (read?.orders ?? []).filter((order) => !order.voided)
  const chosen = Object.values(picks).filter((id): id is number => id !== '')
  const twice = new Set(chosen.filter((id, i) => chosen.indexOf(id) !== i))

  // A row whose match an import already recorded, unchanged, needs no look.
  const rows = (read?.rows ?? []).map((row, i) => {
    const match = read!.matches[i]
    const pick = picks[row.ref] ?? ''
    const order = pick === '' ? null : (ordersById.get(pick) ?? null)
    const quiet = order !== null && pick === match.orderId && alreadyRecorded(row, order)
    return { row, match, pick, order, quiet }
  })
  const toCheck = rows.filter((r) => !r.quiet)
  const recorded = rows.filter((r) => r.quiet)
  const missing = read ? notInFile(read.orders, chosen) : []

  const save = () => {
    if (!file || !read) return
    const choices = rows.flatMap(({ row, pick }) =>
      pick === '' ? [] : [{ ref: row.ref, orderId: pick }]
    )
    startBusy(async () => {
      try {
        const result = await saveFindeliversFile(file.csv, choices)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (!result.ok) {
          setError(result.error)
          return
        }
        setSaved(result)
        setError(null)
        onSaved()
      } catch {
        setError(SAVE_FAILED)
      }
    })
  }

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="bline-import-title"
    >
      <DialogTitle id="bline-import-title">Import from findelivers</DialogTitle>
      <DialogContent>
        {saved ? (
          <Box display="flex" flexDirection="column" gap={1}>
            <Alert severity="success">{savedLine(saved)}</Alert>
            {saved.problems.map((problem) => (
              <Alert key={problem} severity="error">
                {problem}
              </Alert>
            ))}
            {saved.warnings.map((warning) => (
              <Alert key={warning} severity="warning">
                {warning}
              </Alert>
            ))}
          </Box>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              In findelivers, open Orders, set the Delivery slot dates (this week, or this month),
              then Download CSV → Download Orders CSV. Choose that file here.
            </Typography>
            <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" my={1}>
              <Button variant="outlined" component="label" disabled={busy}>
                {file ? 'Choose another file' : 'Choose file'}
                <input hidden type="file" accept=".csv,text/csv" onChange={choose} />
              </Button>
              {file && (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {file.name}
                </Typography>
              )}
              {busy && <CircularProgress size={20} aria-label="Working" />}
            </Box>

            {error && (
              <Alert severity="error" sx={{ my: 1 }}>
                {error}
              </Alert>
            )}

            {read && (
              <>
                <Typography variant="body2" mb={1}>
                  {read.rows.length} {read.rows.length === 1 ? 'delivery' : 'deliveries'} in the
                  file
                  {read.pickups
                    ? `, ${read.pickups} ${read.pickups === 1 ? 'pickup' : 'pickups'} left out`
                    : ''}
                  {read.unreadable
                    ? `, ${read.unreadable} unreadable ${read.unreadable === 1 ? 'row' : 'rows'} left out`
                    : ''}
                  .
                </Typography>

                {toCheck.length > 0 && (
                  <Typography variant="subtitle2" component="h3" mt={1}>
                    Check each order
                  </Typography>
                )}
                {toCheck.map(({ row, match, pick }) => (
                  <Box
                    key={row.ref}
                    component="section"
                    aria-label={`findelivers ${row.ref}`}
                    sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, my: 1 }}
                  >
                    <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
                      {row.recipient || 'No recipient'}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {row.address} · {row.ref}
                    </Typography>
                    <Typography variant="body2" mb={1}>
                      {rowStatus(row)}
                    </Typography>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="Order"
                      value={pick}
                      onChange={(event) =>
                        setPicks((prev) => ({
                          ...prev,
                          [row.ref]: event.target.value === '' ? '' : Number(event.target.value),
                        }))
                      }
                      error={pick !== '' && twice.has(pick)}
                      helperText={
                        pick !== '' && twice.has(pick)
                          ? 'Picked for another row too.'
                          : pick === ''
                            ? 'Not recorded.'
                            : ' '
                      }
                    >
                      <MenuItem value="">None: not one of our orders</MenuItem>
                      {pickable.map((order) => (
                        <MenuItem key={order.id} value={order.id}>
                          {orderLabel(order, row.ref)}
                        </MenuItem>
                      ))}
                    </TextField>
                    {match.note && pick === match.orderId && (
                      <Alert severity="warning" sx={{ mt: 0.5 }}>
                        {match.note}
                      </Alert>
                    )}
                    {match.note && match.orderId === null && (
                      <Alert severity="info" sx={{ mt: 0.5 }}>
                        {match.note}
                      </Alert>
                    )}
                  </Box>
                ))}

                {recorded.length > 0 && (
                  <>
                    <Typography variant="subtitle2" component="h3" mt={2}>
                      Already recorded ({recorded.length})
                    </Typography>
                    {recorded.map(({ row, order }) => (
                      <Typography key={row.ref} variant="body2" color="text.secondary">
                        {row.ref} · #{order!.id} {order!.customerName} · {rowStatus(row)}
                      </Typography>
                    ))}
                  </>
                )}

                {missing.length > 0 && (
                  <>
                    <Typography variant="subtitle2" component="h3" mt={2}>
                      Not in this file ({missing.length})
                    </Typography>
                    {missing.map((order) => (
                      <Typography key={order.id} variant="body2">
                        {waitingTitle(order)}
                      </Typography>
                    ))}
                    <Typography variant="caption" color="text.secondary" component="div" mt={0.5}>
                      BLine usually enters an order within a day of your email. If the file covers
                      its date and it isn&apos;t there, email BLine.
                    </Typography>
                  </>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {saved ? (
          <Button variant="contained" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={save}
              disabled={busy || !read || chosen.length === 0 || twice.size > 0}
            >
              Save
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}

export default BlineImportDialog
