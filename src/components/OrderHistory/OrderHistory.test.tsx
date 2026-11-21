import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SalesOrderWithLines } from '@/lib/db/types'
import type { OrderHistory as History } from '@/types/orders'
import { SIGNED_OUT } from '@/lib/auth/authFailure'

const listOrders = vi.fn()
const retryOrder = vi.fn()
const voidOrder = vi.fn()

const markOrderDelivered = vi.fn()
const clearOrderDelivery = vi.fn()

vi.mock('@/app/actions/orderHistory', () => ({
  listOrders: () => listOrders(),
  retryOrder: (...args: unknown[]) => retryOrder(...args),
  voidOrder: (...args: unknown[]) => voidOrder(...args),
}))
vi.mock('@/app/actions/blineTracking', () => ({
  markOrderDelivered: (...args: unknown[]) => markOrderDelivered(...args),
  clearOrderDelivery: (...args: unknown[]) => clearOrderDelivery(...args),
}))

import OrderHistory from './OrderHistory'

const order = (over: Partial<SalesOrderWithLines> = {}): SalesOrderWithLines =>
  ({
    id: 12,
    idempotency_key: 'key-12',
    order_date: '2026-10-15',
    customer_id: 1,
    customer_name: 'Lovejoy Bakers',
    type: 'business',
    delivery_type: 'drop',
    delivery_date: '2026-10-21',
    po_number: null,
    notes: null,
    total_cans: 168,
    total_price: 252,
    is_paid: false,
    create_invoice: false,
    is_donation: false,
    sheet_status: 'done',
    sheet_error: null,
    sheet_ref: 'Sales!A3126:V3127',
    inventory_status: 'done',
    inventory_error: null,
    trello_status: 'done',
    trello_error: null,
    trello_card_id: 'card-1',
    square_status: 'skipped',
    square_error: null,
    square_invoice_id: null,
    voided_at: null,
    voided_by: null,
    void_reason: null,
    delivery_address: null,
    customer_email: null,
    new_customer: false,
    delivery_fee: null,
    delivered_at: null,
    bline_ref: null,
    bline_status: null,
    bline_problem: null,
    bline_checked_at: null,
    created_by: null,
    created_at: '2026-10-15T18:00:00Z',
    updated_at: '2026-10-15T18:00:00Z',
    lines: [
      {
        id: 1,
        order_id: 12,
        product: 'still',
        cans: 120,
        batch_id: 45,
        is_custom: false,
        unit_price: 1.5,
        line_total: 180,
        created_at: '',
      },
      {
        id: 2,
        order_id: 12,
        product: 'sparkling',
        cans: 48,
        batch_id: 25,
        is_custom: false,
        unit_price: 1.5,
        line_total: 72,
        created_at: '',
      },
    ],
    ...over,
  }) as SalesOrderWithLines

const history = (orders: SalesOrderWithLines[]): History => ({
  orders,
  batches: [
    { id: 45, name: 'Portlandica', isStill: true, fillDate: '2026-09-26' },
    { id: 25, name: 'North Powder', isStill: false, fillDate: '2026-08-03' },
  ],
  error: null,
})

beforeEach(() => {
  listOrders.mockReset()
  retryOrder.mockReset()
  voidOrder.mockReset()
  markOrderDelivered.mockReset()
  clearOrderDelivery.mockReset()
})

