import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Inventory as InventoryRow } from '@/types/orders'
import { SIGNED_OUT } from '@/lib/auth/authFailure'

const getInventory = vi.fn()
const updateInventoryCount = vi.fn()

vi.mock('@/app/actions/inventory', () => ({
  getInventory: () => getInventory(),
  updateInventoryCount: (...args: unknown[]) => updateInventoryCount(...args),
  deleteInventoryItem: vi.fn(),
  createInventoryItem: vi.fn(),
}))

import Inventory from './Inventory'

const row: InventoryRow = {
  id: 7,
  created_at: '2026-01-01T00:00:00Z',
  name: 'Original',
  count: 240,
  isCustom: false,
  isStill: true,
  fillDate: '2026-01-01',
  totalCost: null,
  invoiceNumber: null,
  source: null,
}

beforeEach(() => {
  getInventory.mockReset()
  updateInventoryCount.mockReset()
})

describe('Inventory when the caller is refused', () => {
  it('shows the sign-in message instead of the list', async () => {
    getInventory.mockResolvedValue({ authError: SIGNED_OUT })

    render(<Inventory />)

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
  })

  it('keeps the dialog open with the message when a count update is refused', async () => {
    const user = userEvent.setup()
    getInventory.mockResolvedValue([row])
    updateInventoryCount.mockResolvedValue({ authError: SIGNED_OUT })

    render(<Inventory />)
    await user.click(await screen.findByText('Original'))
    const cases = screen.getByLabelText(/cases/i)
    await user.clear(cases)
    await user.type(cases, '5')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('240')).toBeInTheDocument()
  })
})
