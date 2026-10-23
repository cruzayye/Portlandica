import { describe, expect, it } from 'vitest'
import type { Customer, SalesOrderLine, SalesOrderWithLines } from '@/lib/db/types'
import {
  INVOICE_REMINDERS,
  draftInvoiceFor,
  invoiceMessage,
  invoicePacks,
  invoiceSeries,
  invoiceTitle,
} from './invoiceDraft'

const MAILING_ADDRESS =
  '**** MAILING ADDRESS ****\nPortlandica\nP.O. Box 5374\nPortland, OR 97228\n*********'

let nextLineId = 1
const line = (
  product: SalesOrderLine['product'],
  cans: number,
  unitPrice = 1.5,
  over: Partial<SalesOrderLine> = {}
): SalesOrderLine => ({
  id: nextLineId++,
  order_id: 1,
  product,
  cans,
  batch_id: 45,
  is_custom: false,
  unit_price: unitPrice,
  line_total: Math.round(cans * unitPrice * 100) / 100,
  created_at: '',
  ...over,
})
const customLine = (product: SalesOrderLine['product'], cans: number, unitPrice: number) =>
  line(product, cans, unitPrice, { is_custom: true })

const anOrder = (
  lines: SalesOrderLine[],
  over: Partial<SalesOrderWithLines> = {}
): SalesOrderWithLines => ({
  id: 14,
  idempotency_key: '1a2b3c4d-0000-4000-8000-000000000000',
  order_date: '2026-10-14',
  customer_id: 7,
  customer_name: 'Ironwood Coffee Company',
  type: 'business',
  delivery_type: 'drop',
  delivery_date: '2026-10-16',
  po_number: null,
  notes: 'Back door',
  total_cans: lines.reduce((sum, l) => sum + l.cans, 0),
  total_price: lines.reduce((sum, l) => sum + Math.round(l.line_total * 100), 0) / 100,
  is_paid: false,
  create_invoice: true,
  is_donation: false,
  sheet_status: 'done',
  sheet_error: null,
  inventory_status: 'done',
  inventory_error: null,
  trello_status: 'done',
  trello_error: null,
  trello_card_id: 'card-1',
  square_status: 'pending',
  square_error: null,
  square_invoice_id: null,
  voided_at: null,
  voided_by: null,
  void_reason: null,
  delivery_address: null,
  customer_email: null,
  sheet_ref: null,
  new_customer: false,
  created_by: null,
  created_at: '2026-10-14T18:30:00.000Z',
  updated_at: '2026-10-14T18:30:00.000Z',
  lines,
  ...over,
})

describe('invoiceMessage', () => {
  it("writes Paul's message: the cases, cans, price and total, the dates, then the mailing address", () => {
    expect(invoiceMessage(anOrder([line('still', 216), line('sparkling', 144)]))).toBe(
      [
        'Portlandica, order of 9 cases of Still and 6 cases of Sparkling (360 cans total) @ $1.50/can for a total of $540.',
        '',
        'Ordered: 10/14/2026',
        'Delivery by: 10/16/2026',
        '',
        MAILING_ADDRESS,
      ].join('\n')
    )
  })

  it('says case for one case', () => {
    expect(invoiceMessage(anOrder([line('still', 24), line('sparkling', 72)]))).toMatch(
      /^Portlandica, order of 1 case of Still and 3 cases of Sparkling \(96 cans total\) @ \$1\.50\/can for a total of \$144\.\n/
    )
  })

  it('names custom cans, with a price to a tenth of a cent and the cents of the total', () => {
    // Rose City Cinema at 17.05% off $2.00
    const order = anOrder([customLine('still', 240, 1.659), customLine('sparkling', 360, 1.659)])

    expect(invoiceMessage(order)).toMatch(
      /^Portlandica, order of 10 cases of Custom Still and 15 cases of Custom Sparkling \(600 cans total\) @ \$1\.659\/can for a total of \$995\.40\.\n/
    )
  })

  it('lists still and sparkling before custom cans, with commas for three', () => {
    const order = anOrder([customLine('still', 48, 2), line('sparkling', 24), line('still', 24)])

    expect(invoiceMessage(order)).toMatch(
      /^Portlandica, order of 1 case of Still, 1 case of Sparkling and 2 cases of Custom Still \(96 cans total\) for a total of \$168\.\n/
    )
  })

  it('adds up lines of the same product from different batches', () => {
    const order = anOrder([line('still', 48), line('still', 72, 1.5, { batch_id: 46 })])

    expect(invoiceMessage(order)).toMatch(
      /^Portlandica, order of 5 cases of Still \(120 cans total\)/
    )
  })

  it('writes thousands with commas and a pickup date for a pickup', () => {
    const order = anOrder([line('still', 1440)], {
      order_date: '2026-09-14',
      delivery_date: '2026-09-30',
      delivery_type: 'pickup',
    })

    expect(invoiceMessage(order)).toBe(
      [
        'Portlandica, order of 60 cases of Still (1,440 cans total) @ $1.50/can for a total of $2,160.',
        '',
        'Ordered: 9/14/2026',
        'Pickup by: 9/30/2026',
        '',
        MAILING_ADDRESS,
      ].join('\n')
    )
  })

  it('counts cans when they are not whole cases', () => {
    expect(invoiceMessage(anOrder([line('still', 36)]))).toMatch(
      /^Portlandica, order of 36 cans of Still \(36 cans total\) @ \$1\.50\/can for a total of \$54\.\n/
    )
  })

  it('leaves out the price when a typed total does not come to it', () => {
    // $500 typed for 300 cans: $1.6667 a can on the lines, but not exactly $500
    const order = anOrder(
      [
        line('still', 240, 1.6667, { line_total: 400.01 }),
        line('sparkling', 60, 1.6667, { line_total: 100 }),
      ],
      { total_price: 500 }
    )

    expect(invoiceMessage(order)).toMatch(
      /^Portlandica, order of 10 cases of Still and 60 cans of Sparkling \(300 cans total\) for a total of \$500\.\n/
    )
  })

  it('leaves out the delivery date when the order has none', () => {
    expect(invoiceMessage(anOrder([line('still', 24)], { delivery_date: null }))).toContain(
      '\n\nOrdered: 10/14/2026\n\n**** MAILING ADDRESS ****'
    )
  })
})

