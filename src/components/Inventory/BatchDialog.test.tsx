import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const actions = vi.hoisted(() => ({
  loadInventory: vi.fn(),
  addBatch: vi.fn(),
  changeBatchCount: vi.fn(),
  archiveInventoryBatch: vi.fn(),
  unarchiveInventoryBatch: vi.fn(),
  getBatchHistory: vi.fn(),
}))

vi.mock('@/app/actions/batches', () => actions)

import Inventory from './Inventory'
import { batch, customer, historyEntry } from './testing/fixtures'

// The batch dialog, opened from the list the way a partner would.

const dame = batch({
  id: 36,
  name: 'Dame',
  isCustom: true,
  customer_id: 5,
  count: 240,
  fillDate: '2026-08-25',
  source: 'North Powder',
  totalCost: 1200,
  invoiceNumber: 'INV-77',
})
const empty = batch({ id: 46, name: 'Empty batch', count: 0 })
const archived = batch({
  id: 13,
  name: 'Que Dice',
  isCustom: true,
  count: 0,
  archived_at: '2026-10-01T17:00:00Z',
})

const user = () => userEvent.setup({ delay: null })

const open = async (name: RegExp) => {
  const u = user()
  render(<Inventory />)
  await u.click(await screen.findByRole('button', { name }))
  return { u, dialog: screen.getByRole('dialog') }
}

beforeEach(() => {
  vi.resetAllMocks()
  actions.loadInventory.mockResolvedValue({
    ok: true,
    batches: [dame, empty, archived],
    customers: [customer({ id: 5, name: 'Dame', customCans: true })],
    ledger: { mismatches: [] },
  })
  actions.getBatchHistory.mockResolvedValue({ ok: true, entries: [] })
})

