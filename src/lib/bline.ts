import { splitCents } from '@/lib/orders'

// BLine delivers some local orders from the pallets it keeps for us. We still invoice the
// customer; BLine bills us for each delivery: a flat $10 when the order is under $100,
// otherwise 10% of it (the two agree at exactly $100). Pure: safe on the server and in the
// browser.

export const BLINE_FLAT_FEE = 10
export const BLINE_FLAT_FEE_UNDER = 100
export const BLINE_FEE_RATE = 0.1

/** Under this many cans of a product at BLine, the Inventory tab says to send more. */
export const BLINE_LOW_STOCK_CANS = 240

/** What to do by hand when a BLine order is voided: we email BLine the deliveries. */
export const BLINE_CANCEL = 'Email BLine to call off this delivery, if they already have it.'

/** What BLine charges to deliver an order of this total, in dollars, to the cent. */
export const blineFee = (orderTotal: number) => {
  const totalCents = Math.round(orderTotal * 100)
  return totalCents < BLINE_FLAT_FEE_UNDER * 100
    ? BLINE_FLAT_FEE
    : Math.round(totalCents * BLINE_FEE_RATE) / 100
}

const money = (dollars: number) =>
  dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** "$10.00 (flat fee under $100)" or "$14.40 (10% of $144.00)". */
export const blineFeeNote = (orderTotal: number) =>
  Math.round(orderTotal * 100) < BLINE_FLAT_FEE_UNDER * 100
    ? `${money(BLINE_FLAT_FEE)} (flat fee under $${BLINE_FLAT_FEE_UNDER})`
    : `${money(blineFee(orderTotal))} (${Math.round(BLINE_FEE_RATE * 100)}% of ${money(orderTotal)})`

/** An order's BLine fee spread over its Sales rows in proportion to their amounts. */
export const feePerRow = (fee: number, rowAmounts: number[]) =>
  rowAmounts.some((amount) => amount > 0)
    ? splitCents(fee, rowAmounts)
    : splitCents(
        fee,
        rowAmounts.map(() => 1)
      )

/** The Notes the Sales or Donations rows of a BLine order get: the order's notes, marked. */
export const blineNotes = (notes: string | null, fee: number | null, isDonation: boolean) => {
  const mark = isDonation && fee !== null ? `BLine delivery (${money(fee)} fee)` : 'BLine delivery'
  return notes ? `${mark} · ${notes}` : mark
}
