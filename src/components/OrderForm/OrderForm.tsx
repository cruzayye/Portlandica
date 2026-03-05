'use client'

import { useState, useTransition } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Paper from '@mui/material/Paper'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import { createOrder } from '@/app/actions/orders'
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
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

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
        <TextField
          label="Name"
          value={form.name ?? ''}
          onChange={handleText('name')}
          fullWidth
          required
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
          
        </Box>

        {form.isStill && (
          <Box display="flex" gap={2} alignItems="center">
            <TextField
              label="Total Still Cases"
              type="number"
              value={form.totalStill ?? ''}
              onChange={handleNumber('totalStill')}
              sx={{ flex: 1 }}
              inputProps={{ min: 0 }}
            />
            <FormControlLabel
              control={<Switch checked={form.IsCustomStill ?? false} onChange={handleSwitch('IsCustomStill')} />}
              label="Custom Still"
            />
          </Box>
        )}

        {form.isSpark && (
          <Box display="flex" gap={2} alignItems="center">
            <TextField
              label="Total Sparkling Cases"
              type="number"
              value={form.totalSpark ?? ''}
              onChange={handleNumber('totalSpark')}
              sx={{ flex: 1 }}
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
