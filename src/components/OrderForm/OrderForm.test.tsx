import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BatchOption, OrderFormData, OrderInput } from '@/types/orders'
import type { SalesOrderWithLines } from '@/lib/db/types'
import { defaultDeliveryDate } from '@/lib/delivery'

const getOrderFormData = vi.fn()
const createOrder = vi.fn()
const retryOrder = vi.fn()

vi.mock('@/app/actions/orders', () => ({
  getOrderFormData: () => getOrderFormData(),
  createOrder: (...args: unknown[]) => createOrder(...args),
}))
vi.mock('@/app/actions/orderHistory', () => ({
  retryOrder: (...args: unknown[]) => retryOrder(...args),
}))

import OrderForm from './OrderForm'

const DAME = 1
const HOLLYWOOD = 2

const batch = (over: Partial<BatchOption> & { id: number }): BatchOption => ({
  name: 'Portlandica',
  count: 12000,
  isCustom: false,
  isStill: true,
  customer_id: null,
  fillDate: '2026-09-26',
  source: null,
  ...over,
})

const formData = (over: Partial<OrderFormData> = {}): OrderFormData => ({
  customers: [
    {
      id: DAME,
      name: 'Dame',
      business_type: 'Restaurant',
      price_per_can: null,
      custom_cans: false,
      email: null,
      address: '123 NE Broadway',
    },
    {
      id: HOLLYWOOD,
      name: 'Hollywood Theatre',
      business_type: 'Theater',
      price_per_can: 1.66,
      custom_cans: true,
      email: 'ap@hollywood.example',
      address: '4122 NE Sandy Blvd',
    },
  ],
  businessTypes: ['Restaurant', 'Theater'],
  batches: [batch({ id: 45 }), batch({ id: 25, name: 'North Powder', isStill: false })],
  squareReady: false,
  warnings: [],
  ...over,
})

const savedOrder = (over: Partial<SalesOrderWithLines> = {}): SalesOrderWithLines =>
  ({
    id: 12,
    customer_name: 'Dame',
    sheet_status: 'done',
    sheet_error: null,
    sheet_ref: 'Sales!A3126:V3126',
    inventory_status: 'done',
    inventory_error: null,
    trello_status: 'done',
    trello_error: null,
    trello_card_id: 'card-1',
    square_status: 'skipped',
    square_error: null,
    square_invoice_id: null,
    create_invoice: false,
    voided_at: null,
    lines: [],
    ...over,
  }) as SalesOrderWithLines

type User = ReturnType<typeof userEvent.setup>

const renderForm = async (data = formData()) => {
  getOrderFormData.mockResolvedValue(data)
  render(<OrderForm />)
  await waitFor(() => expect(getOrderFormData).toHaveBeenCalled())
}

const pickCustomer = async (user: User, name: string) => {
  // Name is a MUI Autocomplete: it commits only when an option is chosen.
  await user.click(screen.getByLabelText(/^name/i))
  await user.click(await screen.findByRole('option', { name }))
}

const fillRequiredFields = async (user: User, customer = 'Dame') => {
  await pickCustomer(user, customer)
  await user.click(screen.getByLabelText('Still'))
  await user.type(screen.getByLabelText(/total still cases/i), '5')
  await user.click(screen.getByLabelText('Drop'))
}

const submitButton = () => screen.getByRole('button', { name: /submit order/i })
const sent = (call = 0) => createOrder.mock.calls[call][0] as OrderInput
const sentOptions = (call = 0) => createOrder.mock.calls[call][1]

beforeEach(() => {
  getOrderFormData.mockReset()
  createOrder.mockReset()
  retryOrder.mockReset()
  createOrder.mockResolvedValue({
    status: 'saved',
    order: savedOrder(),
    warnings: [],
    shortfalls: [],
  })
})

