import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Inventory } from '@/types/orders'
import { SIGNED_OUT } from '@/lib/auth/authFailure'

// Kept apart from OrderForm.test.tsx: these cover what the form does when a
// server action refuses the caller (signed out, or not on the partner list).

const getInventory = vi.fn()
const createOrder = vi.fn()

vi.mock('@/app/actions/inventory', () => ({
  getInventory: () => getInventory(),
}))

vi.mock('@/app/actions/orders', () => ({
  getLocations: () =>
    Promise.resolve([{ name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' }]),
  getLocationTypes: () => Promise.resolve([{ name: 'Restaurant' }]),
  createOrder: (...args: unknown[]) => createOrder(...args),
}))

import OrderForm from './OrderForm'

const batch: Inventory = {
  id: 1,
  created_at: '2026-01-01T00:00:00Z',
  name: 'Original',
  count: 1440,
  isCustom: false,
  isStill: true,
  fillDate: '2026-01-01',
  totalCost: null,
  invoiceNumber: null,
  source: null,
}

beforeEach(() => {
  getInventory.mockReset()
  createOrder.mockReset()
})

describe('OrderForm when the caller is refused', () => {
  it('shows the sign-in message instead of reporting the order as submitted', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([batch])
    createOrder.mockResolvedValue({ authError: SIGNED_OUT })

    render(<OrderForm />)
    await waitFor(() => expect(getInventory).toHaveBeenCalled())
    await user.click(screen.getByLabelText(/name/i))
    await user.click(await screen.findByRole('option', { name: 'Dame' }))
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '5')
    await user.click(screen.getByLabelText('Drop'))
    await user.click(screen.getByRole('button', { name: /submit order/i }))

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
    expect(screen.queryByText(/order submitted successfully/i)).not.toBeInTheDocument()
  })

  it('shows the sign-in message when inventory cannot load', async () => {
    getInventory.mockResolvedValue({ authError: SIGNED_OUT })

    render(<OrderForm />)

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
  })
})
