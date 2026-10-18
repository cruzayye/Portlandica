import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const addBatch = vi.hoisted(() => vi.fn())

vi.mock('@/app/actions/batches', () => ({ addBatch }))

import AddBatchDialog from './AddBatchDialog'
import { batch, customer } from './testing/fixtures'

const customers = [
  customer({ id: 7, name: 'Cafe Yumm' }),
  customer({ id: 6, name: 'Rose City Taps', customCans: true }),
  customer({ id: 5, name: 'Dame', customCans: true }),
  customer({ id: 8, name: 'Closed Cafe', customCans: true, active: false }),
]

const onClose = vi.fn()
const onAdded = vi.fn()

const setup = () => {
  const user = userEvent.setup({ delay: null })
  render(
    <AddBatchDialog
      customers={customers}
      fillDate="2026-10-15"
      onClose={onClose}
      onAdded={onAdded}
    />
  )
  const dialog = screen.getByRole('dialog', { name: 'Add batch' })
  return {
    user,
    dialog,
    cases: () => within(dialog).getByLabelText(/^cases/i),
    pickSource: async (source: string) => {
      await user.click(within(dialog).getByRole('combobox', { name: /water source/i }))
      await user.click(screen.getByRole('option', { name: source }))
    },
    submit: () => user.click(within(dialog).getByRole('button', { name: 'Add batch' })),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('Add batch', () => {
  it('records house stock from cases, with the fill details', async () => {
    const added = batch({ id: 101, count: 1440 })
    addBatch.mockResolvedValue({ ok: true, batch: added })
    const { user, dialog, cases, pickSource, submit } = setup()

    expect(within(dialog).getByLabelText(/batch name/i)).toHaveValue('Portlandica')
    expect(within(dialog).getByLabelText(/fill date/i)).toHaveValue('2026-10-15')
    await user.type(cases(), '60')
    expect(within(dialog).getByText('= 1,440 cans · 1 pallet')).toBeInTheDocument()
    await pickSource('North Powder')
    await user.type(within(dialog).getByLabelText(/total cost/i), '1,200.50')
    await user.type(within(dialog).getByLabelText(/invoice number/i), ' INV-77 ')
    await user.type(within(dialog).getByLabelText(/^note/i), 'October run')
    await submit()

    expect(addBatch).toHaveBeenCalledWith({
      kind: 'house',
      product: 'still',
      cans: 1440,
      name: 'Portlandica',
      customerId: null,
      source: 'North Powder',
      fillDate: '2026-10-15',
      totalCost: 1200.5,
      invoiceNumber: 'INV-77',
      note: 'October run',
    })
    expect(onAdded).toHaveBeenCalledWith(added)
  })

  it('records custom cans for a customer picked from the list, not a typed name', async () => {
    addBatch.mockResolvedValue({ ok: true, batch: batch({ id: 102, isCustom: true }) })
    const { user, dialog, cases, pickSource, submit } = setup()

    await user.click(within(dialog).getByRole('button', { name: 'Custom cans' }))
    await user.click(within(dialog).getByRole('button', { name: 'Sparkling' }))
    expect(within(dialog).queryByLabelText(/batch name/i)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('combobox', { name: /customer/i }))
    // Custom-can customers first; inactive customers aren't offered.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Dame',
      'Rose City Taps',
      'Cafe Yumm',
    ])
    await user.click(screen.getByRole('option', { name: 'Rose City Taps' }))
    await user.type(cases(), '2.5')
    await pickSource('Opal Springs')
    await submit()

    expect(addBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'custom',
        product: 'sparkling',
        cans: 60,
        name: null,
        customerId: 6,
        source: 'Opal Springs',
      })
    )
  })

  it('offers still and sparkling only, so dog water is a house still batch by name', async () => {
    addBatch.mockResolvedValue({
      ok: true,
      batch: batch({ id: 103, name: 'Portlandica Dog water' }),
    })
    const { user, dialog, cases, pickSource, submit } = setup()

    const product = within(dialog).getByRole('group', { name: 'Product' })
    expect(
      within(product)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Still', 'Sparkling'])
    await user.clear(within(dialog).getByLabelText(/batch name/i))
    await user.type(within(dialog).getByLabelText(/batch name/i), 'Portlandica Dog water')
    await user.type(cases(), '10')
    await pickSource('North Powder')
    await submit()

    expect(addBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'house',
        product: 'still',
        name: 'Portlandica Dog water',
        cans: 240,
      })
    )
  })

  it('says what is missing instead of adding', async () => {
    const { user, dialog, cases, submit } = setup()

    await user.type(cases(), '2.1')
    expect(
      within(dialog).getByText('Enter cases that make whole cans (24 to a case).')
    ).toBeInTheDocument()
    await submit()
    expect(addBatch).not.toHaveBeenCalled()

    await user.clear(cases())
    await user.type(cases(), '10')
    await submit()
    expect(await within(dialog).findByText('Pick the water source.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Custom cans' }))
    await submit()
    expect(
      await within(dialog).findByText('Pick the customer these cans were filled for.')
    ).toBeInTheDocument()
    expect(addBatch).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the reason when the batch is not added', async () => {
    addBatch.mockResolvedValue({
      ok: false,
      error: 'That customer no longer exists. Refresh and pick again.',
    })
    const { user, dialog, cases, pickSource, submit } = setup()

    await user.type(cases(), '10')
    await pickSource('North Powder')
    await submit()

    expect(
      await within(dialog).findByText('That customer no longer exists. Refresh and pick again.')
    ).toBeInTheDocument()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('closes on cancel', async () => {
    const { user, dialog } = setup()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalled()
  })
})
