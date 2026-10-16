import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OrderFormData } from '@/types/orders'
import { SIGNED_OUT } from '@/lib/auth/authFailure'

// Kept apart from OrderForm.test.tsx: these cover what the form does when a
// server action refuses the caller (no valid team session).

const getOrderFormData = vi.fn()
const createOrder = vi.fn()

vi.mock('@/app/actions/orders', () => ({
  getOrderFormData: () => getOrderFormData(),
  createOrder: (...args: unknown[]) => createOrder(...args),
}))
vi.mock('@/app/actions/orderHistory', () => ({ retryOrder: vi.fn() }))

import OrderForm from './OrderForm'

const data: OrderFormData = {
  customers: [
    {
      id: 1,
      name: 'Dame',
      business_type: 'Restaurant',
      price_per_can: null,
      custom_cans: false,
      email: null,
      address: '123 NE Broadway',
    },
  ],
  businessTypes: ['Restaurant'],
  batches: [
    {
      id: 45,
      name: 'Portlandica',
      count: 12000,
      isCustom: false,
      isStill: true,
      customer_id: null,
      product: 'water',
      fillDate: '2026-09-26',
      source: null,
    },
  ],
  squareReady: false,
  warnings: [],
}

beforeEach(() => {
  getOrderFormData.mockReset()
  createOrder.mockReset()
})

describe('OrderForm when the caller is refused', () => {
  it('shows the sign-in message instead of reporting the order as saved', async () => {
    const user = userEvent.setup({ delay: null })
    getOrderFormData.mockResolvedValue(data)
    createOrder.mockResolvedValue({ authError: SIGNED_OUT })

    render(<OrderForm />)
    await waitFor(() => expect(getOrderFormData).toHaveBeenCalled())
    await user.click(screen.getByLabelText(/^name/i))
    await user.click(await screen.findByRole('option', { name: 'Dame' }))
    await user.click(screen.getByLabelText('Still'))
    await user.type(screen.getByLabelText(/total still cases/i), '5')
    await user.click(screen.getByLabelText('Drop'))
    await user.click(screen.getByRole('button', { name: /submit order/i }))

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
    expect(screen.queryByText(/saved for/i)).not.toBeInTheDocument()
  })

  it('shows the sign-in message when the form cannot load', async () => {
    getOrderFormData.mockResolvedValue({ authError: SIGNED_OUT })

    render(<OrderForm />)

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
  })
})