describe('OrderForm batch selection', () => {
  const twoStillBatches = formData({
    batches: [batch({ id: 1, fillDate: '2026-06-20' }), batch({ id: 2, fillDate: '2026-08-03' })],
  })

  it('blocks submit while several still batches are unresolved', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(twoStillBatches)
    await fillRequiredFields(user)

    expect(submitButton()).toBeDisabled()
    expect(screen.getByText(/select which batch this order pulls from/i)).toBeInTheDocument()
  })

  it('sends the batch the user picks', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(twoStillBatches)
    await fillRequiredFields(user)

    await user.click(screen.getByLabelText(/still batch/i))
    await user.click(await screen.findByRole('option', { name: /2026-08-03/ }))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().lines).toEqual([{ product: 'still', cans: 120, batchId: 2 }])
  })

  it('shows how many cans are left in each batch', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 1, count: 1440, source: 'Opal Springs' }),
          batch({ id: 2, count: 960 }),
        ],
      })
    )
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText(/still batch/i))

    expect(
      await screen.findByRole('option', {
        name: 'Portlandica Still · 2026-09-26 · 1,440 left · Opal Springs',
      })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /960 left/ })).toBeInTheDocument()
  })

  it("picks the customer's own custom cans, matched by customer id", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 1 }),
          batch({ id: 2 }),
          batch({ id: 9, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
        ],
      })
    )
    await fillRequiredFields(user, 'Hollywood Theatre')

    await waitFor(() => expect(submitButton()).toBeEnabled())
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().lines).toEqual([{ product: 'still', cans: 120, batchId: 9 }])
  })

  it("never offers someone else's custom cans or unlinked ones", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 1 }),
          batch({ id: 7, name: 'Dame', isCustom: true, customer_id: null }),
          batch({ id: 8, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
        ],
      })
    )
    await fillRequiredFields(user)

    // Only house stock is left, so it's picked and nothing else is offered.
    await user.click(screen.getByLabelText(/still batch/i))
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Portlandica Still · 2026-09-26 · 12,000 left',
    ])
  })

  it('offers the dog water batch with house still stock and sells it at the house price', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 45 }),
          batch({ id: 33, name: 'Portlandica Dog water', count: 2376, fillDate: '2026-08-25' }),
        ],
      })
    )
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText(/still batch/i))
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Portlandica Still · 2026-09-26 · 12,000 left',
      'Portlandica Dog water Still · 2026-08-25 · 2,376 left',
    ])
    await user.click(screen.getByRole('option', { name: /Dog water/ }))
    expect(screen.getByLabelText('Price')).toHaveValue(180)

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().lines).toEqual([{ product: 'still', cans: 120, batchId: 33 }])
  })

  it('says when a custom-can customer has no custom batch linked yet', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await pickCustomer(user, 'Hollywood Theatre')
    expect(
      screen.getByText(/No custom-can batch is linked to Hollywood Theatre yet/)
    ).toBeInTheDocument()
  })

  it('sends only the Sparkling line for a Sparkling-only order', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await pickCustomer(user, 'Dame')
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')
    await user.click(screen.getByLabelText('Drop'))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().lines).toEqual([{ product: 'sparkling', cans: 48, batchId: 25 }])
  })

  it('blocks submit when a product has no batches at all', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(formData({ batches: [batch({ id: 45 })] }))
    await fillRequiredFields(user)
    expect(submitButton()).toBeEnabled()

    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')

    expect(screen.getByText(/No Sparkling batches in inventory/)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })
})

describe('OrderForm when a batch is short', () => {
  const smallBatch = formData({ batches: [batch({ id: 45, count: 100 })] })

  it('warns, asks before booking, and books it once confirmed', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(smallBatch)
    await fillRequiredFields(user)

    expect(
      screen.getByText(
        /Portlandica Still has 100 cans left; this order needs 120\. You'll be asked/
      )
    ).toBeInTheDocument()
    expect(submitButton()).toBeEnabled()

    await user.click(submitButton())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/has 100 cans left; this order needs 120/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(createOrder).not.toHaveBeenCalled()

    await user.click(submitButton())
    await user.click(await screen.findByRole('button', { name: 'Book Anyway' }))
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sentOptions()).toMatchObject({ allowOversell: true })
  })

  it('asks the same when the server finds the batch short, keeping the order key', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockResolvedValueOnce({
      status: 'short',
      shortfalls: [{ batchId: 45, batchName: 'Portlandica Still', available: 60, needed: 120 }],
    })
    await renderForm()
    await fillRequiredFields(user)
    await user.click(submitButton())

    await user.click(await screen.findByRole('button', { name: 'Book Anyway' }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    expect(sentOptions(1)).toEqual({
      allowOversell: true,
      idempotencyKey: sentOptions(0).idempotencyKey,
    })
  })
})

