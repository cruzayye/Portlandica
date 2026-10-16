import type { Customer, Db } from '@/lib/db/types'
import type { CustomerOption } from '@/types/orders'
import { DbError, unwrap } from '@/lib/db/errors'
import { createCustomer, customerKey, formatAddress, listCustomers, updateCustomer } from '@/lib/db/customers'
import { parseAddress } from '@/lib/db/customerSeed'
import { writeLocationCoordinates, type SheetLocation } from '@/lib/google/sheets'
import { geocodeAddress } from '@/lib/geocode'

// The Current Locations Addresses tab stays the list of locations, because other tools
// and people add to it. The customers table follows it: names missing from the table
// are added, and rows already there are never changed. Server only.

const newCustomerFrom = (location: SheetLocation) => ({
  name: location.name.trim(),
  type: 'business' as const,
  business_type: location.businessType.trim() || null,
  ...parseAddress(location.address),
  latitude: location.latitude,
  longitude: location.longitude,
})

/**
 * Add every location the customers table doesn't have yet (first listing wins when a
 * name is on the tab twice). Returns all customers, active or not, and how many were
 * added.
 */
export const syncCustomers = async (db: Db, locations: SheetLocation[]) => {
  const existing = await listCustomers(db, { includeInactive: true })
  const known = new Set(existing.map((customer) => customer.name_key))
  const missing = new Map<string, ReturnType<typeof newCustomerFrom>>()
  for (const location of locations) {
    const key = customerKey(location.name)
    if (key && !known.has(key) && !missing.has(key)) missing.set(key, newCustomerFrom(location))
  }
  if (!missing.size) return { customers: existing, added: 0 }

  try {
    // Every row has every column, so the bulk insert can't mix up missing fields.
    const added = unwrap<Customer[]>(
      await db
        .from('customers')
        .insert([...missing.values()])
        .select()
    )
    return { customers: [...existing, ...added], added: added.length }
  } catch (err) {
    if (!(err instanceof DbError && err.code === 'duplicate')) throw err
    // Someone else added some of them meanwhile; add the rest one at a time.
    let added = 0
    for (const customer of missing.values()) {
      try {
        await createCustomer(db, customer)
        added += 1
      } catch (error) {
        if (!(error instanceof DbError && error.code === 'duplicate')) throw error
      }
    }
    return { customers: await listCustomers(db, { includeInactive: true }), added }
  }
}

/**
 * The businesses the order form offers: active business customers, with the address as
 * the locations tab writes it (or the one on file), sorted by name.
 */
export const customerOptions = (
  customers: Customer[],
  locations: SheetLocation[]
): CustomerOption[] => {
  const addresses = new Map<string, string>()
  for (const location of locations) {
    const key = customerKey(location.name)
    if (!addresses.has(key) && location.address) addresses.set(key, location.address)
  }
  return customers
    .filter((customer) => customer.active && customer.type === 'business')
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      business_type: customer.business_type,
      price_per_can: customer.price_per_can === null ? null : Number(customer.price_per_can),
      custom_cans: customer.custom_cans,
      email: customer.email,
      address: addresses.get(customer.name_key) ?? formatAddress(customer),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Types of business for the new-business picker: the tab's first, then any others on file. */
export const businessTypes = (customers: Customer[], locations: SheetLocation[]) => [
  ...new Set(
    [
      ...locations.map((location) => location.businessType),
      ...customers.map((customer) => customer.business_type ?? ''),
    ]
      .map((type) => type.trim())
      .filter(Boolean)
  ),
]

/**
 * Look up a new business's latitude and longitude and save them on the customer and in
 * columns C and D of its locations row. Runs after the order is saved, so a slow or
 * unavailable geocoder never holds up an order. No match or an error leaves them blank,
 * as before (the App Scripts run in the sheet can still fill them).
 */
export const geocodeNewCustomer = async (db: Db, customer: Customer) => {
  const address = formatAddress(customer)
  if (!address || customer.latitude !== null) return null
  let point: Awaited<ReturnType<typeof geocodeAddress>>
  try {
    point = await geocodeAddress(address)
  } catch (err) {
    console.error(`Geocoding ${customer.name} failed`, err)
    return null
  }
  if (!point) {
    console.info(`Geocoder found no match for ${customer.name} (${address})`)
    return null
  }
  // Each save stands on its own: one failing doesn't stop the other.
  const { latitude, longitude } = point
  await Promise.all([
    updateCustomer(db, customer.id, { latitude, longitude }).catch((err) =>
      console.error(`Saving coordinates on customer ${customer.id} failed`, err)
    ),
    writeLocationCoordinates(customer.name, latitude, longitude).catch((err) =>
      console.error(`Writing coordinates for ${customer.name} to the sheet failed`, err)
    ),
  ])
  return point
}
