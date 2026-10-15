import { customerKey } from './customers'
import { DbError, unwrap } from './errors'
import type { Batch, Customer, Db, NewCustomer } from './types'

// Builds the first customers from the Sales sheet and links custom batches to them.
// buildSeedPlan is pure, so the plan can be written out as CSV and reviewed before
// applySeedPlan writes anything. Run it with scripts/seed-customers.ts.

/**
 * Agreed prices per can as the order form hard-coded them before the customers table.
 * The seed copies them onto the customers; the app reads customers.price_per_can.
 */
export const CUSTOMER_PRICING: Record<string, number> = {
  'Hollywood Theatre': 1.66,
  'The Clyde Hotel Portland by Kasa': 1.75,
  'Tacos Fita': 1.75,
  'Que Dice': 2.0,
  'Hotel Vintage': 2.0,
  'Woodlark Hotel Portland': 2.0,
}

/** Payment terms that differ from the 30-day default. Sysco Net 65 confirmed 2026-10-12. */
export const CUSTOMER_PAYMENT_TERMS: Record<string, number> = {
  Sysco: 65,
}

export type SeedSources = {
  /** 'Current Locations Addresses' tab, header row first. */
  locations: string[][]
  /** 'Parent Companies' tab, header row first. */
  parentCompanies: string[][]
  /** Agreed price per can by customer name (CUSTOMER_PRICING). */
  pricing: Record<string, number>
  /** Payment terms in days by customer name. */
  paymentTerms: Record<string, number>
  batches: Pick<Batch, 'id' | 'name' | 'isCustom' | 'customer_id'>[]
  /** Customers already in the database; they are left as they are. */
  existing: Pick<Customer, 'id' | 'name' | 'name_key'>[]
}

export type CustomerPlanRow = {
  action: 'insert' | 'exists'
  customer: NewCustomer
  /** Where the row's data came from. */
  sources: string[]
  /** Things a person should check before applying. */
  issues: string[]
}

export type BatchPlanRow = {
  batch_id: number
  batch_name: string
  action: 'link' | 'already_linked' | 'unmatched'
  customer_name: string | null
  /** Set when the batch name isn't exactly the customer's name, e.g. a trailing space. */
  rename_to: string | null
  /** Possible customers for an unmatched batch. */
  suggestions: string[]
}

export type SeedPlan = {
  customers: CustomerPlanRow[]
  batches: BatchPlanRow[]
  /** Sheet entries that didn't turn into anything, for the record. */
  notes: string[]
}

export type ParsedAddress = {
  street_address: string | null
  city: string | null
  state: string | null
  zip: string | null
}

const ZIP = /^\d{5}(?:-\d{4})?$/
const ENDS_WITH_ZIP = /^(.*\S)\s+(\d{5}(?:-\d{4})?)$/
const ENDS_WITH_WORD = /^(.*\S)\s+(\S+)$/
const TWO_LETTERS = /^[A-Za-z]{2}$/
const COUNTRY = /[\s,]+(?:United States(?: of America)?|USA|US)$/i

// Customers are in the Northwest. Limiting states to these keeps street suffixes such as
// "Ct" from being read as Connecticut.
const STATES: Record<string, string> = {
  or: 'OR',
  oregon: 'OR',
  wa: 'WA',
  washington: 'WA',
  id: 'ID',
  idaho: 'ID',
  ca: 'CA',
  california: 'CA',
}
const stateCode = (value: string) => STATES[value.trim().toLowerCase()] ?? null

// Cities that show up without a comma (or even a space) in front of them, e.g.
// "1307 NE 102nd Ave Portland, OR" or "2850 SW Cedar Hills BlvdBeaverton, OR".
const KNOWN_CITIES = [
  'Lake Oswego',
  'West Linn',
  'Oregon City',
  'Happy Valley',
  'Portland',
  'Beaverton',
  'Tigard',
  'Milwaukie',
  'Hillsboro',
  'Gresham',
  'Troutdale',
  'Tualatin',
  'Wilsonville',
  'Clackamas',
  'Corvallis',
  'Salem',
  'Eugene',
  'Vancouver',
  'Camas',
  'Kalama',
]