describe('OrderForm submit results', () => {
  const submitDameOrder = async (user: User) => {
    await renderForm()
    await fillRequiredFields(user)
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
  }

  it('shows how each step went, starts a fresh order and reloads the batches', async () => {
    const user = userEvent.setup({ delay: null })
    await submitDameOrder(user)

    expect(await screen.findByText('Order #12 saved for Dame.')).toBeInTheDocument()
    expect(screen.getByText('Sales sheet: done')).toBeInTheDocument()
    expect(screen.getByText('Sales sheet: Sales row 3126')).toBeInTheDocument()
    expect(screen.getByText('Square: skipped')).toBeInTheDocument()
    expect(screen.getByLabelText(/^name/i)).toHaveValue('')
    await waitFor(() => expect(getOrderFormData).toHaveBeenCalledTimes(2))

    // The next order gets its own key.
    await fillRequiredFields(user)
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    expect(sentOptions(1).idempotencyKey).not.toBe(sentOptions(0).idempotencyKey)
  })

  it('offers a retry for a step that failed', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockResolvedValue({
      status: 'saved',
      order: savedOrder({
        trello_status: 'failed',
        trello_error: 'Trello API error: 503',
        trello_card_id: null,
      }),
      warnings: [],
      shortfalls: [],
    })
    retryOrder.mockResolvedValue({
      status: 'done',
      order: savedOrder(),
      warnings: [],
      shortfalls: [],
    })
    await submitDameOrder(user)

    expect(await screen.findByText('Trello: Trello API error: 503')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry Trello' }))

    await waitFor(() =>
      expect(retryOrder).toHaveBeenCalledWith(12, { allowNegativeInventory: false })
    )
    expect(await screen.findByText('Trello: done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument()
  })

  it('keeps the form and the order key when the order was not saved', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockResolvedValueOnce({
      status: 'failed',
      message: "The order wasn't saved (network). Submitting again is safe.",
    })
    await submitDameOrder(user)

    expect(await screen.findByText(/Submitting again is safe/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Dame')
    await user.click(await screen.findByRole('button', { name: /submit order/i }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    expect(sentOptions(1).idempotencyKey).toBe(sentOptions(0).idempotencyKey)
  })

  it('says a resubmit is safe when the server cannot be reached', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockRejectedValueOnce(
      new Error('An error occurred in the Server Components render.')
    )
    await submitDameOrder(user)

    expect(
      await screen.findByText(/Submit again: the same order is never booked twice/)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Dame')
  })

  it('books a second order today only when asked, under a new key', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockResolvedValueOnce({
      status: 'duplicate',
      message: 'Dame already has an order today (order #11).',
    })
    await submitDameOrder(user)

    expect(await screen.findByText(/already has an order today \(order #11\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Submit Anyway' }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    expect(sentOptions(1)).toMatchObject({ force: true })
    expect(sentOptions(1).idempotencyKey).not.toBe(sentOptions(0).idempotencyKey)
  })

  it('moves to a new key when its key already saved a different order', async () => {
    const user = userEvent.setup({ delay: null })
    createOrder.mockResolvedValueOnce({
      status: 'already_saved',
      orderId: 11,
      message: 'This form already saved order #11 with different details.',
    })
    await submitDameOrder(user)

    expect(await screen.findByText(/already saved order #11/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: /submit order/i }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    expect(sentOptions(1).idempotencyKey).not.toBe(sentOptions(0).idempotencyKey)
  })
})

describe('OrderForm customers', () => {
  it("sends an existing customer's address for the card and keeps Notes for notes", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)

    expect(screen.getByText('123 NE Broadway')).toBeInTheDocument()
    expect(screen.getByLabelText(/notes/i)).toHaveValue('')
    await user.type(screen.getByLabelText(/notes/i), 'Leave at the back door')
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      customerType: 'existing',
      customerId: DAME,
      name: 'Dame',
      deliveryAddress: '123 NE Broadway',
      notes: 'Leave at the back door',
    })
  })

  it('takes a new business with its address', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await user.click(screen.getByRole('button', { name: 'New business' }))
    await user.type(screen.getByLabelText(/new business name/i), 'Baerlic Brewery')
    await user.type(screen.getByLabelText(/street address/i), '2235 SE 11th Ave')
    await user.type(screen.getByLabelText(/city/i), 'Portland')
    await user.type(screen.getByLabelText(/state/i), 'OR')
    await user.type(screen.getByLabelText(/zip/i), '97214')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '2')
    await user.click(screen.getByLabelText('Drop'))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      customerType: 'new',
      customerId: null,
      name: 'Baerlic Brewery',
      streetAddress: '2235 SE 11th Ave',
      city: 'Portland',
      state: 'OR',
      zip: '97214',
      deliveryAddress: null,
    })
    expect(await screen.findByText('New Business Added')).toBeInTheDocument()
    expect(screen.getByText(/App Scripts still updates the store-locator map/)).toBeInTheDocument()
  })

  it('points out a "new" business that is already a customer', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await user.click(screen.getByRole('button', { name: 'New business' }))
    await user.type(screen.getByLabelText(/new business name/i), 'dame ')

    expect(screen.getByText('Dame is already a customer.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pick them' }))
    expect(screen.getByRole('button', { name: 'Existing business' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Dame')
  })

  it("puts an individual's delivery address on the card, not in Notes", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await user.click(screen.getByRole('button', { name: 'Individual (DTC)' }))
    await user.type(screen.getByLabelText(/customer name/i), 'Pat Doe')
    await user.type(screen.getByLabelText(/delivery address/i), '12 SE Ash St, Portland')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '1')
    await user.click(screen.getByLabelText('Pickup'))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      customerType: 'individual',
      name: 'Pat Doe',
      deliveryAddress: '12 SE Ash St, Portland',
      notes: null,
      deliveryType: 'Pickup',
    })
  })

  it('offers one choice of customer type, starting at Existing business', async () => {
    await renderForm()
    expect(screen.getByRole('button', { name: 'Existing business' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.queryByLabelText(/street address/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/delivery address/i)).not.toBeInTheDocument()
  })

  it('drops the picked customer when switching to a typed-in name', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await pickCustomer(user, 'Dame')
    await user.click(screen.getByRole('button', { name: 'New business' }))
    expect(screen.getByLabelText(/new business name/i)).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Existing business' }))
    expect(screen.getByLabelText(/^name/i)).toHaveValue('')
  })

  it('shows problems loading the form', async () => {
    await renderForm(formData({ warnings: ["Couldn't read the Current Locations Addresses tab"] }))
    expect(
      await screen.findByText("Couldn't read the Current Locations Addresses tab")
    ).toBeInTheDocument()
  })
})

