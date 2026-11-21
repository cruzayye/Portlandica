import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_ROWS,
  alreadyRecorded,
  blineStatusLabel,
  formatDeliveredAt,
  matchRows,
  normalizeStatus,
  notInFile,
  parseFindeliversCsv,
  parseFindeliversTime,
  trackingSummary,
  type FileOrder,
  type FindeliversRow,
} from './findelivers'

// findelivers' Orders CSV header, as downloaded in November 2026. The rows below are made up.
const HEADER =
  'generatedOrderId,shipperOrderId,status,createdAt,type,totalPackages,totalWeight,countStartDeliveryDate,recipientName,senderName,postCode,address,territory,depot,shipper,route,loadingArea,driver,driverRecipientNotes,driverAdminNotes,stopNumber,appointmentSlot,serviceTime,deliveredIn,originalEta,deliveredOn,signatureName,deliveryAttempts,failureReason,blockedReason,returnedToSenderReason,attempt1Date,attempt1FailureReason,attempt2Date,attempt2FailureReason,attempt3Date,attempt3FailureReason,rating,negativeReasons,customerComment,podRating,badPodReasons,handlingTags,confirmationPinUsed,confirmationPinBypassReason'
const COLUMNS = HEADER.split(',')

const csvLine = (values: Record<string, string>) =>
  COLUMNS.map((column) => {
    const value = values[column] ?? ''
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  }).join(',')

const fileOf = (...rows: Record<string, string>[]) => [HEADER, ...rows.map(csvLine)].join('\r\n')

const DELIVERED_ROW = {
  generatedOrderId: '261119-AAAAAA',
  shipperOrderId: '261119.0101',
  status: 'DELIVERED',
  createdAt: '11-19-2026 17:22',
  type: 'DROP-OFF',
  recipientName: 'Lovejoy Bakers',
  postCode: '97209',
  address: '939 NW 10th Ave, Portland, OR',
  deliveredOn: '11-20-2026 09:51',
}

const parsed = (text: string) => {
  const file = parseFindeliversCsv(text)
  if (!file.ok) throw new Error(file.error)
  return file
}

describe('parseFindeliversTime', () => {
  it("reads findelivers' times as Portland time, winter or summer", () => {
    expect(parseFindeliversTime('11-20-2026 09:51')).toEqual({
      at: '2026-11-20T17:51:00.000Z',
      on: '2026-11-20',
    })
    expect(parseFindeliversTime('07-01-2026 09:51')).toEqual({
      at: '2026-07-01T16:51:00.000Z',
      on: '2026-07-01',
    })
    // A late delivery is still that day in Portland.
    expect(parseFindeliversTime('11-09-2026 19:42')).toEqual({
      at: '2026-11-10T03:42:00.000Z',
      on: '2026-11-09',
    })
  })

  it('reads the way its screens write times, and times with a zone', () => {
    expect(parseFindeliversTime('11/19/2026, 17:22')?.at).toBe('2026-11-20T01:22:00.000Z')
    expect(parseFindeliversTime('2026-11-19 17:22:07')?.at).toBe('2026-11-20T01:22:07.000Z')
    expect(parseFindeliversTime('2026-11-20T03:42:00Z')).toEqual({
      at: '2026-11-20T03:42:00.000Z',
      on: '2026-11-19',
    })
  })

  it('reads nothing from blanks, impossible dates and other text', () => {
    for (const value of [
      '',
      '  ',
      null,
      undefined,
      '02-30-2026 10:00',
      '11-20-2026 24:00',
      'soon',
    ]) {
      expect(parseFindeliversTime(value)).toBeNull()
    }
  })
})