describe('invoiceTitle', () => {
  it('is the business, or the PO when the order has one', () => {
    expect(invoiceTitle({ po_number: null }, 'Pine Street Jewelers (Downtown)')).toBe(
      'Pine Street Jewelers (Downtown)'
    )
    expect(invoiceTitle({ po_number: ' 40012345 ' }, 'Sysco')).toBe('PO #40012345')
    expect(invoiceTitle({ po_number: 'PO-9' }, 'Sysco')).toBe('PO-9')
    expect(invoiceTitle({ po_number: 'P.O. 77' }, 'Sysco')).toBe('P.O. 77')
    expect(invoiceTitle({ po_number: 'POLAR1' }, 'Sysco')).toBe('PO #POLAR1')
  })
})

describe('invoiceSeries', () => {
  it.each([
    ['Northgate Apartments', 'NorthgateApartments'],
    ['Salt & Pine', 'Salt&Pine'],
    ["Mo's Roasted Coffee", 'MosRoastedCoffee'],
    ['Pine Street Jewelers (Downtown)', 'PineStreetJewelers'],
    ['12th Ave Bottle Shop', '12thAveBottleShop'],
    ['Café Lumen', 'CafeLumen'],
    ['b-side records', 'BSideRecords'],
    ['(  )', 'Invoice'],
  ])('starts %s at %s', (name, series) => {
    expect(invoiceSeries(name)).toBe(series)
  })
})