const splitKnownCity = (street: string) => {
  const city = KNOWN_CITIES.find(
    (name) => street.length > name.length && street.toLowerCase().endsWith(name.toLowerCase())
  )
  return city ? { street: street.slice(0, -city.length).trim(), city } : null
}

/**
 * Split a one-line address from the sheet ("2310 NE Broadway, Portland, OR 97232") into
 * parts. Copes with the sheet's variations: stray spaces before commas, state and zip in
 * separate parts or spelled out ("Oregon 97210"), a trailing "United States", a missing
 * zip, and a city with no comma in front of it. Anything it can't place stays in the
 * street so nothing is lost.
 */
export const parseAddress = (raw: string | null | undefined): ParsedAddress => {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim().replace(COUNTRY, '')
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  let state: string | null = null
  let zip: string | null = null

  if (parts.length && ZIP.test(parts[parts.length - 1])) zip = parts.pop() ?? null
  if (parts.length) {
    let last = parts[parts.length - 1]
    const withZip = zip ? null : last.match(ENDS_WITH_ZIP)
    if (withZip) {
      last = withZip[1]
      zip = withZip[2]
    }
    const lastWord = last.match(ENDS_WITH_WORD)
    // A state on its own ("MO 63116", ", OR,") can be any; one glued to the street must
    // be a Northwest state or a spelled-out name.
    const standalone = stateCode(last) ?? (TWO_LETTERS.test(last) ? last.toUpperCase() : null)
    if (standalone && parts.length > 1) {
      state = standalone
      parts.pop()
    } else if (lastWord && stateCode(lastWord[2])) {
      state = stateCode(lastWord[2])
      parts[parts.length - 1] = lastWord[1]
    } else {
      parts[parts.length - 1] = last
    }
  }

  let city: string | null = null
  if (parts.length > 1) {
    city = parts.pop() ?? null
  } else if (parts.length === 1) {
    const split = splitKnownCity(parts[0])
    if (split) {
      parts[0] = split.street
      city = split.city
    }
  }

  return { street_address: parts.length ? parts.join(', ') : null, city, state, zip }
}

const parseCoordinate = (value: string | undefined, limit: number) => {
  const number = Number((value ?? '').trim())
  return value && value.trim() !== '' && Number.isFinite(number) && Math.abs(number) <= limit
    ? number
    : null
}

/** Column index by header name; throws if the tab's layout changed. */
const columnsOf = (rows: string[][], tab: string, headers: string[]) => {
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase())
  return headers.map((name) => {
    const index = header.indexOf(name.toLowerCase())
    if (index === -1) throw new Error(`The ${tab} tab has no "${name}" column`)
    return index
  })
}

const NO_PRICE = 'Has a custom batch but no agreed price; it will default to $1.50'