describe('OrderForm price', () => {
  it('prices at $1.50 a can by default', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    expect(screen.getByLabelText('Price')).toHaveValue(180)
  })

  it("charges a customer's custom price when their custom cans are picked, without asking", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 1 }),
          batch({ id: 9, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
        ],
      })
    )
    await pickCustomer(user, 'Hollywood Theatre')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '1')

    expect(screen.getByLabelText('Price')).toHaveValue(39.84)
    expect(
      screen.getByText("Still: 24 cans at $1.66 (Hollywood Theatre's price)")
    ).toBeInTheDocument()

    // House stock instead: the default price.
    await user.click(screen.getByLabelText(/still batch/i))
    await user.click(await screen.findByRole('option', { name: /^Portlandica Still/ }))
    expect(screen.getByLabelText('Price')).toHaveValue(36)
    expect(screen.getByText('Still: 24 cans at $1.50')).toBeInTheDocument()
  })

  it('prices a mixed order line by line and shows each line in the total', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 1 }),
          batch({ id: 9, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
          batch({ id: 25, name: 'North Powder', isStill: false }),
        ],
      })
    )
    await pickCustomer(user, 'Hollywood Theatre')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '1')
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')

    // Their custom still cans at $1.66, house sparkling at $1.50.
    expect(screen.getByLabelText('Price')).toHaveValue(111.84)
    expect(
      screen.getByText(
        "Still: 24 cans at $1.66 (Hollywood Theatre's price) · Sparkling: 48 cans at $1.50"
      )
    ).toBeInTheDocument()
  })

  it('says how a typed price is split over the lines', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(
      formData({
        batches: [
          batch({ id: 9, name: 'Hollywood Theatre', isCustom: true, customer_id: HOLLYWOOD }),
          batch({ id: 25, name: 'North Powder', isStill: false }),
        ],
      })
    )
    await pickCustomer(user, 'Hollywood Theatre')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '1')
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')
    await user.click(screen.getByLabelText('Drop'))
    await user.clear(screen.getByLabelText('Price'))
    await user.type(screen.getByLabelText('Price'), '100')

    expect(
      screen.getByText(
        "Typed price, split in proportion to each line's automatic price: Still $35.62 · Sparkling $64.38 (automatic: $111.84)"
      )
    ).toBeInTheDocument()
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      price: 100,
      lines: [
        { product: 'still', cans: 24, batchId: 9 },
        { product: 'sparkling', cans: 48, batchId: 25 },
      ],
    })
  })

  it("charges house stock at the price of a customer who isn't a custom-can account", async () => {
    const user = userEvent.setup({ delay: null })
    const data = formData()
    await renderForm({
      ...data,
      customers: [
        ...data.customers,
        {
          id: 3,
          name: 'Ben Bridge Jeweler (Downtown)',
          business_type: 'Retail',
          price_per_can: 1.35,
          custom_cans: false,
          email: null,
          address: '',
        },
      ],
    })
    await fillRequiredFields(user, 'Ben Bridge Jeweler (Downtown)')

    expect(screen.getByLabelText('Price')).toHaveValue(162)
    expect(
      screen.getByText("Still: 120 cans at $1.35 (Ben Bridge Jeweler (Downtown)'s price)")
    ).toBeInTheDocument()
  })

  it('keeps a typed price until the quantity changes', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)

    await user.clear(screen.getByLabelText('Price'))
    await user.type(screen.getByLabelText('Price'), '150')
    await user.click(screen.getByLabelText(/notes/i))
    expect(screen.getByLabelText('Price')).toHaveValue(150)
    expect(screen.getByText('Typed price (automatic: $180.00)')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/total still cases/i), '0')
    expect(screen.getByLabelText('Price')).toHaveValue(1800)
  })

  it('books a donation at $0 with the price locked and no invoice', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText('Create Invoice'))
    await user.click(screen.getByLabelText('Donut'))

    expect(screen.getByLabelText('Price')).toHaveValue(0)
    expect(screen.getByLabelText('Price')).toBeDisabled()
    expect(screen.getByLabelText('Create Invoice')).toBeDisabled()
    expect(screen.getByLabelText('Create Invoice')).not.toBeChecked()

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({ isDonation: true, price: 0, createInvoice: false })
  })

  it('blocks a sale with no price and offers to mark it a donation', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    await user.clear(screen.getByLabelText('Price'))

    expect(screen.getByText(/No price\. Enter one, or mark this order as a donation/)).toBeVisible()
    expect(submitButton()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Mark as donation' }))
    expect(submitButton()).toBeEnabled()
  })
})