describe('invoicePacks', () => {
  it('bills whole 24 packs at what the order charges, still before sparkling', () => {
    expect(
      invoicePacks(anOrder([line('sparkling', 144), line('still', 216)]), 'Ironwood Coffee Company')
    ).toEqual([
      {
        item: '24 pack - Still',
        quantity: 9,
        amountCents: 32400,
        listPriceCents: 3600,
        discountName: 'Ironwood Coffee Company Discount',
      },
      {
        item: '24 pack - Sparkling',
        quantity: 6,
        amountCents: 21600,
        listPriceCents: 3600,
        discountName: 'Ironwood Coffee Company Discount',
      },
    ])
  })

  it('bills custom still and sparkling cans as one line of customized packs', () => {
    const order = anOrder([customLine('sparkling', 360, 1.659), customLine('still', 240, 1.659)])

    expect(invoicePacks(order, 'Rose City Cinema')).toEqual([
      {
        item: '24 pack - Customized Portland Water Can',
        quantity: 25,
        amountCents: 99540,
        listPriceCents: 4800,
        discountName: 'Rose City Cinema Discount',
      },
    ])
  })

  it('names the discount after the business, without its location', () => {
    const [pack] = invoicePacks(
      anOrder([line('still', 144, 1.35)]),
      'Pine Street Jewelers (Downtown)'
    )

    expect(pack).toMatchObject({
      quantity: 6,
      amountCents: 19440,
      discountName: 'Pine Street Jewelers Discount',
    })
    expect(pack).not.toHaveProperty('discountAsAmount')
  })

  it("rounds part-filled packs up, taking half a case at list price off as Paul's Half Case Order", () => {
    expect(invoicePacks(anOrder([line('still', 36), line('sparkling', 30)]), 'Dame')).toEqual([
      {
        item: '24 pack - Still',
        quantity: 2,
        amountCents: 5400,
        listPriceCents: 3600,
        discountName: 'Half Case Order',
        discountAsAmount: true,
      },
      {
        item: '24 pack - Sparkling',
        quantity: 2,
        amountCents: 4500,
        listPriceCents: 3600,
        discountName: 'Dame Discount',
        discountAsAmount: true,
      },
    ])
  })

  it("keeps the customer's discount on half a case at their own price", () => {
    expect(
      invoicePacks(anOrder([line('still', 12, 1.35)]), 'Pine Street Jewelers (Downtown)')
    ).toEqual([
      expect.objectContaining({
        quantity: 1,
        amountCents: 1620,
        discountName: 'Pine Street Jewelers Discount',
        discountAsAmount: true,
      }),
    ])
  })

  it('charges what the Sales rows show for a typed total', () => {
    // A typed $500 over custom still at $2 and sparkling at $1.50, as lineAmounts splits it
    const order = anOrder(
      [customLine('still', 240, 1.8116), line('sparkling', 48, 1.3587, { line_total: 65.22 })],
      { total_price: 500 }
    )

    expect(invoicePacks(order, 'Que Dice').map((pack) => pack.amountCents)).toEqual([6522, 43478])
  })
})

describe('draftInvoiceFor', () => {
  const customer = {
    id: 7,
    name: 'Rose City Cinema',
    email: 'box-office@rosecity.example',
    square_customer_id: 'SQ-ROSECITY',
    payment_terms_days: null,
    type: 'business',
  } as Customer

  it("is the order's whole draft: the business's terms, title, message, number series and Paul's reminders", () => {
    const order = anOrder([customLine('still', 816, 1.659)], {
      customer_name: 'Rose City Cinema',
      order_date: '2026-10-20',
      delivery_date: '2026-10-24',
    })

    expect(draftInvoiceFor(order, customer)).toEqual({
      orderDate: new Date('2026-10-14T18:30:00.000Z'),
      customer: {
        name: 'Rose City Cinema',
        email: 'box-office@rosecity.example',
        squareCustomerId: 'SQ-ROSECITY',
        paymentTermsDays: 30,
      },
      lines: [
        {
          item: '24 pack - Customized Portland Water Can',
          quantity: 34,
          amountCents: 135374,
          listPriceCents: 4800,
          discountName: 'Rose City Cinema Discount',
        },
      ],
      title: 'Rose City Cinema',
      message: [
        'Portlandica, order of 34 cases of Custom Still (816 cans total) @ $1.659/can for a total of $1,353.74.',
        '',
        'Ordered: 10/20/2026',
        'Delivery by: 10/24/2026',
        '',
        MAILING_ADDRESS,
      ].join('\n'),
      serviceDate: '2026-10-20',
      invoiceNumber: { series: 'RoseCityCinema' },
      reminders: INVOICE_REMINDERS,
      savePaymentMethod: true,
    })
  })

  it("bills the order's email and name when there is no customer record", () => {
    const order = anOrder([line('still', 24)], {
      customer_name: 'Pat Doe',
      type: 'individual',
      customer_email: 'pat@example.com',
    })

    expect(draftInvoiceFor(order, null)).toMatchObject({
      customer: {
        name: 'Pat Doe',
        email: 'pat@example.com',
        squareCustomerId: null,
        paymentTermsDays: 0,
      },
      title: 'Pat Doe',
      invoiceNumber: { series: 'PatDoe' },
    })
  })

  it("has Paul's five reminders: on the due date, then 1, 2, 7 and 30 days late", () => {
    expect(INVOICE_REMINDERS.map((r) => r.days)).toEqual([0, 1, 2, 7, 30])
    expect(INVOICE_REMINDERS[0].message).toMatch(
      /^Hey, this invoice for Portlandica is outstanding\./
    )
    expect(INVOICE_REMINDERS[4].message).toMatch(
      /^Hey, this invoice for Portlandica is really overdue\./
    )
  })
})