describe('parseFindeliversCsv', () => {
  it("reads each delivery: BLine's number, status, dates, recipient and address", () => {
    const file = parsed(`\uFEFF${fileOf(DELIVERED_ROW)}`)
    expect(file).toEqual({
      ok: true,
      pickups: 0,
      unreadable: 0,
      rows: [
        {
          ref: '261119.0101',
          status: 'delivered',
          createdAt: '2026-11-20T01:22:00.000Z',
          createdOn: '2026-11-19',
          recipient: 'Lovejoy Bakers',
          address: '939 NW 10th Ave, Portland, OR',
          postcode: '97209',
          deliveredAt: '2026-11-20T17:51:00.000Z',
          problem: null,
        },
      ],
    })
  })

  it('leaves out pickups, and says why a delivery failed', () => {
    const file = parsed(
      fileOf(
        DELIVERED_ROW,
        {
          ...DELIVERED_ROW,
          shipperOrderId: '261028.0005',
          type: 'PICK-UP',
          recipientName: '',
          senderName: 'Portlandica Water',
        },
        {
          ...DELIVERED_ROW,
          shipperOrderId: '261119.0102',
          status: 'FAILED_ATTEMPT',
          deliveredOn: '',
          attempt1FailureReason: 'REFUSED_BY_RECIPIENT',
        },
        {
          ...DELIVERED_ROW,
          shipperOrderId: '261119.0103',
          status: 'RETURNED_TO_SENDER',
          deliveredOn: '11-20-2026 12:00',
          failureReason: 'Wrong address',
        }
      )
    )
    expect(file.pickups).toBe(1)
    expect(
      file.rows.map(({ ref, status, deliveredAt, problem }) => ({
        ref,
        status,
        deliveredAt,
        problem,
      }))
    ).toEqual([
      {
        ref: '261119.0101',
        status: 'delivered',
        deliveredAt: '2026-11-20T17:51:00.000Z',
        problem: null,
      },
      {
        ref: '261119.0102',
        status: 'failed_attempt',
        deliveredAt: null,
        problem: 'Refused by recipient',
      },
      {
        ref: '261119.0103',
        status: 'returned_to_sender',
        deliveredAt: null,
        problem: 'Wrong address',
      },
    ])
  })

  it("uses Finmile's id when BLine's number is blank, and skips rows it can't use", () => {
    const file = parsed(
      fileOf(
        { ...DELIVERED_ROW, shipperOrderId: '' },
        DELIVERED_ROW,
        DELIVERED_ROW,
        { ...DELIVERED_ROW, shipperOrderId: '261119.0104', status: '' },
        { ...DELIVERED_ROW, shipperOrderId: 'two words' }
      )
    )
    expect(file.rows.map((row) => row.ref)).toEqual(['261119-AAAAAA', '261119.0101'])
    expect(file.unreadable).toBe(3)
  })

  it('reads quoted fields with commas, quotes and line breaks', () => {
    const file = parsed(
      fileOf({
        ...DELIVERED_ROW,
        recipientName: 'The "Good" Cafe, Inc.',
        address: '310 N Ivy St, Ste A,\nPortland, OR',
      })
    )
    expect(file.rows[0]).toMatchObject({
      recipient: 'The "Good" Cafe, Inc.',
      address: '310 N Ivy St, Ste A,\nPortland, OR',
    })
  })

  it("takes the column names findelivers' screens use", () => {
    const file = parsed(
      [
        'Order ID,Shipper order ID,Status,Created at,Order type,Recipient,Postcode,Address,Delivered On',
        '261119-AAAAAA,261119.0101,Completed,11-19-2026 17:22,Drop-off,Lovejoy Bakers,97209,"939 NW 10th Ave, Portland, OR",11-20-2026 09:51',
      ].join('\n')
    )
    expect(file.rows[0]).toMatchObject({
      ref: '261119.0101',
      status: 'delivered',
      deliveredAt: '2026-11-20T17:51:00.000Z',
    })
  })

  it("refuses a file that isn't findelivers' Orders CSV", () => {
    expect(parseFindeliversCsv('')).toEqual({ ok: false, error: 'That file is empty.' })
    expect(parseFindeliversCsv('name,amount\nLovejoy Bakers,12\n')).toEqual({
      ok: false,
      error:
        "That isn't findelivers' Orders CSV: it has no Shipper order ID, Status, Created at, Recipient, Address column. In findelivers, use Download CSV → Download Orders CSV.",
    })
    const tooMany = fileOf(
      ...Array.from({ length: MAX_FILE_ROWS + 1 }, (_, i) => ({
        ...DELIVERED_ROW,
        shipperOrderId: `R-${i}`,
      }))
    )
    expect(parseFindeliversCsv(tooMany)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/more than 1,000 rows/),
    })
  })
})

describe('normalizeStatus and blineStatusLabel', () => {
  it('stores statuses in lower case and shows them as findelivers does', () => {
    expect(normalizeStatus(' IN_TRANSIT ')).toBe('in_transit')
    expect(normalizeStatus('Failed attempt')).toBe('failed_attempt')
    expect(normalizeStatus('Completed')).toBe('delivered')
    expect(blineStatusLabel('created')).toBe('Unassigned')
    expect(blineStatusLabel('failed_attempt')).toBe('Failed attempt')
    expect(blineStatusLabel('out_for_pickup')).toBe('Out for pickup')
  })
})

describe('formatDeliveredAt', () => {
  it('shows the delivery time in Portland', () => {
    expect(formatDeliveredAt('2026-11-20T17:51:00.000Z')).toBe('Nov 20, 9:51 AM')
    expect(formatDeliveredAt('2026-11-10T03:42:00.000Z')).toBe('Nov 9, 7:42 PM')
  })
})