describe('Batch details', () => {
  it('shows the batch and its history, newest first', async () => {
    actions.getBatchHistory.mockResolvedValue({
      ok: true,
      entries: [
        historyEntry({ id: 9, change: -24, balance: 240, by: 'you', note: 'Two cases dented' }),
        historyEntry({
          id: 8,
          reason: 'order',
          change: -1440,
          balance: 264,
          by: 'partner',
          at: '2026-10-02T19:30:00Z',
          order: { id: 12, customerName: 'Dame', orderDate: '2026-10-02', voided: false },
        }),
        historyEntry({
          id: 1,
          reason: 'opening',
          change: 1704,
          balance: 1704,
          by: 'system',
          note: 'Count on hand when the ledger started',
        }),
      ],
    })
    const { dialog } = await open(/Dame/)

    expect(dialog).toHaveTextContent('Still · Custom cans')
    expect(dialog).toHaveTextContent('240 cans10 cases · 0.17 pallets')
    expect(dialog).toHaveTextContent('CustomerDame')
    expect(dialog).toHaveTextContent('FilledAug 25, 2026')
    expect(dialog).toHaveTextContent('Cost$1,200.00')
    expect(dialog).toHaveTextContent('InvoiceINV-77')
    expect(actions.getBatchHistory).toHaveBeenCalledWith(36)

    const items = within(await within(dialog).findByRole('list', { name: 'History' })).getAllByRole(
      'listitem'
    )
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Count changed')
    expect(items[0]).toHaveTextContent('-24 cans')
    expect(items[0]).toHaveTextContent('You · count after 240')
    expect(items[0]).toHaveTextContent('Two cases dented')
    expect(items[1]).toHaveTextContent('Order')
    expect(items[1]).toHaveTextContent('Other partner')
    expect(items[1]).toHaveTextContent('Order #12 · Dame · Oct 2, 2026')
    expect(items[2]).toHaveTextContent('Opening count')
    expect(items[2]).toHaveTextContent('+1,704 cans')
    expect(items[2]).toHaveTextContent('System')
  })

  it('says when the history could not be loaded', async () => {
    actions.getBatchHistory.mockResolvedValue({
      ok: false,
      error: 'Could not load the history. Try again.',
    })
    const { dialog } = await open(/Dame/)

    expect(
      await within(dialog).findByText('Could not load the history. Try again.')
    ).toBeInTheDocument()
  })

  it('changes a count entered in cases, with a note saying why', async () => {
    const recounted = { ...dame, count: 216 }
    actions.changeBatchCount.mockResolvedValue({ ok: true, batch: recounted })
    const { u, dialog } = await open(/Dame/)

    await u.click(within(dialog).getByRole('button', { name: 'Change count' }))
    expect(
      within(dialog).getByText('Now 240 cans (10 cases). Enter what you counted.')
    ).toBeInTheDocument()
    const cases = within(dialog).getByLabelText('Cases counted')
    expect(cases).toHaveValue('10')
    const save = within(dialog).getByRole('button', { name: 'Save count' })
    expect(save).toBeDisabled()

    await u.clear(cases)
    await u.type(cases, '9')
    expect(within(dialog).getByText('216 cans (9 cases) · -24 cans')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await u.type(within(dialog).getByLabelText(/why is the count changing/i), 'Recount')
    await u.click(save)

    expect(actions.changeBatchCount).toHaveBeenCalledWith({
      batchId: 36,
      newCount: 216,
      expectedCount: 240,
      note: 'Recount',
    })
    expect(await within(dialog).findByRole('button', { name: 'Change count' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('216 cans9 cases')
    // The history is read again so the new change shows.
    await waitFor(() => expect(actions.getBatchHistory).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /Dame/, hidden: true })).toHaveTextContent('216 cans')
  })

  it('takes a count in single cans, and refuses partial cans', async () => {
    actions.changeBatchCount.mockResolvedValue({ ok: true, batch: { ...dame, count: 230 } })
    const { u, dialog } = await open(/Dame/)
    await u.click(within(dialog).getByRole('button', { name: 'Change count' }))

    const cases = within(dialog).getByLabelText('Cases counted')
    await u.clear(cases)
    await u.type(cases, '9.6')
    expect(
      within(dialog).getByText('Enter cases that make whole cans (24 to a case).')
    ).toBeInTheDocument()

    await u.click(within(dialog).getByRole('button', { name: 'Cans' }))
    const cans = within(dialog).getByLabelText('Cans counted')
    await u.clear(cans)
    await u.type(cans, '230')
    await u.type(within(dialog).getByLabelText(/why is the count changing/i), 'Loose cans')
    await u.click(within(dialog).getByRole('button', { name: 'Save count' }))

    expect(actions.changeBatchCount).toHaveBeenCalledWith(
      expect.objectContaining({ newCount: 230, expectedCount: 240, note: 'Loose cans' })
    )
  })

  it('shows the new count when someone changed the batch meanwhile', async () => {
    actions.changeBatchCount
      .mockResolvedValueOnce({
        ok: false,
        error:
          'Someone changed this batch to 216 cans while you were editing. Check your count and save again.',
        batch: { ...dame, count: 216 },
      })
      .mockResolvedValueOnce({ ok: true, batch: { ...dame, count: 192 } })
    const { u, dialog } = await open(/Dame/)
    await u.click(within(dialog).getByRole('button', { name: 'Change count' }))

    const cases = within(dialog).getByLabelText('Cases counted')
    await u.clear(cases)
    await u.type(cases, '8')
    await u.type(within(dialog).getByLabelText(/why is the count changing/i), 'Recount')
    await u.click(within(dialog).getByRole('button', { name: 'Save count' }))

    expect(
      await within(dialog).findByText(/Someone changed this batch to 216 cans/)
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('Now 216 cans (9 cases). Enter what you counted.')
    ).toBeInTheDocument()

    // The button reads "Saving…" until the first save has finished.
    await u.click(await within(dialog).findByRole('button', { name: 'Save count' }))
    expect(actions.changeBatchCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ newCount: 192, expectedCount: 216 })
    )
  })

  it('archives a batch with cans left only with a reason', async () => {
    actions.archiveInventoryBatch.mockResolvedValue({
      ok: true,
      batch: { ...dame, count: 0, archived_at: '2026-10-15T20:00:00Z' },
    })
    const { u, dialog } = await open(/Dame/)

    await u.click(within(dialog).getByRole('button', { name: 'Archive' }))
    expect(dialog).toHaveTextContent('Its 240 cans will be written off.')
    const archive = within(dialog).getByRole('button', { name: 'Archive' })
    expect(archive).toBeDisabled()

    await u.type(within(dialog).getByLabelText(/why\?/i), 'Customer closed')
    await u.click(archive)

    expect(actions.archiveInventoryBatch).toHaveBeenCalledWith(36, 'Customer closed')
    expect(await within(dialog).findByRole('button', { name: 'Unarchive' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Change count' })).not.toBeInTheDocument()
    // Gone from the list, which only shows batches in use.
    expect(screen.queryByRole('region', { name: 'Still · Custom cans', hidden: true })).toBeNull()
  })

  it('archives an empty batch without a reason', async () => {
    actions.archiveInventoryBatch.mockResolvedValue({
      ok: true,
      batch: { ...empty, archived_at: '2026-10-15T20:00:00Z' },
    })
    const { u, dialog } = await open(/Empty batch/)

    await u.click(within(dialog).getByRole('button', { name: 'Archive' }))
    expect(within(dialog).getByLabelText('Why? (optional)')).toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Archive' }))

    expect(actions.archiveInventoryBatch).toHaveBeenCalledWith(46, '')
  })

  it('unarchives an archived batch', async () => {
    actions.unarchiveInventoryBatch.mockResolvedValue({
      ok: true,
      batch: { ...archived, count: 1200, archived_at: null },
    })
    const u = user()
    render(<Inventory />)
    await u.click(await screen.findByLabelText('Show archived (1)'))
    await u.click(screen.getByRole('button', { name: /Que Dice/ }))
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).queryByRole('button', { name: 'Change count' })).not.toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: 'Unarchive' }))
    await u.click(within(dialog).getByRole('button', { name: 'Unarchive' }))

    expect(actions.unarchiveInventoryBatch).toHaveBeenCalledWith(13, '')
    expect(await within(dialog).findByRole('button', { name: 'Change count' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('1,200 cans')
  })

  it('keeps the form open with the message when archiving fails', async () => {
    actions.archiveInventoryBatch.mockResolvedValue({
      ok: false,
      error: 'Could not archive the batch. Try again.',
    })
    const { u, dialog } = await open(/Dame/)

    await u.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await u.type(within(dialog).getByLabelText(/why\?/i), 'Customer closed')
    await u.click(within(dialog).getByRole('button', { name: 'Archive' }))

    expect(
      await within(dialog).findByText('Could not archive the batch. Try again.')
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })
})
