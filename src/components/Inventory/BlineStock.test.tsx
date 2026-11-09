import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BlineStockMove, BlineStockRow } from '@/lib/db/types'

const actions = vi.hoisted(() => ({
  loadBlineStock: vi.fn(),
  updateBlineStock: vi.fn(),
}))

vi.mock('@/app/actions/bline', () => actions)

import BlineStock from './BlineStock'
import { portlandToday } from './dates'
import { batch } from './testing/fixtures'

const batches = [
  batch({ id: 45, name: 'Portlandica', count: 12000 }),
  batch({ id: 25, name: 'North Powder', isStill: false, count: 4760 }),
  batch({ id: 36, name: 'Dame', isCustom: true, customer_id: 5, count: 240 }),
]

// on_hand follows from remaining and pending unless a test says otherwise.
const row = (over: Partial<BlineStockRow> & { batch_id: number }): BlineStockRow => {
  const r = {
    name: 'Portlandica',
    is_still: true,
    moved: 1440,
    booked: 0,
    pending: 0,
    remaining: 1440,
    ...over,
  }
  return { ...r, on_hand: over.on_hand ?? r.remaining + r.pending }
}

const moved = (over: Partial<BlineStockMove> & { id: number }): BlineStockMove => ({
  batch_id: 45,
  cans: 1440,
  reason: 'sent',
  moved_on: '2026-11-09',
  note: null,
  created_by: null,
  created_at: '2026-11-09T20:00:00Z',
  ...over,
})

const loaded = (stock: BlineStockRow[] = [], moves: BlineStockMove[] = []) => ({
  ok: true as const,
  stock,
  moves,
})

const panel = () => screen.getByRole('region', { name: 'At BLine' })

const openUpdate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await within(panel()).findByRole('button', { name: 'Update' }))
  return screen.findByRole('dialog', { name: 'Update what BLine has' })
}

beforeEach(() => {
  vi.resetAllMocks()
  actions.loadBlineStock.mockResolvedValue(loaded())
})

