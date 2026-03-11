'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Paper from '@mui/material/Paper'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import MenuItem from '@mui/material/MenuItem'
import { createOrder, getLocations, getLocationTypes } from '@/app/actions/orders'
import type { NewOrder } from '@/types/orders'

const defaultState: NewOrder = {
  name: '',
  isBusiness: true,
  isNewBusiness: false,
  isDTC: false,
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
  businessType: null,
  streetAddress: null,
  city: null,
  state: null,
  zip: null,
  deliveryType: null,
}

export default function OrderForm() {
  const [form, setForm] = useState<NewOrder>(defaultState)
  const [manualNumber, setManualNumber] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAppScriptDialog, setShowAppScriptDialog] = useState(false)
  type Location = { name: string; address: string; businessType: string }
  const [locations, setLocations] = useState<Location[]>([])
  const [locationTypes, setLocationTypes] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()
  const customBusinessTypeRef = useRef<HTMLInputElement>(null)

  const isCustomBusinessType =
    !locationTypes.includes(form.businessType ?? '') && form.businessType !== null

  useEffect(() => {
    if (isCustomBusinessType) {
      customBusinessTypeRef.current?.focus()
    }
  }, [isCustomBusinessType])

  useEffect(() => {
    getLocations().then((data) => {
      if (data) setLocations(data as Location[])
    })
    getLocationTypes().then((data) => {
      if (data) setLocationTypes(data.map((d) => d.name))
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
      setForm((prev) => ({
        ...prev,
        [field]: e.target.value === '' ? null : Number(e.target.value),
      }))
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
        const wasNewBusiness = form.isNewBusiness
        await createOrder(form)
        setSuccess(true)
        setForm(defaultState)
        if (wasNewBusiness) setShowAppScriptDialog(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  return (
    <>
    <Paper elevation={2} sx={{ p: 4, maxWidth: 560, width: '100%' }}>
      <Typography variant="h5" fontWeight={600} mb={3}>
        New Order
      </Typography>

      <Box display="flex" gap={2} flexWrap="wrap">
        <FormControlLabel
          control={
            <Switch checked={form.isBusiness ?? false} onChange={handleSwitch('isBusiness')} />
          }
          label="Business"
        />
        {(form.isBusiness || form.isDTC) && (
          <FormControlLabel
            control={
              <Switch
                checked={form.isNewBusiness ?? false}
                onChange={handleSwitch('isNewBusiness')}
              />
            }
            label="New Business"
          />
        )}
        <FormControlLabel
          control={<Switch checked={form.isDTC ?? false} onChange={handleSwitch('isDTC')} />}
          label="DTC"
        />
      </Box>

      <Box component="form" onSubmit={handleSubmit} display="flex" flexDirection="column" gap={3}>
        {/* Customer */}
        {form.isNewBusiness || form.isDTC || !form.isBusiness ? (
          <TextField
            label="DTC or New Business Name"
            value={form.name ?? ''}
            onChange={handleText('name')}
            fullWidth
            required
          />
        ) : (
          <Autocomplete
            options={locations}
            getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
            value={locations.find((l) => l.name === form.name) ?? null}
            onChange={(_, value) => {
              if (!value || typeof value === 'string') return
              setForm((prev) => ({
                ...prev,
                name: value.name,
                notes: value.address,
              }))
            }}
            renderInput={(params) => <TextField {...params} label="Name" required />}
            fullWidth
          />
        )}

        {(form.isNewBusiness || form.isDTC) && (
          <>
            {!form.isDTC && (
              <>
                <TextField
                  select
                  label="Type of Business"
                  value={
                    locationTypes.includes(form.businessType ?? '')
                      ? (form.businessType ?? '')
                      : form.businessType
                        ? 'Other'
                        : ''
                  }
                  onChange={(e) => {
                    const val = e.target.value
                    setForm((prev) => ({ ...prev, businessType: val === 'Other' ? '' : val }))
                  }}
                  fullWidth
                >
                  {locationTypes.map((type) => (
                    <MenuItem key={type} value={type}>
                      {type}
                    </MenuItem>
                  ))}
                  <MenuItem value="Other">Other</MenuItem>
                </TextField>
                {isCustomBusinessType && (
                  <TextField
                    label="Specify Business Type"
                    value={form.businessType ?? ''}
                    onChange={handleText('businessType')}
                    fullWidth
                    inputRef={customBusinessTypeRef}
                  />
                )}
              </>
            )}
            <TextField
              label="Street Address"
              value={form.streetAddress ?? ''}
              onChange={handleText('streetAddress')}
              fullWidth
            />
            <Box display="flex" gap={2}>
              <TextField
                label="City"
                value={form.city ?? ''}
                onChange={handleText('city')}
                sx={{ flex: 2 }}
              />
              <TextField
                label="State"
                value={form.state ?? ''}
                onChange={handleText('state')}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Zip"
                value={form.zip ?? ''}
                onChange={handleText('zip')}
                sx={{ flex: 1 }}
              />
            </Box>

          </>
        )}

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
            control={
              <Switch checked={manualNumber} onChange={(e) => setManualNumber(e.target.checked)} />
            }
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
              control={
                <Switch
                  checked={form.IsCustomStill ?? false}
                  onChange={handleSwitch('IsCustomStill')}
                />
              }
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
              control={
                <Switch
                  checked={form.isCustomSpark ?? false}
                  onChange={handleSwitch('isCustomSpark')}
                />
              }
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
            control={
              <Switch
                checked={form.createInvoice ?? false}
                onChange={handleSwitch('createInvoice')}
              />
            }
            label="Create Invoice"
          />
        </Box>
        
        <Divider />
        <Typography variant="subtitle2" color="text.secondary">
          Delivery Type
        </Typography>

        <Box display="flex" gap={2} flexWrap="wrap">
          <FormControlLabel
            control={
              <Switch
                checked={form.deliveryType === 'Ship'}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, deliveryType: e.target.checked ? 'Ship' : null }))
                }
              />
            }
            label="Ship"
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.deliveryType === 'Pickup'}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, deliveryType: e.target.checked ? 'Pickup' : null }))
                }
              />
            }
            label="Pickup"
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

        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={isPending || !form.name || (!form.isStill && !form.isSpark) || !form.price}
        >
          {isPending ? 'Submitting...' : 'Submit Order'}
        </Button>
      </Box>
    </Paper>

    <Dialog open={showAppScriptDialog} onClose={() => setShowAppScriptDialog(false)}>
      <DialogTitle>New Business Added</DialogTitle>
      <DialogContent>
        <Typography>
          Be sure to run App Scripts —{' '}
          <Link
            href="https://docs.google.com/spreadsheets/d/1bIwlYpMhAHQiXHFHs1yY0EEwjrDbIChbrxtVl17P-sw/edit?gid=1985380506#gid=1985380506"
            target="_blank"
            rel="noopener noreferrer"
          >
            open the sheet
          </Link>
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setShowAppScriptDialog(false)}>Dismiss</Button>
      </DialogActions>
    </Dialog>
    </>
  )
}