// Sheet tabs disagree on apostrophes ("Reed’s" vs "Reed's"); match them either way.
const looseKey = (name: string) => customerKey(name).replace(/[‘’`]/g, "'")

const byKey = (record: Record<string, number>) =>
  new Map(Object.entries(record).map(([name, value]) => [customerKey(name), { name, value }]))

export const buildSeedPlan = (sources: SeedSources): SeedPlan => {
  const notes: string[] = []
  const planned = new Map<string, CustomerPlanRow>()
  const existingKeys = new Set(sources.existing.map((customer) => customer.name_key))

  const [parentCol, childCol] = columnsOf(sources.parentCompanies, 'Parent Companies', [
    'Parent Company',
    'Individual Company',
  ])
  const parents = new Map<string, { parent: string; child: string }>()
  for (const row of sources.parentCompanies.slice(1)) {
    const parent = (row[parentCol] ?? '').trim()
    const child = (row[childCol] ?? '').trim()
    if (parent && child) parents.set(looseKey(child), { parent, child })
  }

  const add = (name: string, source: string, customer: NewCustomer, issues: string[] = []) => {
    const key = customerKey(name)
    const row: CustomerPlanRow = {
      action: existingKeys.has(key) ? 'exists' : 'insert',
      customer,
      sources: [source],
      issues: existingKeys.has(key)
        ? ['Already in the database; left unchanged', ...issues]
        : issues,
    }
    planned.set(key, row)
    return row
  }

  const [nameCol, addressCol, latCol, lngCol, typeCol] = columnsOf(
    sources.locations,
    'Current Locations Addresses',
    ['Name', 'Address', 'Latitude', 'Longitude', 'Type of Business']
  )
  for (const row of sources.locations.slice(1)) {
    const name = (row[nameCol] ?? '').trim()
    if (!name) continue
    const rawAddress = (row[addressCol] ?? '').replace(/\s+/g, ' ').trim()
    const earlier = planned.get(customerKey(name))
    if (earlier) {
      earlier.issues.push(`Listed twice; second address kept in notes: ${rawAddress || '(none)'}`)
      earlier.customer.notes = [earlier.customer.notes, `Also at: ${rawAddress}`]
        .filter(Boolean)
        .join('\n')
      continue
    }

    const address = parseAddress(rawAddress)
    const issues: string[] = []
    if (!rawAddress) issues.push('No address')
    else if (!address.city || !address.state || !address.zip)
      issues.push(`Address only partly understood: "${rawAddress}"`)

    let latitude = parseCoordinate(row[latCol], 90)
    let longitude = parseCoordinate(row[lngCol], 180)
    if (latitude === null || longitude === null) {
      if (rawAddress) issues.push('No coordinates')
      latitude = null
      longitude = null
    }

    add(
      name,
      'locations',
      {
        name,
        type: 'business',
        business_type: (row[typeCol] ?? '').trim() || null,
        parent_company: parents.get(looseKey(name))?.parent ?? null,
        ...address,
        latitude,
        longitude,
      },
      issues
    )
  }

  for (const { name, value } of byKey(sources.pricing).values()) {
    const row =
      planned.get(customerKey(name)) ??
      add(name, 'pricing', { name, type: 'business' }, ['Not in the locations tab'])
    row.customer.price_per_can = value
    row.customer.custom_cans = true
    if (!row.sources.includes('pricing')) row.sources.push('pricing')
  }

  for (const { name, value } of byKey(sources.paymentTerms).values()) {
    const row =
      planned.get(customerKey(name)) ??
      add(name, 'terms', { name, type: 'business' }, ['Not in the locations tab'])
    row.customer.payment_terms_days = value
    if (!row.sources.includes('terms')) row.sources.push('terms')
  }

  const plannedLoose = new Set([...planned.keys()].map(looseKey))
  for (const { parent, child } of parents.values()) {
    if (!plannedLoose.has(looseKey(child)))
      notes.push(`Parent Companies lists "${child}" (${parent}), which isn't in the locations tab`)
  }

  const existingById = new Map(sources.existing.map((customer) => [customer.id, customer]))
  const batches: BatchPlanRow[] = sources.batches
    .filter((batch) => batch.isCustom)
    .map((batch) => {
      const base = { batch_id: batch.id, batch_name: batch.name, rename_to: null, suggestions: [] }
      if (batch.customer_id != null) {
        return {
          ...base,
          action: 'already_linked' as const,
          customer_name: existingById.get(batch.customer_id)?.name ?? `#${batch.customer_id}`,
        }
      }
      const key = customerKey(batch.name)
      const match = planned.get(key)
      if (!match) {
        const suggestions = [...planned.values()]
          .map((row) => row.customer.name)
          .filter((name) => {
            const candidate = customerKey(name)
            return candidate.includes(key) || key.includes(candidate)
          })
          .slice(0, 5)
        return { ...base, action: 'unmatched' as const, customer_name: null, suggestions }
      }
      match.customer.custom_cans = true
      if (!match.sources.includes('batch')) match.sources.push('batch')
      if (match.customer.price_per_can == null && !match.issues.includes(NO_PRICE))
        match.issues.push(NO_PRICE)
      return {
        ...base,
        action: 'link' as const,
        customer_name: match.customer.name,
        rename_to: batch.name === match.customer.name ? null : match.customer.name,
      }
    })

  return { customers: [...planned.values()], batches, notes }
}

