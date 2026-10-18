import { useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { changeBatchCount } from '@/app/actions/batches'
import { isAuthFailure } from '@/lib/auth/authFailure'
import type { Batch } from '@/lib/db/types'
import {
  countAsQuantity,
  formatCans,
  formatChange,
  quantityToCans,
  toCases,
  type CountUnit,
} from './units'
import { MAX_CANS, countChangeProblem } from './validation'

type Props = {
  batch: Batch
  onCancel: () => void
  /** The new count was saved. */
  onSaved: (batch: Batch) => void
  /** Someone changed the batch while this form was open; this is it now. */
  onStale: (batch: Batch) => void
}

const SAVE_FAILED = 'Could not change the count. Try again.'

const quantityProblem = (text: string, unit: CountUnit, cans: number | null) => {
  if (text.trim() === '') return null
  if (cans === null) {
    return unit === 'cases'
      ? 'Enter cases that make whole cans (24 to a case).'
      : 'Enter a whole number of cans.'
  }
  return cans > MAX_CANS ? `That's more than ${formatCans(MAX_CANS)}.` : null
}

/** Set a batch to what was counted, in cans or cases, with a note saying why. */
const ChangeCountForm = ({ batch, onCancel, onSaved, onStale }: Props) => {
  const [quantity, setQuantity] = useState(() => countAsQuantity(batch.count))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const newCount = quantityToCans(quantity.text, quantity.unit)
  const problem = quantityProblem(quantity.text, quantity.unit, newCount)
  const unchanged = newCount === batch.count
  const preview =
    newCount === null || problem
      ? ' '
      : `${formatCans(newCount)} (${toCases(newCount)}) · ${
          unchanged ? 'same as now' : `${formatChange(newCount - batch.count)} cans`
        }`

  const save = () => {
    if (newCount === null) return
    const change = { batchId: batch.id, newCount, expectedCount: batch.count, note }
    const changeProblem = countChangeProblem(change)
    if (changeProblem) {
      setError(changeProblem)
      return
    }
    setError(null)
    startSaving(async () => {
      try {
        const result = await changeBatchCount(change)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (!result.ok) {
          setError(result.error)
          if (result.batch) onStale(result.batch)
          return
        }
        onSaved(result.batch)
      } catch {
        setError(SAVE_FAILED)
      }
    })
  }

  return (
    <>
      <DialogContent dividers>
        <Typography variant="subtitle1" component="h3" fontWeight={600}>
          Change count
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Now {formatCans(batch.count)} ({toCases(batch.count)}). Enter what you counted.
        </Typography>
        <Box display="flex" flexDirection="column" gap={2}>
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
            label={quantity.unit === 'cases' ? 'Cases counted' : 'Cans counted'}
            value={quantity.text}
            onChange={(e) => setQuantity((prev) => ({ ...prev, text: e.target.value }))}
            error={problem !== null}
            helperText={problem ?? preview}
            fullWidth
            autoFocus
            slotProps={{
              htmlInput: { inputMode: quantity.unit === 'cases' ? 'decimal' : 'numeric' },
            }}
          />
          <TextField
            label="Why is the count changing?"
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
            helperText="For example: recount, damaged cans, samples"
            multiline
            minRows={2}
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>
          Back
        </Button>
        <Button
          variant="contained"
          onClick={save}
          disabled={saving || newCount === null || problem !== null || unchanged || !note.trim()}
        >
          {saving ? 'Saving…' : 'Save count'}
        </Button>
      </DialogActions>
    </>
  )
}

export default ChangeCountForm