describe('OrderHistory', () => {
  it('lists orders with their batches and how each step went', async () => {
    listOrders.mockResolvedValue(history([order()]))
    render(<OrderHistory />)

    const card = await screen.findByRole('article', { name: 'Order 12' })
    expect(within(card).getByText('Lovejoy Bakers')).toBeInTheDocument()
    expect(within(card).getByText('#12 · 10/15/2026 · Drop 10/21/2026')).toBeInTheDocument()
    expect(within(card).getByText('$252.00')).toBeInTheDocument()
    expect(
      within(card).getByText(
        '120 cans from Portlandica Still · 48 cans from North Powder Sparkling'
      )
    ).toBeInTheDocument()
    expect(within(card).getByText('Sales sheet: done')).toBeInTheDocument()
    expect(within(card).getByText('Sales sheet: Sales rows 3126–3127')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument()
    // Only BLine orders are tracked.
    expect(within(card).queryByRole('button', { name: 'Mark delivered' })).not.toBeInTheDocument()
  })

  it('shows where a BLine delivery stands, and marks it delivered by hand', async () => {
    const user = userEvent.setup()
    const waiting = order({
      delivery_type: 'bline',
      delivery_fee: 25.2,
      bline_ref: '261101.0008',
      bline_status: 'created',
    })
    listOrders.mockResolvedValue(history([waiting]))
    markOrderDelivered.mockResolvedValue({
      status: 'done',
      order: { ...waiting, delivered_at: '2026-11-20T22:00:00Z' },
      warnings: ["Check off this order's Trello card by hand (Trello API error: 401)."],
    })
    render(<OrderHistory />)

    const card = await screen.findByRole('article', { name: 'Order 12' })
    expect(within(card).getByText('findelivers 261101.0008: Unassigned')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Mark delivered' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mark #12 delivered?' })
    await user.click(within(dialog).getByRole('button', { name: 'Mark delivered' }))

    expect(
      await within(card).findByText('Marked delivered Nov 20 (findelivers 261101.0008: Unassigned)')
    ).toBeInTheDocument()
    expect(markOrderDelivered).toHaveBeenCalledWith(12)
    expect(
      within(card).getByText("Check off this order's Trello card by hand (Trello API error: 401).")
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it("clears a BLine order's delivery, and says when it can't", async () => {
    const user = userEvent.setup()
    const delivered = order({
      delivery_type: 'bline',
      delivery_fee: 25.2,
      delivered_at: '2026-11-20T17:51:00Z',
      bline_ref: '261101.0007',
      bline_status: 'delivered',
    })
    listOrders.mockResolvedValue(history([delivered]))
    clearOrderDelivery.mockResolvedValueOnce({ status: 'failed', message: 'No such order.' })
    clearOrderDelivery.mockResolvedValueOnce({
      status: 'done',
      order: { ...delivered, delivered_at: null, bline_ref: null, bline_status: null },
      warnings: [],
    })
    render(<OrderHistory />)

    const card = await screen.findByRole('article', { name: 'Order 12' })
    expect(
      within(card).getByText('Delivered Nov 20, 9:51 AM (findelivers 261101.0007)')
    ).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Clear' }))
    const dialog = await screen.findByRole('dialog', { name: "Clear #12's delivery?" })
    await user.click(within(dialog).getByRole('button', { name: 'Clear' }))
    expect(await within(dialog).findByText('No such order.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Clear' }))
    expect(await within(card).findByText('Not in findelivers yet')).toBeInTheDocument()
    expect(clearOrderDelivery).toHaveBeenCalledWith(12)
  })

  it("shows a BLine order's fee, and reminds us to call off the delivery once void", async () => {
    listOrders.mockResolvedValue(
      history([
        order({ delivery_type: 'bline', delivery_fee: 25.2 }),
        order({
          id: 13,
          delivery_type: 'bline',
          delivery_fee: 10,
          voided_at: '2026-10-15T19:00:00Z',
          void_reason: 'Customer cancelled',
        }),
      ])
    )
    render(<OrderHistory />)

    const live = await screen.findByRole('article', { name: 'Order 12' })
    expect(
      within(live).getByText('#12 · 10/15/2026 · BLine 10/21/2026 ($25.20 fee)')
    ).toBeInTheDocument()
    expect(within(live).queryByText(/Email BLine/)).not.toBeInTheDocument()
    const voided = screen.getByRole('article', { name: 'Order 13' })
    expect(
      within(voided).getByText(
        'Email BLine to call off this delivery, if they already have it (its rows are no longer in italics).'
      )
    ).toBeInTheDocument()
  })

  it('says when an order was invoiced outside Square', async () => {
    listOrders.mockResolvedValue(
      history([order({ create_invoice: true, square_status: 'skipped', invoicedOutsideSquare: true })])
    )
    render(<OrderHistory />)

    const card = await screen.findByRole('article', { name: 'Order 12' })
    expect(within(card).getByText('Square: Invoiced outside Square; no draft made')).toBeInTheDocument()
  })

  it('retries what failed and shows the result', async () => {
    listOrders.mockResolvedValue(
      history([order({ sheet_status: 'failed', sheet_error: 'Sheets API 503', sheet_ref: null })])
    )
    retryOrder.mockResolvedValue({ status: 'done', order: order(), warnings: [], shortfalls: [] })
    const user = userEvent.setup({ delay: null })
    render(<OrderHistory />)

    expect(await screen.findByText('Sales sheet: Sheets API 503')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry Sales sheet' }))

    await waitFor(() =>
      expect(retryOrder).toHaveBeenCalledWith(12, { allowNegativeInventory: false })
    )
    expect(await screen.findByText('Sales sheet: done')).toBeInTheDocument()
  })

  it('takes cans a batch does not have only after asking', async () => {
    const short = order({
      inventory_status: 'failed',
      inventory_error: 'Portlandica Still has 60 cans left',
    })
    listOrders.mockResolvedValue(history([short]))
    retryOrder
      .mockResolvedValueOnce({
        status: 'done',
        order: short,
        warnings: [],
        shortfalls: [{ batchId: 45, batchName: 'Portlandica Still', available: 60, needed: 120 }],
      })
      .mockResolvedValueOnce({ status: 'done', order: order(), warnings: [], shortfalls: [] })
    const user = userEvent.setup({ delay: null })
    render(<OrderHistory />)

    await user.click(await screen.findByRole('button', { name: 'Retry Inventory' }))
    expect(
      await screen.findByText('Portlandica Still has 60 cans left; this order needs 120.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Take them anyway' }))

    await waitFor(() =>
      expect(retryOrder).toHaveBeenLastCalledWith(12, { allowNegativeInventory: true })
    )
    expect(await screen.findByText('Inventory: done')).toBeInTheDocument()
  })

  it('voids an order with a reason and lists what to fix by hand', async () => {
    listOrders.mockResolvedValue(history([order()]))
    voidOrder.mockResolvedValue({
      status: 'voided',
      order: order({ voided_at: '2026-10-15T19:00:00Z', void_reason: 'Entered twice' }),
      handFixes: [
        "Sales rows 3126–3127 still show this order. Fix them by hand (the app doesn't edit Sales rows).",
      ],
    })
    const user = userEvent.setup({ delay: null })
    render(<OrderHistory />)

    await user.click(await screen.findByRole('button', { name: 'Void' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Void Order' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Why?'), 'Entered twice')
    await user.click(within(dialog).getByRole('button', { name: 'Void Order' }))

    await waitFor(() => expect(voidOrder).toHaveBeenCalledWith(12, 'Entered twice'))
    expect(await screen.findByText('Void: Entered twice')).toBeInTheDocument()
    expect(screen.getByText(/Sales rows 3126–3127 still show this order/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument()
  })

  it('reminds what a void left to fix after a reload', async () => {
    listOrders.mockResolvedValue(
      history([
        order({
          voided_at: '2026-10-15T19:00:00Z',
          void_reason: 'Customer cancelled',
          create_invoice: true,
          square_status: 'done',
          square_invoice_id: 'inv-1',
        }),
      ])
    )
    render(<OrderHistory />)

    expect(await screen.findByText('Void: Customer cancelled')).toBeInTheDocument()
    expect(
      screen.getByText('Sales rows 3126–3127 still show this order: fix them by hand.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Its Square invoice wasn't deleted: delete it in Square if it's still a draft, or cancel or refund it by hand."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/draft invoice was deleted/)).not.toBeInTheDocument()
  })

  it('says when a void deleted the Square draft', async () => {
    listOrders.mockResolvedValue(history([order()]))
    voidOrder.mockResolvedValue({
      status: 'voided',
      order: order({
        voided_at: '2026-10-15T19:00:00Z',
        void_reason: 'Customer cancelled',
        create_invoice: true,
        square_status: 'skipped',
        square_invoice_id: 'inv-1',
      }),
      handFixes: [],
    })
    const user = userEvent.setup({ delay: null })
    render(<OrderHistory />)

    await user.click(await screen.findByRole('button', { name: 'Void' }))
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Why?'), 'Customer cancelled')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Void Order' }))

    expect(await screen.findByText('Its draft invoice was deleted in Square.')).toBeInTheDocument()
    expect(screen.queryByText(/Square invoice wasn't deleted/)).not.toBeInTheDocument()
  })

  it('shows why orders could not be loaded', async () => {
    listOrders.mockResolvedValue({ authError: SIGNED_OUT })
    render(<OrderHistory />)
    expect(await screen.findByText(SIGNED_OUT)).toBeInTheDocument()
  })

  it('says when there are no orders yet', async () => {
    listOrders.mockResolvedValue(history([]))
    render(<OrderHistory />)
    expect(await screen.findByText('No orders yet.')).toBeInTheDocument()
  })
})
