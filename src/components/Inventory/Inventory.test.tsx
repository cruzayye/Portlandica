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
// The tab changes stock only through the ledger actions above. If anything in it imported
// the old direct-write actions again, these tests would fail here.
vi.mock('@/app/actions/inventory', () => {
  throw new Error('The Inventory tab must not use the old inventory actions')
})

import Inventory from './Inventory'
import { portlandToday } from './dates'
import { batch, customer } from './testing/fixtures'
import type { InventoryData } from './types'

const loaded = (over: Partial<InventoryData> = {}) => ({
  ok: true as const,
  batches: [],
  customers: [],
  ledger: { mismatches: [] },
  ...over,
})

const stock = [
  batch({ id: 45, name: 'Portlandica', count: 12000 }),
  batch({
    id: 36,
    name: 'Dame',
    isCustom: true,
    customer_id: 5,
    count: 2760,
    fillDate: '2026-08-25',
    source: 'North Powder',
  }),
  batch({ id: 22, name: 'Hotel Vintage', isCustom: true, count: -120, fillDate: '2026-06-20' }),
  batch({
    id: 25,
    name: 'Portlandica - north powder',
    isStill: false,
    count: 4760,
    fillDate: '2026-08-03',
    source: 'North Powder',
  }),
  batch({ id: 33, name: 'Portlandica Dog water', product: 'dog_water', count: 2376 }),
  batch({
    id: 13,
    name: 'Que Dice',
    isCustom: true,
    count: 0,
    archived_at: '2026-10-01T17:00:00Z',
  }),
]

const customers = [
  customer({ id: 5, name: 'Dame', customCans: true }),
  customer({ id: 6, name: 'Rose City Taps', customCans: true }),
  customer({ id: 7, name: 'Cafe Yumm' }),
]

const section = (name: string) => screen.getByRole('region', { name })

const alertWith = (text: string) =>
  screen.getAllByRole('alert').find((alert) => alert.textContent?.includes(text))

beforeEach(() => {
  vi.resetAllMocks()
  actions.loadInventory.mockResolvedValue(loaded({ batches: stock, customers }))
  actions.getBatchHistory.mockResolvedValue({ ok: true, entries: [] })
})

