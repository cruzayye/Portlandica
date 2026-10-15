import { useState, useTransition, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import InputAdornment from '@mui/material/InputAdornment'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { addBatch } from '@/app/actions/batches'
import { CANS_PER_CASE } from '@/globals/constants'
import { isAuthFailure } from '@/lib/auth/authFailure'
import type { Batch } from '@/lib/db/types'
import { PRODUCTS, PRODUCT_LABELS } from './stock'
import type { CustomerOption, NewBatchInput, StockKind, StockProduct } from './types'
import { formatCans, parseDollars, quantityToCans, toPallets } from './units'
import { MAX_CANS, fillProblem } from './validation'
import { useFullScreenDialog } from './useFullScreenDialog'

export const WATER_SOURCES = ['North Powder', 'Opal Springs']

/** What a new house-stock batch is called unless the partner changes it. */
export const DEFAULT_BATCH_NAME = 'Portlandica'

const ADD_FAILED = 'Could not add the batch. Try again.'

type Form = {
  kind: StockKind
  product: StockProduct
  name: string
  customer: CustomerOption | null
  cases: string
  source: string
  fillDate: string
  totalCost: string
  invoiceNumber: string
  note: string
}

/** Active customers for the picker, those with custom cans first. */
const customerChoices = (customers: CustomerOption[]) =>
  customers
    .filter((customer) => customer.active)
    .sort((a, b) => Number(b.customCans) - Number(a.customCans) || a.name.localeCompare(b.name))

const casesProblem = (text: string, cans: number | null) => {
  if (text.trim() === '') return null
  if (cans === null) return 'Enter cases that make whole cans (24 to a case).'
  return cans > MAX_CANS ? `That's more than ${formatCans(MAX_CANS)}.` : null
}

type Props = {
  customers: CustomerOption[]
  /** The fill date to start with (today in Portland). */
  fillDate: string
  onClose: () => void
  onAdded: (batch: Batch) => void
}

/** Record a fill: house stock, or custom cans for a customer picked from the customers table. */
const AddBatchDialog = ({ customers, fillDate, onClose, onAdded }: Props) => {
  const fullScreen = useFullScreenDialog()
  const [form, setForm] = useState<Form>({
    kind: 'house',
    product: 'still',
    name: DEFAULT_BATCH_NAME,
    customer: null,
    cases: '',
    source: '',
    fillDate,
    totalCost: '',
    invoiceNumber: '',
    note: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const choices = customerChoices(customers)
  const cans = quantityToCans(form.cases, 'cases')
  const problemWithCases = casesProblem(form.cases, cans)
  const cost = parseDollars(form.totalCost)

  const input: NewBatchInput = {
    kind: form.kind,
    product: form.product,
    cans: cans ?? 0,
    name: form.kind === 'house' ? form.name : null,
    customerId: form.kind === 'custom' ? (form.customer?.id ?? null) : null,
    source: form.source,
    fillDate: form.fillDate,
    totalCost: cost === null ? null : Math.round(cost * 100) / 100,
    invoiceNumber: form.invoiceNumber.trim() || null,
    note: form.note.trim() || null,
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = problemWithCases ?? fillProblem(input)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    startSaving(async () => {
      try {
        const result = await addBatch(input)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (!result.ok) {
          setError(result.error)
          return
        }
        onAdded(result.batch)
      } catch {
        setError(ADD_FAILED)
      }
    })
  }

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="add-batch-title"
    >
      <Box component="form" onSubmit={submit} noValidate>
        <DialogTitle id="add-batch-title">Add batch</DialogTitle>
        <DialogContent dividers>
          <Box display="flex" flexDirection="column" gap={2}>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color="primary"
              value={form.kind}
              onChange={(_, kind: StockKind | null) => {
                if (kind) update('kind', kind)
              }}
              aria-label="Stock"
            >
              <ToggleButton value="house">House stock</ToggleButton>
              <ToggleButton value="custom">Custom cans</ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              color="primary"
              value={form.product}
              onChange={(_, product: StockProduct | null) => {
                if (product) update('product', product)
              }}
              aria-label="Product"
            >
              {PRODUCTS.map((product) => (
                <ToggleButton key={product} value={product}>
                  {PRODUCT_LABELS[product]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {form.kind === 'house' ? (
              <TextField
                label="Batch name"
                required
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                fullWidth
              />
            ) : (
              <Autocomplete
                options={choices}
                groupBy={(customer) =>
                  customer.customCans ? 'Custom-can customers' : 'Other customers'
                }
                getOptionLabel={(customer) => customer.name}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                value={form.customer}
                onChange={(_, customer) => update('customer', customer)}
                noOptionsText="No customers found"
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Customer"
                    required
                    helperText={
                      choices.length === 0
                        ? 'No customers yet.'
                        : 'The batch is named after the customer.'
                    }
                  />
                )}
                fullWidth
              />
            )}
            <TextField
              label="Cases"
              required
              value={form.cases}
              onChange={(e) => update('cases', e.target.value)}
              error={problemWithCases !== null}
              helperText={
                problemWithCases ??
                (cans
                  ? `= ${formatCans(cans)} · ${toPallets(cans)}`
                  : `Cases of ${CANS_PER_CASE} cans`)
              }
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
            />
            <TextField
              select
              label="Water source"
              required
              value={form.source}
              onChange={(e) => update('source', e.target.value)}
              fullWidth
            >
              {WATER_SOURCES.map((source) => (
                <MenuItem key={source} value={source}>
                  {source}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Fill date"
              type="date"
              required
              value={form.fillDate}
              onChange={(e) => update('fillDate', e.target.value)}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Total cost"
              value={form.totalCost}
              onChange={(e) => update('totalCost', e.target.value)}
              helperText="Cans plus fill, from the invoice"
              fullWidth
              slotProps={{
                input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
                htmlInput: { inputMode: 'decimal' },
              }}
            />
            <TextField
              label="Invoice number"
              value={form.invoiceNumber}
              onChange={(e) => update('invoiceNumber', e.target.value)}
              fullWidth
            />
            <TextField
              label="Note"
              value={form.note}
              onChange={(e) => update('note', e.target.value)}
              multiline
              minRows={2}
              fullWidth
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={saving}>
            {saving ? 'Adding…' : 'Add batch'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

export default AddBatchDialog
