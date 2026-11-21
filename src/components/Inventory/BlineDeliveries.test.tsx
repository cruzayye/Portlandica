import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileOrder, FindeliversRow } from '@/lib/findelivers'

const actions = vi.hoisted(() => ({
  loadBlineDeliveries: vi.fn(),
  readFindeliversFile: vi.fn(),
  saveFindeliversFile: vi.fn(),
}))

vi.mock('@/app/actions/blineTracking', () => actions)

import BlineDeliveries from './BlineDeliveries'
import { portlandToday } from './dates'

const dayFromToday = (days: number) => {
  const date = new Date(`${portlandToday()}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const fileOrder = (over: Partial<FileOrder> & { id: number }): FileOrder => ({
  customerName: 'Lovejoy Bakers',
  address: '939 NW 10th Ave, Portland, OR 97209',
  orderDate: dayFromToday(-1),
  deliveryDate: dayFromToday(2),
  totalCans: 96,
  voided: false,
  blineRef: null,
  blineStatus: null,
  blineProblem: null,
  deliveredAt: null,
  ...over,
})

const fileRow = (over: Partial<FindeliversRow> & { ref: string }): FindeliversRow => ({
  status: 'delivered',
  createdAt: '2026-11-20T01:22:00.000Z',
  createdOn: '2026-11-19',
  recipient: 'Lovejoy Bakers',
  address: '939 NW 10th Ave, Portland, OR',
  postcode: '97209',
  deliveredAt: '2026-11-20T17:51:00.000Z',
  problem: null,
  ...over,
})

const loaded = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  waiting: [],
  lastImport: null,
  months: [],
  ...over,
})

const section = () => screen.getByRole('region', { name: 'BLine deliveries' })

// The dialog turns its buttons off while it reads or saves a file.
const idle = (dialog: HTMLElement) =>
  waitFor(() =>
    expect(within(dialog).getByText(/^Choose (another )?file$/)).not.toHaveClass('Mui-disabled')
  )

const saveWhenReady = async (dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) => {
  const save = within(dialog).getByRole('button', { name: 'Save' })
  await waitFor(() => expect(save).toBeEnabled())
  await user.click(save)
}

beforeEach(() => {
  vi.resetAllMocks()
  actions.loadBlineDeliveries.mockResolvedValue(loaded())
})

describe('BLine deliveries', () => {
  it('says when nothing is waiting and nothing was imported yet', async () => {
    render(<BlineDeliveries reloadKey={0} onImported={vi.fn()} />)
    expect(await screen.findByText('Nothing waiting on BLine.')).toBeInTheDocument()
    expect(
      screen.getByText(
        'No findelivers import yet. Download the Orders CSV in findelivers, then Import.'
      )
    ).toBeInTheDocument()
  })

  it('lists what BLine has still to deliver, and what needs a look', async () => {
    actions.loadBlineDeliveries.mockResolvedValue(
      loaded({
        waiting: [
          fileOrder({
            id: 85,
            customerName: 'Hillside Clinic',
            orderDate: '2026-11-19',
            deliveryDate: dayFromToday(3),
            blineRef: '261101.0008',
            blineStatus: 'created',
          }),
          fileOrder({
            id: 86,
            customerName: 'Que Dice',
            blineRef: '261101.0009',
            blineStatus: 'failed_attempt',
            blineProblem: 'Refused by recipient',
          }),
          // An import since the day it was booked didn't find it.
          fileOrder({ id: 87, customerName: 'Sunny Day Cafe', orderDate: dayFromToday(-2) }),
          fileOrder({
            id: 88,
            customerName: 'Late Lunch',
            orderDate: dayFromToday(-9),
            deliveryDate: dayFromToday(-5),
            blineRef: 'R-88',
            blineStatus: 'in_transit',
          }),
        ],
        lastImport: new Date().toISOString(),
        months: [{ month: '2026-11', orders: 9, fees: 128.4 }],
      })
    )
    render(<BlineDeliveries reloadKey={0} onImported={vi.fn()} />)

    expect(await within(section()).findByText('To deliver (4)')).toBeInTheDocument()
    expect(
      within(section()).getByText(/^#85 Hillside Clinic · booked Nov 19 · for /)
    ).toBeInTheDocument()
    expect(within(section()).getByText('findelivers 261101.0008: Unassigned')).toBeInTheDocument()
    expect(
      within(section()).getByText('findelivers 261101.0009: Failed attempt (Refused by recipient)')
    ).toBeInTheDocument()
    expect(
      within(section()).getByText('Not in findelivers: email BLine if it should be')
    ).toBeInTheDocument()
    expect(
      within(section()).getByText('findelivers R-88: In transit · past its delivery date')
    ).toBeInTheDocument()
    expect(within(section()).getByText(/^Last findelivers import: /)).toBeInTheDocument()
    expect(
      within(section()).getByText('November 2026: 9 delivered, $128.40 in BLine fees')
    ).toBeInTheDocument()
  })

  it('reads a findelivers file, lets each match be checked, and records it', async () => {
    const user = userEvent.setup()
    const onImported = vi.fn()
    const orders = [
      fileOrder({ id: 87, customerName: 'Sunny Day Cafe' }),
      fileOrder({ id: 86, customerName: 'Lovejoy Bakers' }),
      fileOrder({
        id: 84,
        customerName: 'Que Dice',
        blineRef: '261101.0003',
        blineStatus: 'delivered',
        deliveredAt: '2026-11-19T17:14:00Z',
      }),
      fileOrder({
        id: 79,
        customerName: 'Corner Cafe inside Rose City Books',
        address: '1005 W Alder St, Portland, OR 97209',
      }),
    ]
    actions.readFindeliversFile.mockResolvedValue({
      ok: true,
      rows: [
        fileRow({ ref: '261101.0007' }),
        fileRow({
          ref: '261101.0003',
          recipient: 'Que Dice',
          deliveredAt: '2026-11-19T17:14:00.000Z',
        }),
        fileRow({
          ref: '261030.0012',
          recipient: 'Corner Cafe Rose City',
          address: '1035 W Alder St, Portland, OR',
          deliveredAt: '2026-11-18T00:53:00.000Z',
        }),
        fileRow({
          ref: '261101.0020',
          recipient: 'Someone New',
          status: 'created',
          deliveredAt: null,
        }),
      ],
      matches: [
        { orderId: 86, confidence: 'sure', note: null },
        { orderId: 84, confidence: 'linked', note: null },
        {
          orderId: 79,
          confidence: 'check',
          note: 'Check the address: the app has 1005 W Alder St, Portland, OR 97209.',
        },
        { orderId: null, confidence: null, note: null },
      ],
      orders,
      pickups: 1,
      unreadable: 0,
    })
    actions.saveFindeliversFile.mockResolvedValue({
      ok: true,
      recorded: 3,
      delivered: 2,
      checkedOff: 2,
      problems: [],
      warnings: [],
    })
    render(<BlineDeliveries reloadKey={0} onImported={onImported} />)

    await user.click(await within(section()).findByRole('button', { name: 'Import findelivers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from findelivers' })
    const csv = 'shipperOrderId,status\n261101.0007,DELIVERED\n'
    await user.upload(
      within(dialog).getByLabelText('Choose file'),
      new File([csv], 'orders.csv', { type: 'text/csv' })
    )

    expect(
      await within(dialog).findByText('4 deliveries in the file, 1 pickup left out.')
    ).toBeInTheDocument()
    expect(actions.readFindeliversFile).toHaveBeenCalledWith(csv)

    // The linked row adds nothing, so it's listed, not asked about.
    expect(within(dialog).getByText('Already recorded (1)')).toBeInTheDocument()
    expect(
      within(dialog).getByText('261101.0003 · #84 Que Dice · Delivered Nov 19, 9:14 AM')
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('region', { name: 'findelivers 261101.0003' })
    ).not.toBeInTheDocument()

    const first = within(dialog).getByRole('region', { name: 'findelivers 261101.0007' })
    expect(within(first).getByText('Delivered Nov 20, 9:51 AM')).toBeInTheDocument()
    expect(within(first).getByRole('combobox', { name: 'Order' })).toHaveTextContent(
      /^#86 Lovejoy Bakers/
    )
    const mistyped = within(dialog).getByRole('region', { name: 'findelivers 261030.0012' })
    expect(
      within(mistyped).getByText(
        'Check the address: the app has 1005 W Alder St, Portland, OR 97209.'
      )
    ).toBeInTheDocument()
    const unknown = within(dialog).getByRole('region', { name: 'findelivers 261101.0020' })
    expect(within(unknown).getByText('Unassigned')).toBeInTheDocument()
    expect(within(unknown).getByText('Not recorded.')).toBeInTheDocument()
    // Sunny Day Cafe isn't delivered and no row is matched to it.
    expect(within(dialog).getByText('Not in this file (1)')).toBeInTheDocument()

    // Picking an order twice is caught before saving.
    await user.click(within(unknown).getByRole('combobox', { name: 'Order' }))
    await user.click(await screen.findByRole('option', { name: /^#86 Lovejoy Bakers/ }))
    expect(within(dialog).getAllByText('Picked for another row too.')).toHaveLength(2)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(within(unknown).getByRole('combobox', { name: 'Order' }))
    await user.click(await screen.findByRole('option', { name: /^#87 Sunny Day Cafe/ }))
    expect(within(dialog).queryByText('Not in this file (1)')).not.toBeInTheDocument()

    await saveWhenReady(dialog, user)
    expect(
      await within(dialog).findByText(
        'Recorded 3 rows. 2 newly delivered; 2 Trello cards checked off.'
      )
    ).toBeInTheDocument()
    expect(actions.saveFindeliversFile).toHaveBeenCalledWith(csv, [
      { ref: '261101.0007', orderId: 86 },
      { ref: '261101.0003', orderId: 84 },
      { ref: '261030.0012', orderId: 79 },
      { ref: '261101.0020', orderId: 87 },
    ])
    expect(onImported).toHaveBeenCalledTimes(1)

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it("shows why a file couldn't be read, and what couldn't be recorded", async () => {
    const user = userEvent.setup()
    actions.readFindeliversFile.mockResolvedValueOnce({ ok: false, error: 'That file is empty.' })
    render(<BlineDeliveries reloadKey={0} onImported={vi.fn()} />)

    await user.click(await within(section()).findByRole('button', { name: 'Import findelivers' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from findelivers' })
    const input = within(dialog).getByLabelText('Choose file')
    await user.upload(input, new File([''], 'empty.csv', { type: 'text/csv' }))
    expect(await within(dialog).findByText('That file is empty.')).toBeInTheDocument()
    await idle(dialog)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    actions.readFindeliversFile.mockResolvedValueOnce({
      ok: true,
      rows: [fileRow({ ref: 'R-1' })],
      matches: [{ orderId: 86, confidence: 'sure', note: null }],
      orders: [fileOrder({ id: 86 })],
      pickups: 0,
      unreadable: 0,
    })
    actions.saveFindeliversFile.mockResolvedValue({
      ok: true,
      recorded: 1,
      delivered: 1,
      checkedOff: 0,
      problems: [],
      warnings: ["Check off #86 Lovejoy Bakers's Trello card by hand (Trello API error: 401)."],
    })
    await user.upload(input, new File(['x'], 'orders.csv', { type: 'text/csv' }))
    await within(dialog).findByText('1 delivery in the file.')
    await saveWhenReady(dialog, user)
    expect(
      await within(dialog).findByText(
        "Check off #86 Lovejoy Bakers's Trello card by hand (Trello API error: 401)."
      )
    ).toBeInTheDocument()
  })
})