const row = (over: Partial<FindeliversRow> = {}): FindeliversRow => ({
  ref: '261119.0101',
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

const order = (over: Partial<FileOrder> & { id: number }): FileOrder => ({
  customerName: 'Lovejoy Bakers',
  address: '939 NW 10th Ave, Portland, OR 97209',
  orderDate: '2026-11-19',
  deliveryDate: null,
  totalCans: 96,
  voided: false,
  blineRef: null,
  blineStatus: null,
  blineProblem: null,
  deliveredAt: null,
  ...over,
})

describe('matchRows', () => {
  it('is sure when the address and the name match, however BLine spells them', () => {
    const orders = [
      order({ id: 1 }),
      order({
        id: 2,
        customerName: 'Juniper Foods',
        address: '2400 Northeast 15th Avenue Portland, OR 97212',
      }),
      order({
        id: 3,
        customerName: 'Bright Bean Coffeehouse & Social',
        address: '310 N Ivy St Suite A, Portland, OR 97227',
      }),
      order({
        id: 4,
        customerName: 'Corner Cafe inside Rose City Books',
        address: '1005 W Alder St, Portland, OR 97209',
      }),
    ]
    const rows = [
      row({
        ref: 'A',
        recipient: 'Juniper',
        address: '2400 NE 15th ave, Portland, OR',
        postcode: '97212',
      }),
      row({
        ref: 'B',
        recipient: 'Bright Bean Coffeehouse & Social',
        address: '310 N Ivy St, Ste A, Portland, OR',
        postcode: '97227',
      }),
      row({ ref: 'C', recipient: 'Lovejoy Bakers' }),
      row({
        ref: 'D',
        recipient: 'Corner Cafe Rose City',
        address: '1005 W Alder St, Portland, OR',
        postcode: '97209',
      }),
    ]
    expect(matchRows(rows, orders)).toEqual([
      { orderId: 2, confidence: 'sure', note: null },
      { orderId: 3, confidence: 'sure', note: null },
      { orderId: 1, confidence: 'sure', note: null },
      { orderId: 4, confidence: 'sure', note: null },
    ])
  })

  it('asks for a check when only part matches', () => {
    const orders = [
      order({
        id: 1,
        customerName: 'Corner Cafe inside Rose City Books',
        address: '1005 W Alder St, Portland, OR 97209',
      }),
      order({ id: 2, customerName: 'Que Dice', address: null }),
      order({
        id: 3,
        customerName: 'Sunny Day Cafe',
        address: '2200 NE Broadway, Portland, OR 97232',
      }),
    ]
    const rows = [
      // BLine typed the wrong street number.
      row({
        ref: 'A',
        recipient: 'Corner Cafe Rose City',
        address: '1035 W Alder St, Portland, OR',
      }),
      row({
        ref: 'B',
        recipient: 'Que Dice',
        address: '1 Somewhere Else, Portland, OR',
        postcode: '97201',
      }),
      row({
        ref: 'C',
        recipient: 'Front desk',
        address: '2200 NE Broadway, Portland, OR',
        postcode: '97232',
      }),
    ]
    expect(matchRows(rows, orders)).toEqual([
      {
        orderId: 1,
        confidence: 'check',
        note: 'Check the address: the app has 1005 W Alder St, Portland, OR 97209.',
      },
      { orderId: 2, confidence: 'check', note: 'Check the address: the app has none.' },
      { orderId: 3, confidence: 'check', note: 'Check the name: the app has Sunny Day Cafe.' },
    ])
  })

  it('leaves a row unmatched when nothing is close enough', () => {
    const orders = [
      order({
        id: 1,
        customerName: 'Green Grocer (Belmont)',
        address: '1200 SE Belmont St, Portland, OR 97214',
      }),
    ]
    const rows = [
      row({
        recipient: 'Green Grocer Hawthorne',
        address: '3300 SE Hawthorne Blvd, Portland, OR',
        postcode: '97214',
      }),
    ]
    expect(matchRows(rows, orders)).toEqual([{ orderId: null, confidence: null, note: null }])
  })

  it("matches a customer's orders to BLine's rows by date, one row each", () => {
    const orders = [
      order({ id: 54, orderDate: '2026-11-09' }),
      order({ id: 79, orderDate: '2026-11-17' }),
    ]
    const rows = [
      row({ ref: 'LATER', createdOn: '2026-11-17' }),
      row({ ref: 'EARLIER', createdOn: '2026-11-09' }),
      row({ ref: 'THIRD', createdOn: '2026-11-18' }),
    ]
    expect(matchRows(rows, orders).map((m) => m.orderId)).toEqual([79, 54, null])
  })

  it('only matches rows entered from a few days before an order to two weeks after it', () => {
    const orders = [order({ id: 1, orderDate: '2026-11-10' })]
    const at = (createdOn: string) => matchRows([row({ createdOn })], orders)[0].orderId
    expect(at('2026-11-06')).toBeNull()
    expect(at('2026-11-07')).toBe(1)
    expect(at('2026-11-24')).toBe(1)
    expect(at('2026-11-25')).toBeNull()
  })

  it('keeps rows an earlier import matched, and never offers those orders to other rows', () => {
    const orders = [
      order({
        id: 1,
        blineRef: 'OLD',
        customerName: 'Someone Else',
        address: '1 Main St, Portland, OR 97201',
      }),
      order({ id: 2, blineRef: 'GONE' }),
      order({ id: 3, voided: true, blineRef: 'VOID' }),
    ]
    const rows = [row({ ref: 'NEW' }), row({ ref: 'OLD' }), row({ ref: 'VOID' })]
    expect(matchRows(rows, orders)).toEqual([
      { orderId: null, confidence: null, note: null },
      { orderId: 1, confidence: 'linked', note: null },
      { orderId: null, confidence: null, note: 'This was order #3, which is void.' },
    ])
  })

  it('never matches a void order by address or name', () => {
    expect(matchRows([row()], [order({ id: 1, voided: true })])[0].orderId).toBeNull()
  })
})

describe('alreadyRecorded and notInFile', () => {
  it('knows when a row adds nothing', () => {
    const recorded = order({
      id: 1,
      blineRef: '261119.0101',
      blineStatus: 'delivered',
      deliveredAt: '2026-11-20T17:51:00+00:00',
    })
    expect(alreadyRecorded(row(), recorded)).toBe(true)
    expect(alreadyRecorded(row({ deliveredAt: '2026-11-20T18:00:00.000Z' }), recorded)).toBe(false)
    // An older file can't take a delivery back, so it adds nothing either.
    expect(alreadyRecorded(row({ status: 'in_transit', deliveredAt: null }), recorded)).toBe(true)
    expect(alreadyRecorded(row(), order({ id: 1 }))).toBe(false)
    const waiting = order({
      id: 1,
      blineRef: '261119.0101',
      blineStatus: 'failed_attempt',
      blineProblem: 'Closed',
    })
    expect(
      alreadyRecorded(
        row({ status: 'failed_attempt', deliveredAt: null, problem: 'Closed' }),
        waiting
      )
    ).toBe(true)
    expect(
      alreadyRecorded(
        row({ status: 'failed_attempt', deliveredAt: null, problem: 'Refused' }),
        waiting
      )
    ).toBe(false)
  })

  it('lists live orders not delivered yet that no row is matched to', () => {
    const orders = [
      order({ id: 1 }),
      order({ id: 2 }),
      order({ id: 3, deliveredAt: '2026-11-20T17:51:00Z' }),
      order({ id: 4, voided: true }),
    ]
    expect(notInFile(orders, [1]).map((o) => o.id)).toEqual([2])
  })
})

describe('trackingSummary', () => {
  const none = { deliveredAt: null, blineRef: null, blineStatus: null, blineProblem: null }

  it("says where a BLine order's delivery stands", () => {
    expect(trackingSummary(none)).toEqual({ text: 'Not in findelivers yet', warn: false })
    expect(trackingSummary({ ...none, blineRef: '261101.0008', blineStatus: 'created' })).toEqual({
      text: 'findelivers 261101.0008: Unassigned',
      warn: false,
    })
    expect(
      trackingSummary({
        ...none,
        blineRef: '261101.0008',
        blineStatus: 'failed_attempt',
        blineProblem: 'Refused by recipient',
      })
    ).toEqual({
      text: 'findelivers 261101.0008: Failed attempt (Refused by recipient)',
      warn: true,
    })
    expect(
      trackingSummary({
        deliveredAt: '2026-11-20T17:51:00Z',
        blineRef: '261101.0007',
        blineStatus: 'delivered',
        blineProblem: null,
      })
    ).toEqual({ text: 'Delivered Nov 20, 9:51 AM (findelivers 261101.0007)', warn: false })
  })

  it('says a delivery was marked by hand, and warns when findelivers disagrees', () => {
    expect(trackingSummary({ ...none, deliveredAt: '2026-11-21T01:00:00Z' })).toEqual({
      text: 'Marked delivered Nov 20',
      warn: false,
    })
    expect(
      trackingSummary({
        ...none,
        deliveredAt: '2026-11-21T01:00:00Z',
        blineRef: '261101.0008',
        blineStatus: 'created',
      })
    ).toEqual({ text: 'Marked delivered Nov 20 (findelivers 261101.0008: Unassigned)', warn: true })
  })
})
