import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Inventory } from '@/types/orders'

const getInventory = vi.fn()
const createOrder = vi.fn()

vi.mock('@/app/actions/inventory', () => ({
  getInventory: () => getInventory(),
}))

vi.mock('@/app/actions/orders', () => ({
  getLocations: () =>
    Promise.resolve([
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
      { name: 'Hollywood Theatre', address: '4122 NE Sandy Blvd', businessType: 'Theater' },
    ]),
  getLocationTypes: () => Promise.resolve([{ name: 'Restaurant' }]),
  createOrder: (...args: unknown[]) => createOrder(...args),
}))

import OrderForm from './OrderForm'

const batch = (over: Partial<Inventory> & { id: number }): Inventory => ({
  created_at: '2026-01-01T00:00:00Z',
  name: 'Original',
  count: 1440,
  isCustom: false,
  isStill: true,
  fillDate: '2026-01-01',
  totalCost: null,
  invoiceNumber: null,
  source: null,
  ...over,
})

const fillRequiredFields = async (user: ReturnType<typeof userEvent.setup>) => {
  // Name is a MUI Autocomplete: it commits only when an option is chosen.
  await user.click(screen.getByLabelText(/name/i))
  await user.click(await screen.findByRole('option', { name: 'Dame' }))
  await user.click(screen.getByLabelText('Still'))
  await user.type(screen.getByLabelText(/total still cases/i), '5')
  await user.click(screen.getByLabelText('Drop'))
}

const submitButton = () => screen.getByRole('button', { name: /submit order/i })

beforeEach(() => {
  getInventory.mockReset()
  createOrder.mockReset()
  createOrder.mockResolvedValue({ status: 'saved', warnings: [] })
})

describe('OrderForm batch selection', () => {
  it('blocks submit while multiple still batches are unresolved', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, fillDate: '2026-06-20' }),
      batch({ id: 2, fillDate: '2026-08-03' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    expect(screen.getByRole('button', { name: /submit order/i })).toBeDisabled()
    expect(screen.getByText(/select which batch this order pulls from/i)).toBeInTheDocument()
  })

  it('enables submit once the user picks a batch', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, fillDate: '2026-06-20' }),
      batch({ id: 2, fillDate: '2026-08-03' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    await user.click(screen.getByLabelText(/batch number/i))
    await user.click(await screen.findByRole('option', { name: /2026-08-03/ }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit order/i })).toBeEnabled(),
    )
  })

  it('does not block submit when only one batch exists', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit order/i })).toBeEnabled(),
    )
    expect(
      screen.queryByText(/select which batch this order pulls from/i),
    ).not.toBeInTheDocument()
  })

  it('auto-selects the customer\'s single custom batch despite other options', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, name: 'Original', fillDate: '2026-06-20' }),
      batch({ id: 2, name: 'Original', fillDate: '2026-08-03' }),
      batch({ id: 9, name: 'Dame', isCustom: true, fillDate: '2026-08-25' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit order/i })).toBeEnabled(),
    )
  })

  it('ignores sparkling ambiguity for a still-only order', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, isStill: true, fillDate: '2026-06-20' }),
      batch({ id: 2, isStill: false, fillDate: '2026-06-20' }),
      batch({ id: 3, isStill: false, fillDate: '2026-08-03' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit order/i })).toBeEnabled(),
    )
  })

  it('submits the chosen batch id to createOrder', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, fillDate: '2026-06-20' }),
      batch({ id: 2, fillDate: '2026-08-03' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    await user.click(screen.getByLabelText(/batch number/i))
    await user.click(await screen.findByRole('option', { name: /2026-08-03/ }))
    await user.click(screen.getByRole('button', { name: /submit order/i }))

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    const [, batches] = createOrder.mock.calls[0]
    expect(batches.still).toEqual({ id: 2, fillDate: '2026-08-03' })
  })

  it('sends only the Sparkling batch for a Sparkling-only order', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, isStill: true, fillDate: '2026-06-20' }),
      batch({ id: 3, isStill: false, fillDate: '2026-08-03' }),
    ])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await user.click(screen.getByLabelText(/name/i))
    await user.click(await screen.findByRole('option', { name: 'Dame' }))
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')
    await user.click(screen.getByLabelText('Drop'))
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    const [, batches] = createOrder.mock.calls[0]
    expect(batches.spark).toEqual({ id: 3, fillDate: '2026-08-03' })
    expect(batches.still).toBeUndefined()
  })

  it('blocks submit when a product has no batches at all', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([batch({ id: 1, isStill: true, fillDate: '2026-06-20' })])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
    expect(submitButton()).toBeEnabled()

    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')

    expect(screen.getByText(/No Sparkling batches in inventory/)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })
})