describe('OrderForm invoice details', () => {
  it("asks for a PO number and billing email, filling in the customer's email", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user, 'Hollywood Theatre')
    expect(screen.queryByLabelText(/po number/i)).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Create Invoice'))
    expect(screen.getByText(/Square isn't set up in this app yet/)).toBeInTheDocument()
    expect(screen.getByLabelText(/billing email/i)).toHaveValue('ap@hollywood.example')
    await user.type(screen.getByLabelText(/po number/i), '40012345')
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      createInvoice: true,
      poNumber: '40012345',
      email: 'ap@hollywood.example',
    })
  })

  it("doesn't send invoice details once Create Invoice is off", async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm(formData({ squareReady: true }))
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText('Create Invoice'))
    expect(screen.queryByText(/Square isn't set up/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/po number/i), '123')
    await user.click(screen.getByLabelText('Create Invoice'))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({ createInvoice: false, poNumber: null, email: null })
  })
})

describe('OrderForm delivery date', () => {
  it('starts at the next delivery day and sends the date picked', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    const date = screen.getByLabelText(/delivery date/i)
    expect(date).toHaveValue(defaultDeliveryDate(new Date()))

    await user.clear(date)
    await user.type(date, '2026-12-02')
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().deliveryDate).toBe('2026-12-02')
  })

  it('needs a date', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    await user.clear(screen.getByLabelText(/delivery date/i))
    expect(submitButton()).toBeDisabled()
  })
})

describe('OrderForm quantities', () => {
  it('shows cases as cans and leaves the number alone when focus moves', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)

    const cases = screen.getByLabelText(/total still cases/i)
    expect(screen.getByText('= 120 cans')).toBeInTheDocument()
    // Leaving and re-entering the box used to multiply it by 24 each time.
    await user.click(cases)
    await user.click(screen.getByLabelText(/notes/i))
    await user.click(cases)
    await user.click(screen.getByLabelText(/notes/i))
    expect(cases).toHaveValue(5)
  })

  it('takes single cans with Enter Manual Number on', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)

    await user.click(screen.getByLabelText('Enter Manual Number (cans)'))
    await user.clear(screen.getByLabelText(/total still cans/i))
    await user.type(screen.getByLabelText(/total still cans/i), '130')
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent().lines).toEqual([{ product: 'still', cans: 130, batchId: 45 }])
  })

  it('forgets a quantity once its product is switched off', async () => {
    const user = userEvent.setup({ delay: null })
    await renderForm()
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')
    expect(screen.getByLabelText('Price')).toHaveValue(252)

    await user.click(screen.getByLabelText('Still'))
    expect(screen.getByLabelText('Price')).toHaveValue(72)
    await user.click(screen.getByLabelText('Still'))
    expect(screen.getByLabelText(/total still cases/i)).toHaveValue(null)
    await user.click(screen.getByLabelText('Still'))

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      lines: [{ product: 'sparkling', cans: 48, batchId: 25 }],
      price: 72,
    })
  })
})