const CUSTOMER_COLUMNS = [
  'name',
  'type',
  'business_type',
  'parent_company',
  'price_per_can',
  'custom_cans',
  'payment_terms_days',
  'street_address',
  'city',
  'state',
  'zip',
  'latitude',
  'longitude',
  'notes',
] as const

const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? '' : String(value)
  // Keep spreadsheet apps from treating a cell as a formula.
  if (/^[=+@\t\r]/.test(text)) text = `'${text}`
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const toCsv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'

export const customersCsv = (plan: SeedPlan) =>
  toCsv(
    ['action', ...CUSTOMER_COLUMNS, 'sources', 'issues'],
    plan.customers.map((row) => [
      row.action,
      ...CUSTOMER_COLUMNS.map((column) => row.customer[column]),
      row.sources.join('; '),
      row.issues.join('; '),
    ])
  )

export const batchesCsv = (plan: SeedPlan) =>
  toCsv(
    ['batch_id', 'batch_name', 'action', 'customer_name', 'rename_to', 'suggestions'],
    plan.batches.map((row) => [
      row.batch_id,
      row.batch_name,
      row.action,
      row.customer_name,
      row.rename_to,
      row.suggestions.join('; '),
    ])
  )

export type SeedResult = { inserted: number; linked: number; renamed: number }

/**
 * Write a reviewed plan: insert the new customers in one statement (all or nothing), then
 * link each matched custom batch, renaming it to the customer's exact name where needed.
 * A batch someone linked in the meantime is left alone. Safe to re-run with a fresh plan.
 */
export const applySeedPlan = async (db: Db, plan: SeedPlan): Promise<SeedResult> => {
  // Every row gets every column so a bulk insert can't mix up missing fields.
  const toInsert = plan.customers
    .filter((row) => row.action === 'insert')
    .map(({ customer }) => ({
      ...Object.fromEntries(CUSTOMER_COLUMNS.map((column) => [column, customer[column] ?? null])),
      type: customer.type ?? 'business',
      custom_cans: customer.custom_cans ?? false,
    }))
  const inserted = toInsert.length
    ? unwrap<Pick<Customer, 'id'>[]>(await db.from('customers').insert(toInsert).select('id'))
        .length
    : 0

  const links = plan.batches.filter((row) => row.action === 'link')
  if (!links.length) return { inserted, linked: 0, renamed: 0 }

  const customers = unwrap<Pick<Customer, 'id' | 'name_key'>[]>(
    await db.from('customers').select('id, name_key')
  )
  const idByKey = new Map(customers.map((customer) => [customer.name_key, customer.id]))

  let linked = 0
  let renamed = 0
  for (const link of links) {
    const customerId = idByKey.get(customerKey(link.customer_name ?? ''))
    if (customerId === undefined) {
      throw new DbError({
        message: `No customer named ${link.customer_name}`,
        hint: 'customer_not_found',
      })
    }
    const patch = link.rename_to
      ? { customer_id: customerId, name: link.rename_to }
      : { customer_id: customerId }
    const updated = unwrap<{ id: number }[]>(
      await db
        .from('inventory')
        .update(patch)
        .eq('id', link.batch_id)
        .is('customer_id', null)
        .select('id')
    )
    if (updated.length) {
      linked += 1
      if (link.rename_to) renamed += 1
    }
  }
  return { inserted, linked, renamed }
}
