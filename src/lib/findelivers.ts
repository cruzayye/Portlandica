import { DELIVERY_TIME_ZONE, pacificDate, pacificWallTime } from '@/lib/delivery'

// findelivers.com is the delivery software BLine uses (Finmile's). Our login there can
// download an Orders CSV: one row per delivery BLine has for us, with its status and when it
// was delivered. This reads that file and matches its rows to our BLine orders. BLine types
// our orders in by hand, under its own numbers and spellings, so a row is matched on the
// address, the name and the dates until an import ties it to an order by its number.
// Pure: safe on the server and in the browser.

/** A delivery in the file. */
export type FindeliversRow = {
  /** BLine's number for it, the "Shipper order ID" (e.g. 261101.0007), else Finmile's own id. */
  ref: string
  /** Lower case: created, in_transit, delivered, failed_attempt, ... */
  status: string
  /** When BLine entered it, ISO. */
  createdAt: string | null
  /** The day BLine entered it, in Portland: YYYY-MM-DD. */
  createdOn: string | null
  recipient: string
  address: string
  postcode: string | null
  /** When it was delivered, ISO. Delivered rows only. */
  deliveredAt: string | null
  /** Why the last attempt failed, or why it was returned or blocked. */
  problem: string | null
}

export type FindeliversFile =
  | {
      ok: true
      rows: FindeliversRow[]
      /** Pickups (BLine collecting pallets from us), left out. */
      pickups: number
      /** Rows with no number or status, left out. */
      unreadable: number
    }
  | { ok: false; error: string }

/** A BLine order as the import matches and shows it. */
export type FileOrder = {
  id: number
  customerName: string
  address: string | null
  /** YYYY-MM-DD */
  orderDate: string
  /** YYYY-MM-DD: the delivery date it was booked for, if one was picked. */
  deliveryDate: string | null
  totalCans: number
  voided: boolean
  blineRef: string | null
  blineStatus: string | null
  blineProblem: string | null
  deliveredAt: string | null
}

/** What a row is matched to. */
export type RowMatch = {
  orderId: number | null
  /**
   * linked: an earlier import tied them by number. sure: the address and the name match.
   * check: only part of it matches; note says what to look at.
   */
  confidence: 'linked' | 'sure' | 'check' | null
  note: string | null
}

/** More rows than this and the file is refused: download a shorter date range. */
export const MAX_FILE_ROWS = 1000
/** Bigger files than this (in characters) are refused before reading. */
export const MAX_FILE_CHARS = 2_000_000

// ---------------------------------------------------------------------------------------
// Reading the file

/** Rows of fields, per RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
const csvRecords = (text: string) => {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else field += char
  }
  if (field !== '' || record.length) {
    record.push(field)
    records.push(record)
  }
  return records.filter((r) => r.some((value) => value.trim() !== ''))
}

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '')

// Each field by the names findelivers' Orders CSV gives it ("shipperOrderId"), and by the
// names its screens show ("Shipper order ID"), compared without case, spaces or punctuation.
const COLUMNS = {
  ref: ['shipperorderid'],
  finmileId: ['generatedorderid', 'orderid'],
  status: ['status'],
  createdAt: ['createdat', 'createdon'],
  type: ['type', 'ordertype'],
  recipient: ['recipientname', 'recipient'],
  address: ['address', 'deliveryaddress'],
  postcode: ['postcode', 'zip', 'zipcode'],
  deliveredOn: ['deliveredon'],
  failureReason: ['failurereason'],
  attempt3: ['attempt3failurereason'],
  attempt2: ['attempt2failurereason'],
  attempt1: ['attempt1failurereason'],
  returned: ['returnedtosenderreason'],
  blocked: ['blockedreason'],
} as const

type Column = keyof typeof COLUMNS

const COLUMN_NAMES: Partial<Record<Column, string>> = {
  status: 'Status',
  createdAt: 'Created at',
  recipient: 'Recipient',
  address: 'Address',
}

const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
// The Orders CSV writes "11-19-2026 17:22"; its screens write "11/19/2026, 17:22".
const US_WALL_TIME = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
const ISO_WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A findelivers time as an ISO instant and its day in Portland. Times without a zone are
 * Portland time: what findelivers shows for BLine's Portland depot.
 */
