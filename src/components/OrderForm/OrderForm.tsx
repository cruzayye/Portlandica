'use client'

import { useState, useTransition, useEffect } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Paper from '@mui/material/Paper'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import { createOrder, getLocations } from '@/app/actions/orders'
import type { NewOrder } from '@/types/orders'

const defaultState: NewOrder = {
  name: '',
  isBusiness: true,
  isNewBusiness: false,
  isStill: false,
  isSpark: false,
  totalStill: null,
  totalSpark: null,
  IsCustomStill: false,
  isCustomSpark: false,
  price: null,
  isPaid: false,
  createInvoice: false,
  notes: '',
}

export default function OrderForm() {
  const [form, setForm] = useState<NewOrder>(defaultState)
  const [manualNumber, setManualNumber] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  type Location = { name: string; street_address: string; city: string; state: string }
  const [locations, setLocations] = useState<Location[]>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getLocations().then((data) => {
      if (data) setLocations(data as Location[])
    })
  }, [])

  useEffect(() => {
    const total = (form.totalStill ?? 0) + (form.totalSpark ?? 0)
    setForm((prev) => ({ ...prev, price: total > 0 ? total * 1.5 : null }))
  }, [form.totalStill, form.totalSpark])

  function handleSwitch(field: keyof NewOrder) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.checked }))
  }

  function handleText(field: keyof NewOrder) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  function handleNumber(field: keyof NewOrder) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value === '' ? null : Number(e.target.value) }))
  }

  function handleCasesBlur(field: 'totalStill' | 'totalSpark') {
    return () => {
      if (manualNumber) return
      setForm((prev) => ({
        ...prev,
        [field]: prev[field] != null ? (prev[field] as number) * 24 : null,
      }))
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    startTransition(async () => {
      try {
        await createOrder(form)
        setSuccess(true)
        setForm(defaultState)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  return (
    <Paper elevation={2} sx={{ p: 4, maxWidth: 560, width: '100%' }}>
      <Typography variant="h5" fontWeight={600} mb={3}>
        New Order
      </Typography>

      <Box component="form" onSubmit={handleSubmit} display="flex" flexDirection="column" gap={3}>
        {/* Customer */}
        <Autocomplete
          options={locations}
          getOptionLabel={(option) => typeof option === 'string' ? option : option.name}
          value={locations.find((l) => l.name === form.name) ?? null}
          onChange={(_, value) => {
            if (!value || typeof value === 'string') return
            setForm((prev) => ({
              ...prev,
              name: value.name,
              notes: `${value.street_address}, ${value.city}, ${value.state}`,
            }))
          }}
          renderInput={(params) => (
            <TextField {...params} label="Name" required />
          )}
          fullWidth
        />

        <Box display="flex" gap={2} flexWrap="wrap">
          <FormControlLabel
            control={<Switch checked={form.isBusiness ?? false} onChange={handleSwitch('isBusiness')} />}
            label="Business"
          />
          {form.isBusiness && (
            <FormControlLabel
              control={<Switch checked={form.isNewBusiness ?? false} onChange={handleSwitch('isNewBusiness')} />}
              label="New Business"
            />
          )}
        </Box>

        <Divider />

        {/* Water type */}
        <Typography variant="subtitle2" color="text.secondary">
          Water Type
        </Typography>

        <Box display="flex" gap={2} flexWrap="wrap">
          <FormControlLabel
            control={<Switch checked={form.isStill ?? false} onChange={handleSwitch('isStill')} />}
            label="Still"
          />
          <FormControlLabel
            control={<Switch checked={form.isSpark ?? false} onChange={handleSwitch('isSpark')} />}
            label="Sparkling"
          />
          <FormControlLabel
            control={<Switch checked={manualNumber} onChange={(e) => setManualNumber(e.target.checked)} />}
            label="Enter Manual Number"
          />
        </Box>

        {form.isStill && (
          <Box display="flex" flexDirection="column" gap={1}>
            <TextField
              label="Total Still Cases"
              type="number"
              value={form.totalStill ?? ''}
              onChange={handleNumber('totalStill')}
              onBlur={handleCasesBlur('totalStill')}
              inputProps={{ min: 0 }}
            />
            <FormControlLabel
              control={<Switch checked={form.IsCustomStill ?? false} onChange={handleSwitch('IsCustomStill')} />}
              label="Custom Still"
            />
          </Box>
        )}

        {form.isSpark && (
          <Box display="flex" flexDirection="column" gap={1}>
            <TextField
              label="Total Sparkling Cases"
              type="number"
              value={form.totalSpark ?? ''}
              onChange={handleNumber('totalSpark')}
              onBlur={handleCasesBlur('totalSpark')}
              inputProps={{ min: 0 }}
            />
            <FormControlLabel
              control={<Switch checked={form.isCustomSpark ?? false} onChange={handleSwitch('isCustomSpark')} />}
              label="Custom Sparkling"
            />
          </Box>
        )}

        <Divider />

        {/* Pricing */}
        <TextField
          label="Price"
          type="number"
          value={form.price ?? ''}
          onChange={handleNumber('price')}
          fullWidth
          inputProps={{ min: 0, step: 0.01 }}
          slotProps={{ input: { startAdornment: <Typography mr={0.5}>$</Typography> } }}
        />

        <Box display="flex" gap={2} flexWrap="wrap">
          <FormControlLabel
            control={<Switch checked={form.isPaid ?? false} onChange={handleSwitch('isPaid')} />}
            label="Paid"
          />
          <FormControlLabel
            control={<Switch checked={form.createInvoice ?? false} onChange={handleSwitch('createInvoice')} />}
            label="Create Invoice"
          />
        </Box>

        <Divider />

        {/* Notes */}
        <TextField
          label="Notes"
          value={form.notes ?? ''}
          onChange={handleText('notes')}
          fullWidth
          multiline
          rows={3}
        />

        {success && <Alert severity="success">Order submitted successfully!</Alert>}
        {error && <Alert severity="error">{error}</Alert>}

        <Button type="submit" variant="contained" size="large" disabled={isPending}>
          {isPending ? 'Submitting...' : 'Submit Order'}
        </Button>
      </Box>
    </Paper>
  )
}
