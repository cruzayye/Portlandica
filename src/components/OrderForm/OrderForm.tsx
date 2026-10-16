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
import { createOrder, getOrderFormData } from '@/app/actions/orders'
import OrderStatus from '@/components/OrderHistory/OrderStatus'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { batchLabel, batchesForCustomer, chosenBatchId, customBatches } from '@/lib/batches'
import { STEP_ORDER } from '@/lib/db/orders'
import type { SalesOrderWithLines } from '@/lib/db/types'
import { defaultDeliveryDate } from '@/lib/delivery'
import { CANS_PER_CASE, DEFAULT_PRICE_PER_CAN } from '@/globals/constants'
import {
  PRODUCT_NAMES,
  autoTotal,
  linePrices,
  orderProblem,
  shortfallMessage,
  shortfalls,
  toCans,
  typedLineAmounts,
} from '@/lib/orders'
import type {
  BatchOption,
  CustomerOption,
  CustomerType,
  FormDeliveryType,
  OrderFormData,
  OrderInput,
  OrderLineInput,
  OrderProduct,
  Shortfall,
  SubmitOptions,
} from '@/types/orders'

// What the form holds. Quantities, batch picks and a typed price are kept apart; the
// order sent to the server is worked out from all of them on every render.
type Fields = {
  customerType: CustomerType
  /** The customer picked from the list (Existing business). */
  customerId: number | null
  name: string
  businessType: string | null
  streetAddress: string
  city: string
  state: string
  zip: string
  /** Individual (DTC): where to deliver, for the Trello card. */
  deliveryAddress: string
  email: string
  poNumber: string
  isStill: boolean
  isSpark: boolean
  isPaid: boolean
  createInvoice: boolean
  isDonation: boolean
  deliveryType: FormDeliveryType | null
  notes: string
}

const emptyFields: Fields = {
  customerType: 'existing',
  customerId: null,
  name: '',
  businessType: null,
  streetAddress: '',
  city: '',
  state: '',
  zip: '',
  deliveryAddress: '',
  email: '',
  poNumber: '',
  isStill: false,
  isSpark: false,
  isPaid: false,
  createInvoice: false,
  isDonation: false,
  deliveryType: null,
  notes: '',
}

const noQuantity = { still: '', spark: '' }
const noBatchPick: { still: number | ''; spark: number | '' } = { still: '', spark: '' }

type Retry = Omit<SubmitOptions, 'idempotencyKey'>

/**
 * One key per order. A retry of the same order sends it again, so the server finishes
 * that order instead of booking a second one; a saved order gets the form a new key.
 */
const newOrderKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`

const money = (dollars: number) =>
  dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const trimmed = (value: string) => value.trim() || null

export default function OrderForm() {
  const [data, setData] = useState<OrderFormData | null>(null)
  const [loads, setLoads] = useState(0)
  const [fields, setFields] = useState<Fields>(emptyFields)
  // What was typed in each quantity box: cases, or single cans when manualNumber is on.
  const [quantity, setQuantity] = useState(noQuantity)
  const [manualNumber, setManualNumber] = useState(false)
  const [batchPick, setBatchPick] = useState(noBatchPick)
  const [typedPrice, setTypedPrice] = useState<{
    value: number | null
    autoPrice: number | null
  } | null>(null)
  const [deliveryDate, setDeliveryDate] = useState(() => defaultDeliveryDate(new Date()))
  const [orderKey, setOrderKey] = useState(newOrderKey)
  const [lastRetry, setLastRetry] = useState<Retry>({})
  const [saved, setSaved] = useState<{ order: SalesOrderWithLines; warnings: string[] } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null)
  const [shortConfirm, setShortConfirm] = useState<Shortfall[] | null>(null)
  const [showAppScriptDialog, setShowAppScriptDialog] = useState(false)
  const [isPending, startTransition] = useTransition()
  const customBusinessTypeRef = useRef<HTMLInputElement>(null)

  const customers = data?.customers ?? []
  const businessTypes = data?.businessTypes ?? []
  const batches = data?.batches ?? []
  const customer =
    fields.customerType === 'existing'
      ? (customers.find((c) => c.id === fields.customerId) ?? null)
      : null

  // House stock, plus this customer's own custom cans (by customer id, never by name).
  const offered = {
    still: batchesForCustomer(batches, 'still', customer?.id ?? null),
    spark: batchesForCustomer(batches, 'sparkling', customer?.id ?? null),
  }
  const batchId = {
    still: chosenBatchId(batchPick.still, offered.still, customBatches(offered.still)),
    spark: chosenBatchId(batchPick.spark, offered.spark, customBatches(offered.spark)),
  }
  const cans = {
    still: toCans(quantity.still, manualNumber),
    spark: toCans(quantity.spark, manualNumber),
  }
  const lines: OrderLineInput[] = [
    ...(fields.isStill
      ? [
          {
            product: 'still' as const,
            cans: cans.still,
            batchId: batchId.still === '' ? null : batchId.still,
          },
        ]
      : []),
    ...(fields.isSpark
      ? [
          {
            product: 'sparkling' as const,
            cans: cans.spark,
            batchId: batchId.spark === '' ? null : batchId.spark,
          },
        ]
      : []),
  ]
  const totalCans = lines.reduce((sum, line) => sum + (line.cans ?? 0), 0)

  // Each line has its own price per can: a customer's custom cans at their agreed price,
  // house stock at $1.50 unless their price isn't tied to custom cans. It follows from the
  // batches picked, so there's no "Custom order?" prompt.
  const pricedLines = lines.filter((line) => (line.cans ?? 0) > 0)
  const lineCans = pricedLines.map((line) => line.cans ?? 0)
  const pricePerCan = linePrices(pricedLines, batches, customer)
  const autoPrice = autoTotal(lineCans, pricePerCan)
  // A donation is always $0. Otherwise a typed-in price holds until the automatic price
  // changes (cans, customer or batch); then the automatic price takes over again.
  const price = fields.isDonation
    ? 0
    : typedPrice && typedPrice.autoPrice === autoPrice
      ? typedPrice.value
      : autoPrice
  const typedOver =
    !fields.isDonation &&
    autoPrice !== null &&
    price !== null &&
    price > 0 &&
    Math.round(price * 100) !== Math.round(autoPrice * 100)
  // A sale with cans but no price is either a donation or a mistake.
  const needsPrice = !fields.isDonation && totalCans > 0 && !((price ?? 0) > 0)
  const createInvoice = fields.createInvoice && !fields.isDonation

  const order: OrderInput = {
    customerType: fields.customerType,
    customerId: customer?.id ?? null,
    name: fields.name,
    businessType: fields.customerType === 'new' ? trimmed(fields.businessType ?? '') : null,
    streetAddress: fields.customerType === 'new' ? trimmed(fields.streetAddress) : null,
    city: fields.customerType === 'new' ? trimmed(fields.city) : null,
    state: fields.customerType === 'new' ? trimmed(fields.state) : null,
    zip: fields.customerType === 'new' ? trimmed(fields.zip) : null,
    deliveryAddress:
      fields.customerType === 'existing'
        ? trimmed(customer?.address ?? '')
        : fields.customerType === 'individual'
          ? trimmed(fields.deliveryAddress)
          : null,
    email: createInvoice ? trimmed(fields.email) : null,
    poNumber: createInvoice ? trimmed(fields.poNumber) : null,
    lines,
    price,
    isPaid: fields.isPaid,
    createInvoice,
    isDonation: fields.isDonation,
    deliveryType: fields.deliveryType,
    deliveryDate,
    notes: trimmed(fields.notes),
  }
  const problem = orderProblem(order)
  const short = shortfalls(lines, batches)

  const knownCustomer =
    fields.customerType === 'new' && fields.name.trim()
      ? customers.find((c) => sameName(c.name, fields.name))
      : undefined
  const noCustomBatch =
    customer?.custom_cans && !batches.some((b) => b.isCustom && b.customer_id === customer.id)

  const isCustomBusinessType =
    !businessTypes.includes(fields.businessType ?? '') && fields.businessType !== null

  useEffect(() => {
    if (isCustomBusinessType) customBusinessTypeRef.current?.focus()
  }, [isCustomBusinessType])

  useEffect(() => {
    let current = true
    getOrderFormData()
      .then((result) => {
        if (!current) return
        if (isAuthFailure(result)) setError(result.authError)
        else setData(result)
      })
      .catch(() => {
        if (current) setError("Couldn't load customers and batches. Reload the page.")
      })
    return () => {
      current = false
    }
  }, [loads])

  const set = (patch: Partial<Fields>) => setFields((prev) => ({ ...prev, ...patch }))

  // Each choice shows its own fields. Switching clears what the new choice hides, and the
  // name too when moving to or from Existing, which is picked from a list instead of typed.
  const changeCustomerType = (customerType: CustomerType) => {
    setFields((prev) => ({
      ...prev,
      customerType,
      customerId: null,
      name: prev.customerType === 'existing' || customerType === 'existing' ? '' : prev.name,
      businessType: null,
      streetAddress: '',
      city: '',
      state: '',
      zip: '',
      deliveryAddress: '',
      email: '',
    }))
    setBatchPick(noBatchPick)
  }

  // Another customer means other batches on offer, maybe another price, and their email.
  const pickCustomer = (option: CustomerOption | null) => {
    set({ customerId: option?.id ?? null, name: option?.name ?? '', email: option?.email ?? '' })
    setBatchPick(noBatchPick)
  }

  const switchToExisting = (option: CustomerOption) => {
    changeCustomerType('existing')
    pickCustomer(option)
  }

  // Switching a product off clears its quantity and batch, so nothing hidden gets ordered.
  const toggleProduct = (product: 'still' | 'spark') => (on: boolean) => {
    set(product === 'still' ? { isStill: on } : { isSpark: on })
    if (!on) {
      setQuantity((prev) => ({ ...prev, [product]: '' }))
      setBatchPick((prev) => ({ ...prev, [product]: '' }))
    }
  }

  const text = (field: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set({ [field]: e.target.value })

  const startOver = () => {
    setFields(emptyFields)
    setQuantity(noQuantity)
    setManualNumber(false)
    setBatchPick(noBatchPick)
    setTypedPrice(null)
    setDeliveryDate(defaultDeliveryDate(new Date()))
    setOrderKey(newOrderKey())
  }

  const submit = (retry: Retry = {}, key = orderKey) => {
    setError(null)
    setLastRetry(retry)
    const wasNewBusiness = fields.customerType === 'new'
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof createOrder>>
      try {
        result = await createOrder(order, { ...retry, idempotencyKey: key })
      } catch {
        // The request itself failed, so there's no telling whether the order was saved.
        startTransition(() =>
          setError(
            "Couldn't reach the server to confirm the order was saved. Submit again: the same order is never booked twice."
          )
        )
        return
      }
      // Updates after an await need their own transition to land with the end of this one.
      startTransition(() => {
        if (isAuthFailure(result)) setError(result.authError)
        else if (result.status === 'duplicate') setDuplicateMessage(result.message)
        else if (result.status === 'short') setShortConfirm(result.shortfalls)
        else if (result.status === 'already_saved') {
          // That order is real. Anything submitted from here on is a new one.
          setError(result.message)
          setOrderKey(newOrderKey())
        } else if (result.status === 'failed') setError(result.message)
        else {
          // Saved, even if a later step needs a retry: start a fresh order.
          setSaved({ order: result.order, warnings: result.warnings })
          startOver()
          setLoads((n) => n + 1)
          if (wasNewBusiness) setShowAppScriptDialog(true)
        }
      })
    })
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (short.length) setShortConfirm(short)
    else submit()
  }

  const productFields = (key: 'still' | 'spark', product: OrderProduct, title: string) => {
    const options: BatchOption[] = offered[key]
    const picked = batchId[key]
    const needsBatch = options.length > 1 && picked === ''
    const noBatches = options.length === 0
    const line = lines.find((l) => l.product === product)
    const lineShort = short.find((s) => s.batchId === line?.batchId)
    const help = noBatches
      ? `No ${title} batches in inventory. Add one on the Inventory tab first.`
      : needsBatch
        ? 'Select which batch this order pulls from'
        : lineShort
          ? `${shortfallMessage(lineShort)} You'll be asked to confirm.`
          : ' '
    return (
      <Box display="flex" flexDirection="column" gap={1}>
        <TextField
          label={manualNumber ? `Total ${title} Cans` : `Total ${title} Cases`}
          type="number"
          required
          value={quantity[key]}
          onChange={(e) => setQuantity((prev) => ({ ...prev, [key]: e.target.value }))}
          helperText={
            manualNumber
              ? 'Single cans, not cases'
              : cans[key]
                ? `= ${cans[key].toLocaleString('en-US')} cans`
                : `Cases of ${CANS_PER_CASE} cans`
          }
          slotProps={{ htmlInput: { min: 0 } }}
          sx={{ '& .MuiInputBase-root': { backgroundColor: '#e3f2fd' } }}
        />
        <TextField
          select
          label={`${title} batch`}
          value={picked}
          onChange={(e) => setBatchPick((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
          fullWidth
          required={options.length > 1}
          error={needsBatch || noBatches}
          helperText={help}
          slotProps={{
            formHelperText: {
              sx: lineShort && !needsBatch ? { color: 'warning.dark' } : undefined,
            },
          }}
          sx={{ '& .MuiInputBase-root': { backgroundColor: '#fffde7' } }}
        >
          {options.map((batch) => (
            <MenuItem key={batch.id} value={batch.id} sx={{ whiteSpace: 'normal' }}>
              {batchLabel(batch)}
            </MenuItem>
          ))}
        </TextField>
      </Box>
    )
  }

  // Under the Price: what each line costs, or how a typed price is split over the lines.
  const priceNote = () => {
    if (autoPrice === null) return undefined
    if (typedOver) {
      if (pricedLines.length === 1) return `Typed price (automatic: ${money(autoPrice)})`
      const amounts = typedLineAmounts(lineCans, pricePerCan, price!)
      const split = pricedLines
        .map((line, i) => `${PRODUCT_NAMES[line.product]} ${money(amounts[i])}`)
        .join(' · ')
      return `Typed price, split in proportion to each line's automatic price: ${split} (automatic: ${money(autoPrice)})`
    }
    return pricedLines
      .map((line, i) => {
        const whose =
          customer && pricePerCan[i] !== DEFAULT_PRICE_PER_CAN ? ` (${customer.name}'s price)` : ''
        return `${PRODUCT_NAMES[line.product]}: ${lineCans[i].toLocaleString('en-US')} cans at ${money(pricePerCan[i])}${whose}`
      })
      .join(' · ')
  }

  const deliverySwitch = (type: FormDeliveryType) => (
    <FormControlLabel
      key={type}
      control={
        <Switch
          checked={fields.deliveryType === type}
          onChange={(e) => set({ deliveryType: e.target.checked ? type : null })}
        />
      }
      label={type}
    />
  )

  return (
    <>
      <Paper elevation={2} sx={{ p: { xs: 2, sm: 4 }, maxWidth: 560, width: '100%' }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h5" fontWeight={600}>
            New Order
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={fields.isDonation}
                onChange={(e) => set({ isDonation: e.target.checked })}
              />
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
          value={fields.customerType}
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
          {data?.warnings.map((warning) => (
            <Alert key={warning} severity="warning">
              {warning}
            </Alert>
          ))}

          {/* Customer */}
          {fields.customerType === 'existing' ? (
            <Box display="flex" flexDirection="column" gap={1}>
              <Autocomplete
                options={customers}
                getOptionLabel={(option) => option.name}
                getOptionKey={(option) => option.id}
                value={customer}
                onChange={(_, value) => pickCustomer(value)}
                renderInput={(params) => <TextField {...params} label="Name" required />}
                fullWidth
              />
              {customer?.address && (
                <Typography variant="body2" color="text.secondary">
                  {customer.address}
                </Typography>
              )}
              {noCustomBatch && (
                <Alert severity="info">
                  No custom-can batch is linked to {customer?.name} yet, so only house stock is
                  offered.
                </Alert>
              )}
            </Box>
          ) : (
            <TextField
              label={fields.customerType === 'new' ? 'New Business Name' : 'Customer Name'}
              value={fields.name}
              onChange={text('name')}
              fullWidth
              required
            />
          )}

          {knownCustomer && (
            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => switchToExisting(knownCustomer)}
                >
                  Pick them
                </Button>
              }
            >
              {knownCustomer.name} is already a customer.
            </Alert>
          )}

          {fields.customerType === 'new' && (
            <>
              <TextField
                select
                label="Type of Business"
                value={
                  businessTypes.includes(fields.businessType ?? '')
                    ? (fields.businessType ?? '')
                    : fields.businessType !== null
                      ? 'Other'
                      : ''
                }
                onChange={(e) =>
                  set({ businessType: e.target.value === 'Other' ? '' : e.target.value })
                }
                fullWidth
              >
                {businessTypes.map((type) => (
                  <MenuItem key={type} value={type}>
                    {type}
                  </MenuItem>
                ))}
                <MenuItem value="Other">Other</MenuItem>
              </TextField>
              {isCustomBusinessType && (
                <TextField
                  label="Specify Business Type"
                  value={fields.businessType ?? ''}
                  onChange={text('businessType')}
                  fullWidth
                  inputRef={customBusinessTypeRef}
                />
              )}
              <TextField
                label="Street Address"
                value={fields.streetAddress}
                onChange={text('streetAddress')}
                fullWidth
              />
              <Box display="flex" gap={2}>
                <TextField
                  label="City"
                  value={fields.city}
                  onChange={text('city')}
                  sx={{ flex: 2 }}
                />
                <TextField
                  label="State"
                  value={fields.state}
                  onChange={text('state')}
                  sx={{ flex: 1 }}
                />
                <TextField label="Zip" value={fields.zip} onChange={text('zip')} sx={{ flex: 1 }} />
              </Box>
            </>
          )}

          {fields.customerType === 'individual' && (
            <TextField
              label="Delivery Address"
              value={fields.deliveryAddress}
              onChange={text('deliveryAddress')}
              helperText="Optional. Goes on the Trello card."
              fullWidth
            />
          )}

          <Divider />

          {/* Water type */}
          <Typography variant="subtitle2" color="text.secondary">
            Water Type
          </Typography>

          <Box display="flex" gap={2} flexWrap="wrap">
            <FormControlLabel
              control={
                <Switch
                  checked={fields.isStill}
                  onChange={(e) => toggleProduct('still')(e.target.checked)}
                />
              }
              label="Still"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={fields.isSpark}
                  onChange={(e) => toggleProduct('spark')(e.target.checked)}
                />
              }
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

          {fields.isStill && productFields('still', 'still', 'Still')}
          {fields.isSpark && productFields('spark', 'sparkling', 'Sparkling')}

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
            disabled={fields.isDonation}
            error={needsPrice}
            helperText={fields.isDonation ? 'Donations go on the Donations tab at $0' : priceNote()}
            slotProps={{
              htmlInput: { min: 0, step: 0.01 },
              input: { startAdornment: <Typography mr={0.5}>$</Typography> },
            }}
            sx={{ '& .MuiInputBase-root': { backgroundColor: '#e3f2fd' } }}
          />

          {needsPrice && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={() => set({ isDonation: true })}>
                  Mark as donation
                </Button>
              }
            >
              No price. Enter one, or mark this order as a donation.
            </Alert>
          )}

          <Box display="flex" gap={2} flexWrap="wrap">
            <FormControlLabel
              control={
                <Switch
                  checked={fields.isPaid}
                  onChange={(e) => set({ isPaid: e.target.checked })}
                />
              }
              label="Paid"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={createInvoice}
                  disabled={fields.isDonation}
                  onChange={(e) => set({ createInvoice: e.target.checked })}
                />
              }
              label="Create Invoice"
            />
          </Box>

          {createInvoice && (
            <>
              {data && !data.squareReady && (
                <Alert severity="info">
                  Square isn&apos;t set up in this app yet, so no draft invoice will be made.
                </Alert>
              )}
              <TextField
                label="PO Number"
                value={fields.poNumber}
                onChange={text('poNumber')}
                helperText="Optional. Shows on the invoice."
                fullWidth
              />
              <TextField
                label="Billing Email"
                type="email"
                value={fields.email}
                onChange={text('email')}
                helperText={
                  fields.customerType === 'individual'
                    ? 'Optional. Where the invoice goes.'
                    : 'Optional. Saved on the customer for next time.'
                }
                fullWidth
              />
            </>
          )}

          <Divider />
          <Typography variant="subtitle2" color="text.secondary">
            Delivery
          </Typography>

          <Box display="flex" gap={2} flexWrap="wrap">
            {(['Drop', 'Ship', 'Pickup'] as const).map(deliverySwitch)}
          </Box>

          <TextField
            label="Delivery Date"
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            required
            helperText="Sets the Trello due date (9 AM that day)."
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />

          <Divider />

          {/* Notes */}
          <TextField
            label="Notes"
            value={fields.notes}
            onChange={text('notes')}
            fullWidth
            multiline
            rows={3}
          />

          {saved && (
            <Box display="flex" flexDirection="column" gap={1}>
              <Alert
                severity={
                  STEP_ORDER.some((step) => saved.order[`${step}_status`] === 'failed')
                    ? 'warning'
                    : 'success'
                }
              >
                Order #{saved.order.id} saved for {saved.order.customer_name}.
              </Alert>
              <OrderStatus
                order={saved.order}
                onChange={(next) => setSaved((prev) => prev && { ...prev, order: next })}
              />
              {saved.warnings.map((warning) => (
                <Alert key={warning} severity="info">
                  {warning}
                </Alert>
              ))}
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}

          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={isPending || problem !== null}
          >
            {isPending ? 'Submitting...' : 'Submit Order'}
          </Button>
        </Box>
      </Paper>

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
              // A second order on purpose: it gets its own key.
              const key = newOrderKey()
              setOrderKey(key)
              submit({ ...lastRetry, force: true }, key)
            }}
          >
            Submit Anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!shortConfirm} onClose={() => setShortConfirm(null)}>
        <DialogTitle>Not enough cans in the batch</DialogTitle>
        <DialogContent>
          {shortConfirm?.map((s) => (
            <Typography key={s.batchId} gutterBottom>
              {shortfallMessage(s)}
            </Typography>
          ))}
          <Typography>
            Book it anyway? The batch count goes below zero until it is fixed.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShortConfirm(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setShortConfirm(null)
              submit({ ...lastRetry, allowOversell: true })
            }}
          >
            Book Anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={showAppScriptDialog} onClose={() => setShowAppScriptDialog(false)}>
        <DialogTitle>New Business Added</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>
            Be sure to run App Scripts —{' '}
            <Link
              href="https://docs.google.com/spreadsheets/d/1bIwlYpMhAHQiXHFHs1yY0EEwjrDbIChbrxtVl17P-sw/edit?gid=1985380506#gid=1985380506"
              target="_blank"
              rel="noopener noreferrer"
            >
              open the sheet
            </Link>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The app now fills in the latitude and longitude itself when it finds the address. App
            Scripts still updates the store-locator map.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowAppScriptDialog(false)}>Dismiss</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
