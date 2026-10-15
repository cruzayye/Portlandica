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
    Promise.resolve([{ name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' }]),
  getLocationTypes: () => Promise.resolve(['Restaurant']),
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
  await user.click(screen.getByLabelText('Drop'))
}

beforeEach(() => {
  getInventory.mockReset()
  createOrder.mockReset()
  createOrder.mockResolvedValue({ duplicate: false })
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
    const [, stillId] = createOrder.mock.calls[0]
    expect(stillId).toBe(2)
  })
})
