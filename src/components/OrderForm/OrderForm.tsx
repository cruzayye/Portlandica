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
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import MenuItem from '@mui/material/MenuItem'
import { createOrder, getLocations, getLocationTypes } from '@/app/actions/orders'
import { getInventory } from '@/app/actions/inventory'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { batchesFor, chosenBatchId, customBatchesFor } from '@/lib/batches'
import type { CustomerType, NewOrder, Inventory, OrderBatches } from '@/types/orders'
import { CANS_PER_CASE, CUSTOMER_PRICING, DEFAULT_PRICE_PER_CAN } from '@/globals/constants'
import { orderProblem, priceForCans, sparkCans, stillCans, toCans } from '@/lib/orders'

// Quantities are typed in their own boxes and turned into cans for the order; the price
// is worked out from them unless one is typed in.
type OrderFields = Omit<NewOrder, 'totalStill' | 'totalSpark' | 'price'>

const defaultState: OrderFields = {
  name: '',
  customerType: 'existing',
  isStill: false,
  isSpark: false,
  IsCustomStill: false,
  isCustomSpark: false,
  isPaid: false,
  createInvoice: false,
  notes: '',
  address: null,
  businessType: null,
  streetAddress: null,
  city: null,
  state: null,
  zip: null,
  deliveryType: null,
  isDonation: false,
}

const noQuantity = { still: '', spark: '' }
const noBatchPick: { still: number | ''; spark: number | '' } = { still: '', spark: '' }