describe('Inventory tab', () => {
  it('groups batches by product, house stock before custom cans', async () => {
    render(<Inventory />)

    await screen.findByRole('region', { name: 'Still · House stock' })
    expect(
      screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    ).toEqual([
      'Still · House stock',
      'Still · Custom cans',
      'Sparkling · House stock',
      'Dog water · House stock',
    ])
    expect(
      within(section('Still · House stock')).getByText('12,000 cans', { selector: 'h3 + *' })
    ).toBeInTheDocument()
  })

  it('shows cans, cases and pallets, and who custom cans are for', async () => {
    render(<Inventory />)

    const house = await screen.findByRole('region', { name: 'Still · House stock' })
    const row = within(house).getByRole('button', { name: /Portlandica/ })
    expect(row).toHaveTextContent('12,000 cans')
    expect(row).toHaveTextContent('500 cases')
    expect(row).toHaveTextContent('8.33 pallets')
    expect(row).toHaveTextContent('Filled Sep 26, 2026 · Opal Springs')

    const custom = section('Still · Custom cans')
    expect(within(custom).getByRole('button', { name: /Dame/ })).toHaveTextContent('For Dame')
    expect(within(custom).getByRole('button', { name: /Hotel Vintage/ })).toHaveTextContent(
      'No customer linked'
    )
  })

  it('flags counts below zero on the row and at the top', async () => {
    render(<Inventory />)

    const row = await screen.findByRole('button', { name: /Hotel Vintage/ })
    expect(within(row).getByText('Below zero')).toBeInTheDocument()
    expect(row).toHaveTextContent('-120 cans')
    expect(alertWith('More cans went out')).toHaveTextContent('Hotel Vintage (Still): -120 cans')
  })

  it('warns when house still or sparkling stock is low', async () => {
    actions.loadInventory.mockResolvedValue(
      loaded({
        batches: [
          batch({ id: 1, count: 1200 }),
          batch({ id: 2, isStill: false, count: 4760 }),
          batch({ id: 3, name: 'Dame', isCustom: true, count: 5000 }),
        ],
      })
    )
    render(<Inventory />)

    await screen.findByText('Low house stock')
    const alert = alertWith('Low house stock')
    expect(alert).toHaveTextContent('Still: 1,200 cans (50 cases)')
    expect(alert).not.toHaveTextContent('Sparkling')
    expect(alert).toHaveTextContent('Under 2,000 cans')
  })

  it('does not warn while house stock is at the threshold', async () => {
    actions.loadInventory.mockResolvedValue(
      loaded({
        batches: [batch({ id: 1, count: 2000 }), batch({ id: 2, isStill: false, count: 2000 })],
      })
    )
    render(<Inventory />)

    await screen.findByRole('region', { name: 'Still · House stock' })
    expect(screen.queryByText('Low house stock')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the ledger check when a count does not match its history', async () => {
    actions.loadInventory.mockResolvedValue(
      loaded({
        batches: stock,
        customers,
        ledger: {
          mismatches: [
            { batch_id: 36, name: 'Dame', count: 2760, ledger_total: 2736, difference: 24 },
          ],
        },
      })
    )
    render(<Inventory />)

    await screen.findByText("Counts don't match their history")
    expect(alertWith('inventory_ledger_check')).toHaveTextContent(
      'Dame: count 2,760, history adds up to 2,736'
    )
  })

  it('says when the ledger could not be checked', async () => {
    actions.loadInventory.mockResolvedValue(
      loaded({
        batches: stock,
        customers,
        ledger: { error: 'Could not check that every count matches its history.' },
      })
    )
    render(<Inventory />)

    expect(
      await screen.findByText('Could not check that every count matches its history.')
    ).toBeInTheDocument()
  })

  it('keeps archived batches behind a toggle', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Inventory />)

    await screen.findByRole('region', { name: 'Still · House stock' })
    expect(screen.queryByText('Que Dice')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Show archived (1)'))

    expect(within(section('Archived')).getByRole('button', { name: /Que Dice/ })).toHaveTextContent(
      'Archived Oct 1, 2026'
    )
  })

  it('says so when there is nothing in stock', async () => {
    actions.loadInventory.mockResolvedValue(loaded())
    render(<Inventory />)

    expect(
      await screen.findByText('No batches in stock. Add one when cans are filled.')
    ).toBeInTheDocument()
  })

  it('shows why the inventory could not load', async () => {
    actions.loadInventory.mockResolvedValue({
      ok: false,
      error: 'Could not load the inventory. Try again.',
    })
    render(<Inventory />)

    expect(await screen.findByText('Could not load the inventory. Try again.')).toBeInTheDocument()
  })

  it('reloads on refresh, keeping the list if the reload fails', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Inventory />)
    await screen.findByRole('button', { name: /Dame/ })

    actions.loadInventory.mockResolvedValueOnce(loaded({ batches: [batch({ id: 45 })] }))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByText('Dame')).not.toBeInTheDocument())

    // Refresh stays disabled until the first reload has finished.
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    await waitFor(() => expect(refresh).toBeEnabled())
    actions.loadInventory.mockRejectedValueOnce(new Error('offline'))
    await user.click(refresh)
    expect(await screen.findByText('Could not load the inventory. Try again.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Still · House stock' })).toBeInTheDocument()
  })

  it('adds a batch and shows it in its group', async () => {
    const user = userEvent.setup({ delay: null })
    actions.addBatch.mockResolvedValue({
      ok: true,
      batch: batch({ id: 101, name: 'Portlandica', count: 1440, fillDate: '2026-10-15' }),
    })
    render(<Inventory />)

    await user.click(await screen.findByRole('button', { name: 'Add batch' }))
    const dialog = screen.getByRole('dialog', { name: 'Add batch' })
    await user.type(within(dialog).getByLabelText(/^cases/i), '60')
    await user.click(within(dialog).getByRole('combobox', { name: /water source/i }))
    await user.click(screen.getByRole('option', { name: 'North Powder' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add batch' }))

    expect(actions.addBatch).toHaveBeenCalledWith(
      expect.objectContaining({ cans: 1440, fillDate: portlandToday(), source: 'North Powder' })
    )
    expect(await screen.findByText('Added Portlandica: 1,440 cans')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Add batch' })).not.toBeInTheDocument()
    expect(
      within(section('Still · House stock')).getAllByRole('button', { name: /Portlandica/ })
    ).toHaveLength(2)
  })
})