describe('At BLine', () => {
  it('says when nothing has been sent yet', async () => {
    render(<BlineStock batches={batches} reloadKey={0} />)
    expect(
      await screen.findByText('Nothing at BLine yet. Use Update to record the pallets you send.')
    ).toBeInTheDocument()
  })

  it('shows what BLine has of each batch, and the latest change', async () => {
    actions.loadBlineStock.mockResolvedValue(
      loaded(
        [
          row({
            batch_id: 25,
            name: 'North Powder',
            is_still: false,
            booked: 48,
            remaining: 1392,
          }),
          row({ batch_id: 45 }),
        ],
        [moved({ id: 2, batch_id: 25, note: 'First pallet' }), moved({ id: 1 })]
      )
    )
    render(<BlineStock batches={batches} reloadKey={0} />)

    expect(await within(panel()).findByText('Portlandica Still')).toBeInTheDocument()
    expect(within(panel()).getByText('1,440 cans (60 cases)')).toBeInTheDocument()
    expect(within(panel()).getByText('North Powder Sparkling')).toBeInTheDocument()
    expect(within(panel()).getByText('1,392 cans (58 cases)')).toBeInTheDocument()
    expect(
      within(panel()).getByText(
        'Latest: Nov 9, 2026 · Sent to BLine · 1,440 cans of North Powder Sparkling · First pallet'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(panel()).queryByText(/On the shelf today/)).not.toBeInTheDocument()
  })

  it('says how many cans are still on the shelf for deliveries not made yet', async () => {
    actions.loadBlineStock.mockResolvedValue(
      loaded([row({ batch_id: 45, booked: 288, pending: 240, remaining: 1152 })])
    )
    render(<BlineStock batches={batches} reloadKey={0} />)

    expect(await within(panel()).findByText('1,152 cans (48 cases)')).toBeInTheDocument()
    expect(
      within(panel()).getByText(
        'Left after booked deliveries. On the shelf today: 1,392 cans, with 240 cans still to deliver.'
      )
    ).toBeInTheDocument()
  })

  it('warns when BLine is running low or below zero', async () => {
    actions.loadBlineStock.mockResolvedValue(
      loaded([
        row({ batch_id: 45, booked: 1224, remaining: 216 }),
        row({
          batch_id: 25,
          name: 'North Powder',
          is_still: false,
          booked: 1464,
          remaining: -24,
        }),
      ])
    )
    render(<BlineStock batches={batches} reloadKey={0} />)

    const low = await screen.findByText('BLine is running low')
    expect(low.parentElement).toHaveTextContent('Still: 216 cans (9 cases)')
    expect(low.parentElement).toHaveTextContent('Time to send another pallet.')
    expect(screen.getByText('Below zero at BLine').parentElement).toHaveTextContent(
      'North Powder Sparkling: -24 cans'
    )
  })

  it("says when BLine's numbers can't be loaded", async () => {
    actions.loadBlineStock.mockResolvedValue({
      ok: false,
      error: 'Could not load what BLine has. Try again.',
    })
    render(<BlineStock batches={batches} reloadKey={0} />)
    expect(await screen.findByText('Could not load what BLine has. Try again.')).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Update' })).toBeDisabled()
  })

  it('loads again when the tab is refreshed', async () => {
    const { rerender } = render(<BlineStock batches={batches} reloadKey={0} />)
    await waitFor(() => expect(actions.loadBlineStock).toHaveBeenCalledTimes(1))
    rerender(<BlineStock batches={batches} reloadKey={1} />)
    await waitFor(() => expect(actions.loadBlineStock).toHaveBeenCalledTimes(2))
  })
})

describe('Updating what BLine has', () => {
  it('records a pallet sent, in cases', async () => {
    const user = userEvent.setup({ delay: null })
    actions.updateBlineStock.mockResolvedValue(loaded([row({ batch_id: 45 })], [moved({ id: 1 })]))
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByLabelText(/^batch/i))
    // House stock first, still before sparkling, then custom cans.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Portlandica Still',
      'North Powder Sparkling',
      'Dame Still',
    ])
    await user.click(screen.getByRole('option', { name: 'Portlandica Still' }))
    await user.type(within(dialog).getByLabelText('Cases sent'), '60')
    expect(within(dialog).getByText('1,440 cans (60 cases)')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Note'), 'First pallet')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(actions.updateBlineStock).toHaveBeenCalledWith({
      kind: 'sent',
      batchId: 45,
      cans: 1440,
      movedOn: portlandToday(),
      note: 'First pallet',
    })
    expect(within(panel()).getByText('1,440 cans (60 cases)')).toBeInTheDocument()
  })

  it('points out sending more than the batch has outside BLine, without refusing it', async () => {
    const user = userEvent.setup({ delay: null })
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByLabelText(/^batch/i))
    await user.click(screen.getByRole('option', { name: 'Dame Still' }))
    await user.type(within(dialog).getByLabelText('Cases sent'), '20')
    expect(
      within(dialog).getByText(
        "480 cans (20 cases) The batch has only 240 cans that aren't at BLine already."
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it("won't take a date after today", async () => {
    const user = userEvent.setup({ delay: null })
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByLabelText(/^batch/i))
    await user.click(screen.getByRole('option', { name: 'Portlandica Still' }))
    await user.type(within(dialog).getByLabelText('Cases sent'), '60')
    fireEvent.change(within(dialog).getByLabelText('Sent on'), { target: { value: '2099-01-01' } })
    expect(within(dialog).getByText("The date can't be after today.")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it("won't bring back more than BLine should have", async () => {
    const user = userEvent.setup({ delay: null })
    actions.loadBlineStock.mockResolvedValue(loaded([row({ batch_id: 45, remaining: 48 })]))
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByRole('button', { name: 'Brought back' }))
    // Only batches BLine has cans of; with one, it is picked already.
    expect(
      within(dialog).getByText('BLine should have 48 cans (2 cases) today.')
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Cases brought back'), '3')
    expect(
      within(dialog).getByText(
        "BLine should only have 48 cans of this batch. If that's wrong, record BLine's count instead."
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('points out bringing back cans BLine needs for deliveries, without refusing it', async () => {
    const user = userEvent.setup({ delay: null })
    actions.loadBlineStock.mockResolvedValue(
      loaded([row({ batch_id: 45, booked: 240, pending: 240, remaining: 0 })])
    )
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByRole('button', { name: 'Brought back' }))
    await user.type(within(dialog).getByLabelText('Cases brought back'), '5')
    expect(
      within(dialog).getByText(
        "120 cans (5 cases) That takes cans BLine needs for deliveries it hasn't made yet."
      )
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it("counts cans for deliveries not made yet as still on BLine's shelf", async () => {
    const user = userEvent.setup({ delay: null })
    actions.loadBlineStock.mockResolvedValue(
      loaded([row({ batch_id: 45, booked: 240, pending: 240, remaining: 1200 })])
    )
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByRole('button', { name: 'Counted' }))
    expect(
      within(dialog).getByText(
        "BLine should have 1,440 cans (60 cases) today, 240 cans of them for deliveries it hasn't made yet."
      )
    ).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Counted on')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Cases BLine counted today'), '60')
    expect(
      within(dialog).getByText('1,440 cans (60 cases) · should have 1,440 cans · no change')
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/where is the count from/i), 'Call')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it("records BLine's count against what it should have, and needs to know where it's from", async () => {
    const user = userEvent.setup({ delay: null })
    actions.loadBlineStock.mockResolvedValue(
      loaded([row({ batch_id: 45, booked: 48, remaining: 1392 })])
    )
    actions.updateBlineStock.mockResolvedValue(loaded([row({ batch_id: 45, remaining: 1380 })]))
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByRole('button', { name: 'Counted' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cans' }))
    await user.type(within(dialog).getByLabelText('Cans BLine counted today'), '1380')
    expect(
      within(dialog).getByText('1,380 cans (57.5 cases) · should have 1,392 cans · -12 cans')
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/where is the count from/i), "BLine's email")
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(actions.updateBlineStock).toHaveBeenCalled())
    expect(actions.updateBlineStock).toHaveBeenCalledWith({
      kind: 'count',
      batchId: 45,
      counted: 1380,
      expectedCount: 1392,
      note: "BLine's email",
    })
    expect(await within(panel()).findByText('1,380 cans (57.5 cases)')).toBeInTheDocument()
  })

  it('shows the new numbers when an order changed them while counting', async () => {
    const user = userEvent.setup({ delay: null })
    actions.loadBlineStock.mockResolvedValue(loaded([row({ batch_id: 45, remaining: 1440 })]))
    actions.updateBlineStock.mockResolvedValue({
      ok: false,
      error: 'An order changed what BLine should have today to 1,416 cans while you were counting.',
      data: loaded([row({ batch_id: 45, remaining: 1416 })]),
    })
    render(<BlineStock batches={batches} reloadKey={0} />)
    const dialog = await openUpdate(user)

    await user.click(within(dialog).getByRole('button', { name: 'Counted' }))
    await user.type(within(dialog).getByLabelText('Cases BLine counted today'), '59')
    await user.type(within(dialog).getByLabelText(/where is the count from/i), 'Call')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(
      await within(dialog).findByText(
        'An order changed what BLine should have today to 1,416 cans while you were counting.'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('BLine should have 1,416 cans (59 cases) today.')
    ).toBeInTheDocument()
    // The panel behind the open dialog has the new number too.
    const behind = screen.getByRole('region', { name: 'At BLine', hidden: true })
    expect(within(behind).getByText('1,416 cans (59 cases)')).toBeInTheDocument()
  })
})
