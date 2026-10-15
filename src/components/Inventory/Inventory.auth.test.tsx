import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SIGNED_OUT } from '@/lib/auth/authFailure'
import { batch } from './testing/fixtures'

const loadInventory = vi.fn()
const changeBatchCount = vi.fn()
const getBatchHistory = vi.fn()

vi.mock('@/app/actions/batches', () => ({
  loadInventory: () => loadInventory(),
  changeBatchCount: (...args: unknown[]) => changeBatchCount(...args),
  getBatchHistory: (...args: unknown[]) => getBatchHistory(...args),
  addBatch: vi.fn(),
  archiveInventoryBatch: vi.fn(),
  unarchiveInventoryBatch: vi.fn(),
}))

import Inventory from './Inventory'

const row = batch({ id: 7, name: 'Original', count: 240 })

beforeEach(() => {
  loadInventory.mockReset()
  changeBatchCount.mockReset()
  getBatchHistory.mockReset()
})

describe('Inventory when the caller is refused', () => {
  it('shows the sign-in message instead of the list', async () => {
    loadInventory.mockResolvedValue({ authError: SIGNED_OUT })

    render(<Inventory />)

    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
  })

  it('shows the sign-in message in place of a batch history', async () => {
    const user = userEvent.setup({ delay: null })
    loadInventory.mockResolvedValue({
      ok: true,
      batches: [row],
      customers: [],
      ledger: { mismatches: [] },
    })
    getBatchHistory.mockResolvedValue({ authError: SIGNED_OUT })

    render(<Inventory />)
    await user.click(await screen.findByRole('button', { name: /Original/ }))

    expect(await within(screen.getByRole('dialog')).findByText(SIGNED_OUT)).toBeInTheDocument()
  })

  it('keeps the form open with the message when a count change is refused', async () => {
    const user = userEvent.setup({ delay: null })
    loadInventory.mockResolvedValue({
      ok: true,
      batches: [row],
      customers: [],
      ledger: { mismatches: [] },
    })
    getBatchHistory.mockResolvedValue({ ok: true, entries: [] })
    changeBatchCount.mockResolvedValue({ authError: SIGNED_OUT })

    render(<Inventory />)
    await user.click(await screen.findByRole('button', { name: /Original/ }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Change count' }))
    const cases = within(dialog).getByLabelText('Cases counted')
    await user.clear(cases)
    await user.type(cases, '5')
    await user.type(within(dialog).getByLabelText(/why is the count changing/i), 'Recount')
    await user.click(within(dialog).getByRole('button', { name: 'Save count' }))

    expect(await within(dialog).findByText(SIGNED_OUT)).toBeInTheDocument()
    expect(
      within(dialog).getByText('Now 240 cans (10 cases). Enter what you counted.')
    ).toBeInTheDocument()
  })
})
