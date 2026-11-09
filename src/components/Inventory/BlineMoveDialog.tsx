import { useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { updateBlineStock } from '@/app/actions/bline'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { batchTitle } from '@/lib/batches'
import type { Batch, BlineStockRow } from '@/lib/db/types'
import { atBline, blineRowTitle, onHandAtBline, sendableBatches } from './blineRows'
import { portlandToday } from './dates'
import type { BlineData, BlineUpdate } from './types'
import { useFullScreenDialog } from './useFullScreenDialog'
import { formatCans, formatChange, quantityToCans, toCases, type CountUnit } from './units'
import { MAX_CANS, blineUpdateProblem } from './validation'

type Kind = BlineUpdate['kind']

type Props = {
  batches: Batch[]
  stock: BlineStockRow[]
  onClose: () => void
  /** Saved; this is what BLine has now. */
  onSaved: (data: BlineData) => void
  /** The save was refused because things changed; this is what BLine has now. */
  onStale: (data: BlineData) => void
}

const SAVE_FAILED = 'Could not save that. Try again.'

const WORDS: Record<Kind, { quantity: string; date: string }> = {
  sent: { quantity: 'sent', date: 'Sent on' },
  returned: { quantity: 'brought back', date: 'Brought back on' },
  count: { quantity: 'BLine counted today', date: 'Counted on' },
}

/** Cans sent to BLine, brought back from it, or what BLine counted. */
const BlineMoveDialog = ({ batches, stock, onClose, onSaved, onStale }: Props) => {
  const fullScreen = useFullScreenDialog()
  const [kind, setKind] = useState<Kind>('sent')
  const [batchPick, setBatchPick] = useState<number | ''>('')
  const [quantity, setQuantity] = useState<{ unit: CountUnit; text: string }>({
    unit: 'cases',
    text: '',
  })
  const today = portlandToday()
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  // Cans go to BLine from any live batch; they come back from, or are counted for, a batch
  // BLine has had.
  const options =
    kind === 'sent'
      ? sendableBatches(batches).map((batch) => ({ id: batch.id, label: batchTitle(batch) }))
      : stock
          .filter((row) => kind === 'count' || row.on_hand > 0)
          .map((row) => ({ id: row.batch_id, label: blineRowTitle(row, batches) }))
  const batchId =
    batchPick !== '' && options.some((option) => option.id === batchPick)
      ? batchPick
      : options.length === 1
        ? options[0].id
        : ''
  const batch = batches.find((b) => b.id === batchId) ?? null
  // Left once every booked delivery is made, and on BLine's shelf today (cans for deliveries
  // after today are still there, so that is what BLine counts).
  const there = atBline(stock, batchId)
  const onHand = onHandAtBline(stock, batchId)
  const forDeliveries = onHand - there

  const cans = quantityToCans(quantity.text, quantity.unit)
  const typed = quantity.text.trim() !== ''
  const problem = !typed
    ? null
    : cans === null
      ? quantity.unit === 'cases'
        ? 'Enter cases that make whole cans (24 to a case).'
        : 'Enter a whole number of cans.'
      : cans > MAX_CANS
        ? `That's more than ${formatCans(MAX_CANS)}.`
        : kind !== 'count' && cans === 0
          ? 'Enter more than 0.'
          : kind === 'returned' && cans > onHand
            ? `BLine should only have ${formatCans(onHand)} of this batch. If that's wrong, record BLine's count instead.`
            : null
  // Not a reason to refuse: the batch count may simply be behind.
  const notAtBline = batch ? batch.count - Math.max(there, 0) : null
  const overSend =
    kind === 'sent' && cans !== null && notAtBline !== null && cans > notAtBline
      ? ` The batch has only ${formatCans(Math.max(notAtBline, 0))} that aren't at BLine already.`
      : ''
  // Not a reason to refuse either: those cans may simply not be needed.
  const overReturn =
    kind === 'returned' && cans !== null && cans > Math.max(there, 0)
      ? ` That takes cans BLine needs for deliveries it hasn't made yet.`
      : ''
  const preview =
    cans === null || problem
      ? ' '
      : kind === 'count'
        ? `${formatCans(cans)} (${toCases(cans)}) · should have ${formatCans(onHand)} · ${
            cans === onHand ? 'no change' : `${formatChange(cans - onHand)} cans`
          }`
        : `${formatCans(cans)} (${toCases(cans)})${overSend}${overReturn}`
  const datedLater = kind !== 'count' && date > today

  const update: BlineUpdate | null =
    batchId === '' || cans === null
      ? null
      : kind === 'count'
        ? { kind, batchId, counted: cans, expectedCount: onHand, note }
        : { kind, batchId, cans, movedOn: date, note: note.trim() || null }

  const save = () => {
    if (!update) return
    const updateProblem = blineUpdateProblem(update)
    if (updateProblem) {
      setError(updateProblem)
      return
    }
    setError(null)
    startSaving(async () => {
      try {
        const result = await updateBlineStock(update)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (!result.ok) {
          setError(result.error)
          if (result.data) onStale(result.data)
          return
        }
        onSaved({ stock: result.stock, moves: result.moves })
      } catch {
        setError(SAVE_FAILED)
      }
    })
  }

  const unchanged = kind === 'count' && cans === onHand

  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm">
      <DialogTitle>Update what BLine has</DialogTitle>
      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={2}>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            color="primary"
            value={kind}
            onChange={(_, value: Kind | null) => {
              if (value) {
                setKind(value)
                setError(null)
              }
            }}
            aria-label="What happened"
          >
            <ToggleButton value="sent">Sent</ToggleButton>
            <ToggleButton value="returned">Brought back</ToggleButton>
            <ToggleButton value="count">Counted</ToggleButton>
          </ToggleButtonGroup>
          {options.length === 0 ? (
            <Alert severity="info">
              {kind === 'sent'
                ? 'No batches in inventory to send from.'
                : 'BLine has no cans recorded yet. Record what you sent first.'}
            </Alert>
          ) : (
            <TextField
              select
              label="Batch"
              value={batchId}
              onChange={(e) => setBatchPick(Number(e.target.value))}
              helperText={
                batchId !== '' && kind !== 'sent'
                  ? `BLine should have ${formatCans(onHand)} (${toCases(onHand)}) today${
                      forDeliveries > 0
                        ? `, ${formatCans(forDeliveries)} of them for deliveries it hasn't made yet`
                        : ''
                    }.`
                  : batch
                    ? `${formatCans(batch.count)} on hand, ${formatCans(onHand)} of them at BLine.`
                    : ' '
              }
              fullWidth
              required
            >
              {options.map((option) => (
                <MenuItem key={option.id} value={option.id} sx={{ whiteSpace: 'normal' }}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
          )}
          <ToggleButtonGroup
            exclusive
            size="small"
            color="primary"
            value={quantity.unit}
            onChange={(_, unit: CountUnit | null) => {
              if (unit) setQuantity((prev) => ({ ...prev, unit }))
            }}
            aria-label="Count in"
          >
            <ToggleButton value="cases">Cases</ToggleButton>
            <ToggleButton value="cans">Cans</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            label={`${quantity.unit === 'cases' ? 'Cases' : 'Cans'} ${WORDS[kind].quantity}`}
            value={quantity.text}
            onChange={(e) => setQuantity((prev) => ({ ...prev, text: e.target.value }))}
            error={problem !== null}
            helperText={problem ?? preview}
            fullWidth
            slotProps={{
              htmlInput: { inputMode: quantity.unit === 'cases' ? 'decimal' : 'numeric' },
              formHelperText: {
                sx: (overSend || overReturn) && !problem ? { color: 'warning.dark' } : undefined,
              },
            }}
          />
          {kind !== 'count' && (
            <TextField
              label={WORDS[kind].date}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              error={datedLater}
              helperText={datedLater ? "The date can't be after today." : ' '}
              fullWidth
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: today } }}
            />
          )}
          <TextField
            label={kind === 'count' ? 'Where is the count from?' : 'Note'}
            required={kind === 'count'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            helperText={
              kind === 'count'
                ? "For example: BLine's email. Record a count the day BLine makes it."
                : 'Optional. For example: first pallet'
            }
            fullWidth
          />
          <Typography variant="body2" color="text.secondary">
            Batch counts don&apos;t change: a batch counts its cans wherever they are. BLine orders
            take their cans off BLine on their own.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={
            saving ||
            update === null ||
            problem !== null ||
            unchanged ||
            datedLater ||
            (kind === 'count' && !note.trim())
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default BlineMoveDialog