export default function OrderForm() {
  const [form, setForm] = useState<OrderFields>(defaultState)
  // What was typed in each quantity box: cases, or single cans when manualNumber is on.
  const [quantity, setQuantity] = useState(noQuantity)
  const [manualNumber, setManualNumber] = useState(false)
  const [success, setSuccess] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showAppScriptDialog, setShowAppScriptDialog] = useState(false)
  type Location = { name: string; address: string; businessType: string }
  const [locations, setLocations] = useState<Location[]>([])
  const [locationTypes, setLocationTypes] = useState<string[]>([])
  const [inventory, setInventory] = useState<Inventory[]>([])
  const [batchPick, setBatchPick] = useState(noBatchPick)
  const [typedPrice, setTypedPrice] = useState<{
    value: number | null
    autoPrice: number | null
  } | null>(null)
  const [isPending, startTransition] = useTransition()
  const customBusinessTypeRef = useRef<HTMLInputElement>(null)
  const [showCustomPricingDialog, setShowCustomPricingDialog] = useState(false)
  const [isCustomPricing, setIsCustomPricing] = useState(false)
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null)

  const totalStill = toCans(quantity.still, manualNumber)
  const totalSpark = toCans(quantity.spark, manualNumber)
  const totalCans =
    stillCans({ isStill: form.isStill, totalStill }) +
    sparkCans({ isSpark: form.isSpark, totalSpark })

  const pricePerCan = isCustomPricing
    ? (CUSTOMER_PRICING[form.name ?? ''] ?? DEFAULT_PRICE_PER_CAN)
    : DEFAULT_PRICE_PER_CAN
  const autoPrice = priceForCans(totalCans, pricePerCan)
  // A donation is always $0. Otherwise a typed-in price holds until the automatic price
  // changes (cans, customer or custom pricing); then the automatic price takes over again.
  const price = form.isDonation
    ? 0
    : typedPrice && typedPrice.autoPrice === autoPrice
      ? typedPrice.value
      : autoPrice
  // A sale with cans but no price is either a donation or a mistake.
  const needsPrice = !form.isDonation && totalCans > 0 && !((price ?? 0) > 0)

  const order: NewOrder = { ...form, totalStill, totalSpark, price }

  const quantityHelp = (cans: number | null) =>
    manualNumber
      ? 'Single cans, not cases'
      : cans
        ? `= ${cans.toLocaleString('en-US')} cans`
        : `Cases of ${CANS_PER_CASE} cans`

  const stillBatches = batchesFor(inventory, true, form.name ?? null)
  const sparkBatches = batchesFor(inventory, false, form.name ?? null)

  // A batch filled specifically for this customer wins outright.
  const customStillBatches = customBatchesFor(stillBatches, form.name ?? null)
  const customSparkBatches = customBatchesFor(sparkBatches, form.name ?? null)

  const selectedInventoryId = chosenBatchId(batchPick.still, stillBatches, customStillBatches)
  const selectedSparkInventoryId = chosenBatchId(batchPick.spark, sparkBatches, customSparkBatches)

  const needsStillBatch = (form.isStill ?? false) && stillBatches.length > 1 && !selectedInventoryId
  const needsSparkBatch =
    (form.isSpark ?? false) && sparkBatches.length > 1 && !selectedSparkInventoryId
  const noStillBatches = (form.isStill ?? false) && stillBatches.length === 0
  const noSparkBatches = (form.isSpark ?? false) && sparkBatches.length === 0

  const batchHelp = (product: string, noBatches: boolean, needsBatch: boolean) =>
    noBatches
      ? `No ${product} batches in inventory. Add one on the Inventory tab first.`
      : needsBatch
        ? 'Select which batch this order pulls from'
        : ' '

  const batchLabel = (item: Inventory) =>
    `${item.name} ${item.isStill ? 'Still' : 'Spark'} — ${item.fillDate ?? ''}${
      item.source ? ` | ${item.source}` : ''
    }`

  const isCustomBusinessType =
    !locationTypes.includes(form.businessType ?? '') && form.businessType !== null

  useEffect(() => {
    if (isCustomBusinessType) {
      customBusinessTypeRef.current?.focus()
    }
  }, [isCustomBusinessType])

  useEffect(() => {
    getLocations().then((data) => {
      if (isAuthFailure(data)) setError(data.authError)
      else if (data) setLocations(data as Location[])
    })
    getLocationTypes().then((data) => {
      if (isAuthFailure(data)) setError(data.authError)
      else if (data) setLocationTypes(data.map((d) => d.name))
    })
    getInventory().then((data) => {
      if (isAuthFailure(data)) setError(data.authError)
      else setInventory(data)
    })
  }, [])

  const handleCustomPricingYes = () => {
    setIsCustomPricing(true)

    setForm((prev) => ({ ...prev, IsCustomStill: true, isCustomSpark: true }))
    setShowCustomPricingDialog(false)
  }

  const handleCustomPricingNo = () => {
    setIsCustomPricing(false)
    setShowCustomPricingDialog(false)
  }

  // Another customer means other batches on offer, and maybe custom pricing.
  const changeName = (name: string, address: string | null = null) => {
    setForm((prev) => ({ ...prev, name, address }))
    setBatchPick(noBatchPick)
    if (CUSTOMER_PRICING[name]) {
      setShowCustomPricingDialog(true)
    } else {
      setIsCustomPricing(false)
    }
  }

  // Each choice shows its own fields. Switching clears what the new choice hides, and the
  // name too when moving to or from Existing, which is picked from a list instead of typed.
  const changeCustomerType = (customerType: CustomerType) => {
    setForm((prev) => ({
      ...prev,
      customerType,
      address: null,
      businessType: null,
      streetAddress: null,
      city: null,
      state: null,
      zip: null,
    }))
    if (form.customerType === 'existing' || customerType === 'existing') changeName('')
  }

  // Switching a product off clears its quantity and batch, so nothing hidden gets ordered.
  const toggleProduct =
    (product: 'still' | 'spark') => (e: React.ChangeEvent<HTMLInputElement>) => {
      const on = e.target.checked
      setForm((prev) => ({ ...prev, [product === 'still' ? 'isStill' : 'isSpark']: on }))
      if (!on) {
        setQuantity((prev) => ({ ...prev, [product]: '' }))
        setBatchPick((prev) => ({ ...prev, [product]: '' }))
      }
    }

  function handleSwitch(field: keyof OrderFields) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.checked }))
  }

  function handleText(field: keyof OrderFields) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  // The batch picked for each product that is switched on, with its fill date for Trello.
  const orderBatches = (): OrderBatches => {
    const pick = (id: number | '') => {
      const batch = inventory.find((i) => i.id === id)
      return batch ? { id: batch.id, fillDate: batch.fillDate } : undefined
    }
    return {
      still: form.isStill ? pick(selectedInventoryId) : undefined,
      spark: form.isSpark ? pick(selectedSparkInventoryId) : undefined,
    }
  }

  const submitOrder = (force = false) => {
    setError(null)
    setSuccess(false)
    setWarnings([])

    startTransition(async () => {
      try {
        const wasNewBusiness = form.customerType === 'new'
        const result = await createOrder(order, orderBatches(), force)
        if (isAuthFailure(result)) {
          setError(result.authError)
          return
        }
        if (result.status === 'duplicate') {
          setDuplicateMessage(result.message)
          return
        }
        if (result.status === 'failed') {
          setError(result.message)
          return
        }
        // The order is in the sheet: start a fresh form even if a later step needs fixing by hand.
        setSuccess(true)
        setWarnings(result.warnings)
        setForm(defaultState)
        setQuantity(noQuantity)
        setManualNumber(false)
        setBatchPick(noBatchPick)
        setTypedPrice(null)
        setIsCustomPricing(false)
        if (wasNewBusiness) setShowAppScriptDialog(true)
      } catch {
        // The request itself failed, so there's no telling whether the sheet was written.
        setError(
          "Couldn't confirm the order was saved. Check the Sales sheet before submitting again."
        )
      }
    })
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submitOrder()
  }

  return (
    <>
      <Paper elevation={2} sx={{ p: 4, maxWidth: 560, width: '100%' }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h5" fontWeight={600}>
            New Order
          </Typography>
          <FormControlLabel
            control={
              <Switch checked={form.isDonation ?? false} onChange={handleSwitch('isDonation')} />
            }
            label="Donut"
          />
        </Box>

        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          color="primary"
          aria-label="Customer type"
          value={form.customerType}
          onChange={(_, value: CustomerType | null) => {
            if (value) changeCustomerType(value)
          }}
          sx={{ mb: 3 }}
        >
          <ToggleButton value="existing">Existing business</ToggleButton>
          <ToggleButton value="new">New business</ToggleButton>
          <ToggleButton value="individual">Individual (DTC)</ToggleButton>
        </ToggleButtonGroup>

        <Box component="form" onSubmit={handleSubmit} display="flex" flexDirection="column" gap={3}>
          {/* Customer */}
          {form.customerType !== 'existing' ? (
            <TextField
              label={form.customerType === 'new' ? 'New Business Name' : 'Customer Name'}
              value={form.name ?? ''}
              onChange={(e) => changeName(e.target.value)}
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
                // The address rides along for the Trello card; Notes stay the user's own text.
                changeName(value.name, value.address || null)
              }}
              renderInput={(params) => <TextField {...params} label="Name" required />}
              fullWidth
            />
          )}

          {form.customerType === 'new' && (
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
              control={<Switch checked={form.isStill ?? false} onChange={toggleProduct('still')} />}
              label="Still"
            />
            <FormControlLabel
              control={<Switch checked={form.isSpark ?? false} onChange={toggleProduct('spark')} />}
              label="Sparkling"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={manualNumber}
                  onChange={(e) => setManualNumber(e.target.checked)}
                />
              }
              label="Enter Manual Number (cans)"
            />
          </Box>

          {form.isStill && (
            <Box display="flex" flexDirection="column" gap={1}>
              <TextField
                label={manualNumber ? 'Total Still Cans' : 'Total Still Cases'}
                type="number"
                required
                value={quantity.still}
                onChange={(e) => setQuantity((prev) => ({ ...prev, still: e.target.value }))}
                helperText={quantityHelp(order.totalStill)}
                inputProps={{ min: 0 }}
                sx={{ '& .MuiInputBase-root': { backgroundColor: '#e3f2fd' } }}
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
              <TextField
                select
                label="Batch number"
                value={selectedInventoryId}
                onChange={(e) =>
                  setBatchPick((prev) => ({ ...prev, still: Number(e.target.value) }))
                }
                fullWidth
                required={stillBatches.length > 1}
                error={needsStillBatch || noStillBatches}
                helperText={batchHelp('Still', noStillBatches, needsStillBatch)}
                sx={{ '& .MuiInputBase-root': { backgroundColor: '#fffde7' } }}
              >
                {stillBatches.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {batchLabel(item)}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
          )}

          {form.isSpark && (
            <Box display="flex" flexDirection="column" gap={1}>
              <TextField
                label={manualNumber ? 'Total Sparkling Cans' : 'Total Sparkling Cases'}
                type="number"
                required
                value={quantity.spark}
                onChange={(e) => setQuantity((prev) => ({ ...prev, spark: e.target.value }))}
                helperText={quantityHelp(order.totalSpark)}
                inputProps={{ min: 0 }}
                sx={{ '& .MuiInputBase-root': { backgroundColor: '#e3f2fd' } }}
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
              <TextField
                select
                label="Batch number"
                value={selectedSparkInventoryId}
                onChange={(e) =>
                  setBatchPick((prev) => ({ ...prev, spark: Number(e.target.value) }))
                }
                fullWidth
                required={sparkBatches.length > 1}
                error={needsSparkBatch || noSparkBatches}
                helperText={batchHelp('Sparkling', noSparkBatches, needsSparkBatch)}
                sx={{ '& .MuiInputBase-root': { backgroundColor: '#fffde7' } }}
              >
                {sparkBatches.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {batchLabel(item)}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
          )}

          <Divider />

          {/* Pricing */}
          <TextField
            label="Price"
            type="number"
            value={price ?? ''}
            onChange={(e) =>
              setTypedPrice({
                value: e.target.value === '' ? null : Number(e.target.value),
                autoPrice,
              })
            }
            fullWidth
            disabled={form.isDonation ?? false}
            error={needsPrice}
            helperText={form.isDonation ? 'Donations go on the Donations tab at $0' : undefined}
            inputProps={{ min: 0, step: 0.01 }}
            slotProps={{ input: { startAdornment: <Typography mr={0.5}>$</Typography> } }}
            sx={{ '& .MuiInputBase-root': { backgroundColor: '#e3f2fd' } }}
          />

          {needsPrice && (
            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => setForm((prev) => ({ ...prev, isDonation: true }))}
                >
                  Mark as donation
                </Button>
              }
            >
              No price. Enter one, or mark this order as a donation.
            </Alert>
          )}

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
                  checked={form.deliveryType === 'Drop'}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, deliveryType: e.target.checked ? 'Drop' : null }))
                  }
                />
              }
              label="Drop"
            />
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
                    setForm((prev) => ({
                      ...prev,
                      deliveryType: e.target.checked ? 'Pickup' : null,
                    }))
                  }
                />
              }
              label="Pickup"
            />
          </Box>

          <Divider />

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

          {success && warnings.length === 0 && (
            <Alert severity="success">Order submitted successfully!</Alert>
          )}
          {warnings.map((warning) => (
            <Alert key={warning} severity="warning">
              {warning}
            </Alert>
          ))}
          {error && <Alert severity="error">{error}</Alert>}

          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={isPending || orderProblem(order, orderBatches()) !== null}
          >
            {isPending ? 'Submitting...' : 'Submit Order'}
          </Button>
        </Box>
      </Paper>

      <Dialog open={showCustomPricingDialog} onClose={handleCustomPricingNo}>
        <DialogTitle>Custom Order?</DialogTitle>
        <DialogContent>
          <Typography>
            {form.name} has custom pricing (${CUSTOMER_PRICING[form.name ?? '']} / can). Is this a
            custom order?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCustomPricingNo}>No</Button>
          <Button onClick={handleCustomPricingYes} variant="contained">
            Yes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!duplicateMessage} onClose={() => setDuplicateMessage(null)}>
        <DialogTitle>Duplicate Order🦫 </DialogTitle>
        <DialogContent>
          <Typography>{duplicateMessage} Do you want to submit anyway?</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDuplicateMessage(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setDuplicateMessage(null)
              submitOrder(true)
            }}
          >
            Submit Anyway
          </Button>
        </DialogActions>
      </Dialog>

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