describe('OrderForm submit results', () => {
  const submitDameOrder = async (user: ReturnType<typeof userEvent.setup>) => {
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
  }

  it('starts a fresh form and shows the warning when a later step failed', async () => {
    const user = userEvent.setup()
    createOrder.mockResolvedValue({
      status: 'saved',
      warnings: [
        'Order saved, but the Trello card failed (Trello API error: 503). Add the card by hand.',
      ],
    })

    await submitDameOrder(user)

    expect(await screen.findByText(/Trello card failed.*Add the card by hand/)).toBeInTheDocument()
    expect(screen.queryByText(/submitted successfully/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
  })

  it('keeps the form and shows the message when the order was not saved', async () => {
    const user = userEvent.setup()
    createOrder.mockResolvedValue({
      status: 'failed',
      message: 'The order may not have been saved: writing to the Google Sheet failed (quota).',
    })

    await submitDameOrder(user)

    expect(await screen.findByText(/may not have been saved/)).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Dame')
  })

  it('asks to check the sheet when the server cannot be reached', async () => {
    const user = userEvent.setup()
    createOrder.mockRejectedValue(new Error('An error occurred in the Server Components render.'))

    await submitDameOrder(user)

    expect(
      await screen.findByText(/Check the Sales sheet before submitting again/)
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Dame')
  })
})

describe('OrderForm existing customer', () => {
  it('keeps the address out of Notes and sends it separately', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)

    expect(screen.getByLabelText(/notes/i)).toHaveValue('')
    await user.type(screen.getByLabelText(/notes/i), 'Leave at the back door')
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    const [order] = createOrder.mock.calls[0]
    expect(order.address).toBe('123 NE Broadway')
    expect(order.notes).toBe('Leave at the back door')
  })
})

describe('OrderForm customer type', () => {
  const renderForm = async () => {
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
  }

  it('offers one choice, starting at Existing business', async () => {
    await renderForm()

    expect(screen.getByRole('button', { name: 'Existing business' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'New business' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Individual (DTC)' })).toBeInTheDocument()
    // The old independent switches are gone.
    expect(screen.queryByLabelText(/^business$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^dtc$/i)).not.toBeInTheDocument()
  })

  it('shows the new-business fields only for New business', async () => {
    const user = userEvent.setup()
    await renderForm()
    expect(screen.queryByLabelText(/street address/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New business' }))
    expect(screen.getByLabelText(/new business name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/type of business/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/street address/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Individual (DTC)' }))
    expect(screen.getByLabelText(/customer name/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/type of business/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/street address/i)).not.toBeInTheDocument()
  })

  it('clears the fields a new choice hides', async () => {
    const user = userEvent.setup()
    await renderForm()

    await user.click(screen.getByRole('button', { name: 'New business' }))
    await user.type(screen.getByLabelText(/new business name/i), 'Fresh Cafe')
    await user.type(screen.getByLabelText(/street address/i), '1 SW Main St')
    await user.click(screen.getByRole('button', { name: 'Individual (DTC)' }))
    await user.click(screen.getByRole('button', { name: 'New business' }))

    // The typed name carries over between the two typed-in choices; the address doesn't.
    expect(screen.getByLabelText(/new business name/i)).toHaveValue('Fresh Cafe')
    expect(screen.getByLabelText(/street address/i)).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Existing business' }))
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
  })

  it('drops an existing customer when switching to a typed-in name', async () => {
    const user = userEvent.setup()
    await renderForm()
    await fillRequiredFields(user)

    await user.click(screen.getByRole('button', { name: 'Individual (DTC)' }))
    expect(screen.getByLabelText(/customer name/i)).toHaveValue('')
    await user.type(screen.getByLabelText(/customer name/i), 'Pat Doe')
    await user.click(submitButton())

    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    const [order] = createOrder.mock.calls[0]
    expect(order).toMatchObject({
      customerType: 'individual',
      name: 'Pat Doe',
      address: null,
      businessType: null,
      streetAddress: null,
    })
  })
})

describe('OrderForm quantities', () => {
  const startStillOrder = async (user: ReturnType<typeof userEvent.setup>) => {
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
  }

  it('shows cases as cans and leaves the number alone when focus moves', async () => {
    const user = userEvent.setup()
    await startStillOrder(user)

    const cases = screen.getByLabelText(/total still cases/i)
    expect(cases).toHaveValue(5)
    expect(screen.getByText('= 120 cans')).toBeInTheDocument()

    // Leaving and re-entering the box used to multiply it by 24 each time.
    await user.click(cases)
    await user.click(screen.getByLabelText(/notes/i))
    await user.click(cases)
    await user.click(screen.getByLabelText(/notes/i))
    expect(cases).toHaveValue(5)
    expect(screen.getByText('= 120 cans')).toBeInTheDocument()

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(createOrder.mock.calls[0][0].totalStill).toBe(120)
  })

  it('takes single cans with Enter Manual Number on', async () => {
    const user = userEvent.setup()
    await startStillOrder(user)

    await user.click(screen.getByLabelText('Enter Manual Number (cans)'))
    expect(screen.queryByLabelText(/total still cases/i)).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText(/total still cans/i))
    await user.type(screen.getByLabelText(/total still cans/i), '130')
    expect(screen.getByText('Single cans, not cases')).toBeInTheDocument()

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(createOrder.mock.calls[0][0].totalStill).toBe(130)
  })

  it('goes back to cases after a saved order', async () => {
    const user = userEvent.setup()
    await startStillOrder(user)
    await user.click(screen.getByLabelText('Enter Manual Number (cans)'))

    await user.click(submitButton())
    await screen.findByText(/submitted successfully/i)

    expect(screen.getByLabelText('Enter Manual Number (cans)')).not.toBeChecked()
    await user.click(screen.getByLabelText('Still'))
    expect(screen.getByLabelText(/total still cases/i)).toHaveValue(null)
  })
})

describe('OrderForm price', () => {
  const startOrder = async (user: ReturnType<typeof userEvent.setup>, customer: string) => {
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await user.click(screen.getByLabelText(/name/i))
    await user.click(await screen.findByRole('option', { name: customer }))
  }

  it('prices at $1.50 a can by default', async () => {
    const user = userEvent.setup()
    await startOrder(user, 'Dame')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '5')

    expect(screen.getByLabelText('Price')).toHaveValue(180)
  })

  it('offers custom pricing and rounds it to the cent', async () => {
    const user = userEvent.setup()
    await startOrder(user, 'Hollywood Theatre')

    expect(await screen.findByText(/has custom pricing/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '1')

    expect(screen.getByLabelText('Price')).toHaveValue(39.84)
  })

  it('keeps a typed price until the quantity changes', async () => {
    const user = userEvent.setup()
    await startOrder(user, 'Dame')
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '5')

    await user.clear(screen.getByLabelText('Price'))
    await user.type(screen.getByLabelText('Price'), '150')
    await user.click(screen.getByLabelText(/notes/i))
    expect(screen.getByLabelText('Price')).toHaveValue(150)

    await user.type(screen.getByLabelText(/total still cases/i), '0')
    expect(screen.getByLabelText('Price')).toHaveValue(1800)
  })
})

describe('OrderForm donations and $0 orders', () => {
  const startDameOrder = async (user: ReturnType<typeof userEvent.setup>) => {
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
  }

  it('books a donation at $0 with the price locked', async () => {
    const user = userEvent.setup()
    await startDameOrder(user)
    expect(screen.getByLabelText('Price')).toHaveValue(180)

    await user.click(screen.getByLabelText('Donut'))
    expect(screen.getByLabelText('Price')).toHaveValue(0)
    expect(screen.getByLabelText('Price')).toBeDisabled()

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(createOrder.mock.calls[0][0]).toMatchObject({ isDonation: true, price: 0 })
  })

  it('goes back to the automatic price when Donut is turned off', async () => {
    const user = userEvent.setup()
    await startDameOrder(user)

    await user.click(screen.getByLabelText('Donut'))
    await user.click(screen.getByLabelText('Donut'))

    expect(screen.getByLabelText('Price')).toHaveValue(180)
    expect(screen.getByLabelText('Price')).toBeEnabled()
  })

  it.each([
    ['cleared', ''],
    ['set to $0', '0'],
  ])('blocks a sale whose price is %s and offers to mark it a donation', async (_, typed) => {
    const user = userEvent.setup()
    await startDameOrder(user)

    await user.clear(screen.getByLabelText('Price'))
    if (typed) await user.type(screen.getByLabelText('Price'), typed)

    expect(screen.getByText(/No price\. Enter one, or mark this order as a donation/)).toBeVisible()
    expect(submitButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Mark as donation' }))
    expect(screen.getByLabelText('Donut')).toBeChecked()
    expect(submitButton()).toBeEnabled()
  })

  it('lets a typed price through', async () => {
    const user = userEvent.setup()
    await startDameOrder(user)

    await user.clear(screen.getByLabelText('Price'))
    await user.type(screen.getByLabelText('Price'), '150')

    expect(screen.queryByText(/No price/)).not.toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
  })
})

describe('OrderForm product switches', () => {
  it('forgets a quantity once its product is switched off', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([
      batch({ id: 1, isStill: true, fillDate: '2026-06-20' }),
      batch({ id: 2, isStill: false, fillDate: '2026-08-03' }),
    ])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
    await user.click(screen.getByLabelText('Sparkling'))
    await user.type(screen.getByLabelText(/total sparkling cases/i), '2')
    expect(screen.getByLabelText('Price')).toHaveValue(252)

    // Still off: its 5 cases no longer count toward the price or the order.
    await user.click(screen.getByLabelText('Still'))
    expect(screen.getByLabelText('Price')).toHaveValue(72)

    // Back on, the box starts empty instead of bringing the old number back.
    await user.click(screen.getByLabelText('Still'))
    expect(screen.getByLabelText(/total still cases/i)).toHaveValue(null)
    await user.click(screen.getByLabelText('Still'))

    await user.click(submitButton())
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    const [order, batches] = createOrder.mock.calls[0]
    expect(order).toMatchObject({ isStill: false, totalStill: null, totalSpark: 48, price: 72 })
    expect(batches.still).toBeUndefined()
  })

  it('requires a quantity for each product that is on', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([batch({ id: 1, fillDate: '2026-06-20' })])
    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await fillRequiredFields(user)
    expect(submitButton()).toBeEnabled()

    await user.clear(screen.getByLabelText(/total still cases/i))
    expect(submitButton()).toBeDisabled()
  })
})