export const parseFindeliversTime = (
  value: string | null | undefined
): { at: string; on: string } | null => {
  const text = (value ?? '').trim()
  if (!text) return null
  if (ISO_ZONED.test(text)) {
    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? null : { at: date.toISOString(), on: pacificDate(date) }
  }
  const us = US_WALL_TIME.exec(text)
  const iso = us ? null : ISO_WALL_TIME.exec(text)
  const fields = us
    ? [us[3], us[1], us[2], us[4], us[5], us[6]]
    : iso
      ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
      : null
  if (!fields) return null
  const [year, month, day, hour, minute, second] = fields.map((part) => Number(part ?? 0))
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null
  }
  return {
    at: pacificWallTime(year, month, day, hour, minute, second).toISOString(),
    on: `${year}-${pad(month)}-${pad(day)}`,
  }
}

/** findelivers' statuses as stored: "FAILED_ATTEMPT" → "failed_attempt". */
export const normalizeStatus = (value: string) => {
  const status = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  // Its screens call a delivered order Completed.
  return status === 'completed' ? 'delivered' : status
}

// Reasons may come as codes ("REFUSED_BY_RECIPIENT") or words ("Refused by recipient").
const reasonText = (value: string) => {
  const text = value.trim()
  if (!/^[A-Z0-9_]+$/.test(text)) return text
  const words = text.replace(/_+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Read findelivers' Orders CSV (Orders → Download CSV → Download Orders CSV). */
export const parseFindeliversCsv = (text: string): FindeliversFile => {
  if (text.length > MAX_FILE_CHARS) {
    return {
      ok: false,
      error: 'That file is too big for an Orders CSV. Download a shorter date range.',
    }
  }
  const [headers, ...records] = csvRecords(text.replace(/^\uFEFF/, ''))
  if (!headers) return { ok: false, error: 'That file is empty.' }

  const keys = headers.map(headerKey)
  const index = Object.fromEntries(
    Object.entries(COLUMNS).map(([column, names]) => [
      column,
      (names as readonly string[]).map((name) => keys.indexOf(name)).find((i) => i >= 0) ?? -1,
    ])
  ) as Record<Column, number>

  const missing = (Object.keys(COLUMN_NAMES) as Column[]).filter((column) => index[column] < 0)
  if (index.ref < 0 && index.finmileId < 0) missing.unshift('ref')
  if (missing.length) {
    const names = missing.map((column) => COLUMN_NAMES[column] ?? 'Shipper order ID')
    return {
      ok: false,
      error: `That isn't findelivers' Orders CSV: it has no ${names.join(', ')} column. In findelivers, use Download CSV → Download Orders CSV.`,
    }
  }
  if (records.length > MAX_FILE_ROWS) {
    return {
      ok: false,
      error: `That file has more than ${MAX_FILE_ROWS.toLocaleString('en-US')} rows. Download a shorter date range.`,
    }
  }

  const rows: FindeliversRow[] = []
  const seen = new Set<string>()
  let pickups = 0
  let unreadable = 0
  for (const record of records) {
    const field = (column: Column) =>
      index[column] >= 0 ? (record[index[column]] ?? '').trim() : ''
    if (/^pick\W*up$/i.test(field('type'))) {
      pickups++
      continue
    }
    const ref = field('ref') || field('finmileId')
    const status = normalizeStatus(field('status'))
    if (!ref || /\s/.test(ref) || ref.length > 64 || !/^[a-z]/.test(status) || seen.has(ref)) {
      unreadable++
      continue
    }
    seen.add(ref)
    const created = parseFindeliversTime(field('createdAt'))
    const delivered = status === 'delivered' ? parseFindeliversTime(field('deliveredOn')) : null
    const problem =
      status === 'delivered'
        ? ''
        : ([
            field('failureReason'),
            field('attempt3'),
            field('attempt2'),
            field('attempt1'),
            field('returned'),
            field('blocked'),
          ].find(Boolean) ?? '')
    rows.push({
      ref,
      status,
      createdAt: created?.at ?? null,
      createdOn: created?.on ?? null,
      recipient: field('recipient'),
      address: field('address'),
      postcode: field('postcode') || null,
      deliveredAt: delivered?.at ?? null,
      problem: problem ? reasonText(problem) : null,
    })
  }
  return { ok: true, rows, pickups, unreadable }
}

// ---------------------------------------------------------------------------------------
// Matching rows to orders

const DIRECTIONS = new Set([
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
  'north',
  'south',
  'east',
  'west',
  'northeast',
  'northwest',
  'southeast',
  'southwest',
])
const STREET_TYPES = new Set([
  'st',
  'street',
  'ave',
  'av',
  'avenue',
  'rd',
  'road',
  'dr',
  'drive',
  'blvd',
  'boulevard',
  'pl',
  'place',
  'ct',
  'court',
  'ln',
  'lane',
  'hwy',
  'highway',
  'pkwy',
  'parkway',
  'ter',
  'terrace',
  'way',
  'cir',
  'circle',
  'loop',
  'sq',
  'square',
  'trl',
  'trail',
  'aly',
  'alley',
])
const UNIT_WORDS = new Set([
  'suite',
  'ste',
  'unit',
  'apt',
  'apartment',
  'fl',
  'floor',
  'bldg',
  'building',
  'rm',
  'room',
  'space',
  'spc',
])

type Address = { number: string | null; names: string[]; zip: string | null }

/**
 * "310 N Ivy St, Ste A, Portland, OR 97227" → number 310, street name [ivy], zip
 * 97227. The street name stops at its type (St, Ave) or a unit (Suite), so a city after it
 * doesn't count; directions don't either (Northeast and NE are the same).
 */
const parseAddress = (text: string | null, postcode: string | null = null): Address => {
  const full = text ?? ''
  const zip =
    /^\s*(\d{5})/.exec(postcode ?? '')?.[1] ?? /[\s,](\d{5})(?:-\d{4})?\s*$/.exec(full)?.[1] ?? null
  const tokens = (full.split(',')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .split(' ')
    .filter(Boolean)
  const number = tokens[0] && /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0].replace(/[a-z]$/, '') : null
  const names: string[] = []
  for (const token of number ? tokens.slice(1) : tokens) {
    if (UNIT_WORDS.has(token) || token.startsWith('#') || STREET_TYPES.has(token)) break
    if (!DIRECTIONS.has(token)) names.push(token)
  }
  return { number, names, zip }
}

/** 1: same number and street. 0.5: same street, different number. 0.1: same zip only. */
const addressScore = (a: Address, b: Address) => {
  const sameStreet = a.names.some((name) => b.names.includes(name))
  const zipsDiffer = Boolean(a.zip && b.zip && a.zip !== b.zip)
  if (a.number && b.number && sameStreet) {
    if (zipsDiffer) return 0.25
    return a.number === b.number ? 1 : 0.5
  }
  return a.zip && a.zip === b.zip ? 0.1 : 0
}

const NAME_FILLER = new Set([
  'the',
  'of',
  'and',
  'at',
  'in',
  'inside',
  'a',
  'llc',
  'inc',
  'co',
  'company',
  'corp',
])

const nameWords = (name: string) =>
  new Set(
    name
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word && !NAME_FILLER.has(word))
  )

/** The share of the shorter name's words that are in the other: "Juniper" in "Juniper Foods" is 1. */
const nameScore = (a: string, b: string) => {
  const x = nameWords(a)
  const y = nameWords(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / Math.min(x.size, y.size)
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * Days from an order's date to when BLine entered a row for it, for the row to match it.
 * BLine enters an order once we email it, usually that day or the next. The order may be
 * booked in the app a little after the email, so a row can be a few days older than it.
 */
export const MATCH_WINDOW = { earliest: -3, latest: 14 } as const
// Twice the address score plus the name score: an address alone or a name alone is enough
// to suggest a match; both make it sure.
const MIN_SCORE = 1

/**
 * The order each row is matched to, in row order. A row an earlier import tied to an order
 * keeps it. The rest are matched to orders nobody has tied yet, best match first, each order
 * to one row at most.
 */
export const matchRows = (rows: FindeliversRow[], orders: FileOrder[]): RowMatch[] => {
  const matches: RowMatch[] = rows.map(() => ({ orderId: null, confidence: null, note: null }))
  const taken = new Set<number>()
  const open = new Set<number>()

  rows.forEach((row, i) => {
    const order = orders.find((o) => o.blineRef === row.ref)
    if (!order) {
      open.add(i)
      return
    }
    taken.add(order.id)
    matches[i] = order.voided
      ? { orderId: null, confidence: null, note: `This was order #${order.id}, which is void.` }
      : { orderId: order.id, confidence: 'linked', note: null }
  })

  const candidates = orders.filter((o) => !o.voided && o.blineRef === null && !taken.has(o.id))
  const pairs: {
    i: number
    order: FileOrder
    address: number
    name: number
    score: number
    gap: number
  }[] = []
  for (const i of open) {
    const row = rows[i]
    const where = parseAddress(row.address, row.postcode)
    for (const order of candidates) {
      const gap = row.createdOn ? daysBetween(order.orderDate, row.createdOn) : 0
      if (gap < MATCH_WINDOW.earliest || gap > MATCH_WINDOW.latest) continue
      const address = addressScore(where, parseAddress(order.address))
      const name = nameScore(row.recipient, order.customerName)
      const score = 2 * address + name
      if (score >= MIN_SCORE) pairs.push({ i, order, address, name, score, gap: Math.abs(gap) })
    }
  }

  pairs.sort((a, b) => b.score - a.score || a.gap - b.gap || a.order.id - b.order.id)
  const done = new Set<number>()
  for (const { i, order, address, name } of pairs) {
    if (done.has(i) || taken.has(order.id)) continue
    done.add(i)
    taken.add(order.id)
    const sure = address === 1 && name >= 0.5
    matches[i] = {
      orderId: order.id,
      confidence: sure ? 'sure' : 'check',
      note: sure
        ? null
        : address < 1
          ? `Check the address: the app has ${order.address ?? 'none'}.`
          : `Check the name: the app has ${order.customerName}.`,
    }
  }
  return matches
}

// ---------------------------------------------------------------------------------------
// Showing it

const STATUS_LABELS: Record<string, string> = {
  created: 'Unassigned',
  assigned: 'Assigned',
  pending_collection: 'Waiting for pickup',
  collected: 'Collected',
  in_transit: 'In transit',
  delivered: 'Delivered',
  failed_attempt: 'Failed attempt',
  failed: 'Failed',
  returned: 'Returned',
  returned_to_sender: 'Returned to sender',
  cancelled: 'Cancelled',
  cancelled_by_sender: 'Cancelled',
}

/** A findelivers status as findelivers' screens word it: created → Unassigned. */
export const blineStatusLabel = (status: string) => {
  const label = STATUS_LABELS[status]
  if (label) return label
  const words = status.replace(/_+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "Nov 20, 9:51 AM", in Portland. */
export const formatDeliveredAt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: DELIVERY_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

const sameMoment = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b))

/** The row says nothing the order doesn't already have. */
export const alreadyRecorded = (row: FindeliversRow, order: FileOrder) =>
  order.blineRef === row.ref &&
  (order.blineStatus === row.status ||
    (order.blineStatus === 'delivered' && row.status !== 'delivered')) &&
  (row.status !== 'delivered' ||
    row.deliveredAt === null ||
    sameMoment(order.deliveredAt, row.deliveredAt)) &&
  (row.status === 'delivered' ||
    order.blineStatus === 'delivered' ||
    order.blineProblem === row.problem)

/** Live BLine orders not delivered yet that no row in the file is matched to. */
export const notInFile = (orders: FileOrder[], matchedIds: Iterable<number>) => {
  const matched = new Set(matchedIds)
  return orders.filter((o) => !o.voided && o.deliveredAt === null && !matched.has(o.id))
}

/** What the app knows about a BLine order's delivery. */
export type Tracking = {
  deliveredAt: string | null
  blineRef: string | null
  blineStatus: string | null
  blineProblem: string | null
}

// findelivers statuses that mean the delivery isn't going to plan.
const TROUBLE = new Set([
  'failed_attempt',
  'failed',
  'returned',
  'returned_to_sender',
  'cancelled',
  'cancelled_by_sender',
])

const portlandDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    timeZone: DELIVERY_TIME_ZONE,
    month: 'short',
    day: 'numeric',
  })

/**
 * A BLine order's delivery in a few words, and whether someone should look at it:
 * "Delivered Nov 20, 9:51 AM (findelivers 261101.0007)", "Marked delivered Nov 20",
 * "findelivers 261101.0008: Failed attempt (Refused by recipient)", "Not in findelivers yet".
 */
export const trackingSummary = (tracking: Tracking): { text: string; warn: boolean } => {
  const { deliveredAt, blineRef, blineStatus, blineProblem } = tracking
  const seen =
    blineRef && blineStatus ? `findelivers ${blineRef}: ${blineStatusLabel(blineStatus)}` : null
  if (deliveredAt) {
    if (blineStatus === 'delivered') {
      return {
        text: `Delivered ${formatDeliveredAt(deliveredAt)} (findelivers ${blineRef})`,
        warn: false,
      }
    }
    // Marked by hand. findelivers may disagree.
    return {
      text: `Marked delivered ${portlandDay(deliveredAt)}${seen ? ` (${seen})` : ''}`,
      warn: Boolean(seen),
    }
  }
  if (!seen) return { text: 'Not in findelivers yet', warn: false }
  return {
    text: `${seen}${blineProblem ? ` (${blineProblem})` : ''}`,
    warn: TROUBLE.has(blineStatus ?? ''),
  }
}
