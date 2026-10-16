import { useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { archiveInventoryBatch, unarchiveInventoryBatch } from '@/app/actions/batches'
import { isAuthFailure } from '@/lib/auth/authFailure'
import type { Batch } from '@/lib/db/types'
import { formatCans } from './units'
import { archiveProblem, optionalNoteProblem } from './validation'

type Props = {
  batch: Batch
  onCancel: () => void
  onSaved: (batch: Batch) => void
  /** The batch changed while this form was open; this is it now. */
  onStale: (batch: Batch) => void
}

const writeOff = (count: number) =>
  count > 0
    ? ` Its ${formatCans(count)} will be written off.`
    : count < 0
      ? ` Its count of ${formatCans(count)} will be reset to 0.`
      : ''

/** Archive instead of delete (or undo an archive). */
const ArchiveForm = ({ batch, onCancel, onSaved, onStale }: Props) => {
  const archived = batch.archived_at !== null
  const needsNote = !archived && batch.count !== 0
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const submit = () => {
    const problem = archived ? optionalNoteProblem(note) : archiveProblem(batch.count, note)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    startSaving(async () => {
      try {
        const result = archived
          ? await unarchiveInventoryBatch(batch.id, note)
          : await archiveInventoryBatch(batch.id, note)
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
        setError(`Could not ${archived ? 'unarchive' : 'archive'} the batch. Try again.`)
      }
    })
  }

  return (
    <>
      <DialogContent dividers>
        <Typography variant="subtitle1" component="h3" fontWeight={600}>
          {archived ? 'Unarchive this batch?' : 'Archive this batch?'}
        </Typography>
        <Typography variant="body2" mb={2}>
          {archived
            ? 'It goes back on the list and in the order form, with the cans that were written off when it was archived.'
            : `It leaves the list and the order form but keeps its history, and you can unarchive it later.${writeOff(batch.count)}`}
        </Typography>
        <TextField
          label={needsNote ? 'Why?' : 'Why? (optional)'}
          required={needsNote}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          multiline
          minRows={2}
          fullWidth
        />
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>
          Back
        </Button>
        <Button
          variant="contained"
          color={archived ? 'primary' : 'warning'}
          onClick={submit}
          disabled={saving || (needsNote && !note.trim())}
        >
          {archived ? 'Unarchive' : 'Archive'}
        </Button>
      </DialogActions>
    </>
  )
}

export default ArchiveForm
