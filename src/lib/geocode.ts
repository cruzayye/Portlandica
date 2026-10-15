/**
 * Turns a US street address into latitude/longitude with the US Census
 * Geocoder, which is free and needs no API key. Server-side only: the Census
 * API doesn't allow browser (CORS) requests. See docs/integrations.md.
 */

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
const DEFAULT_TIMEOUT_MS = 5000

export type GeocodeResult = {
  latitude: number
  longitude: number
  /** The address Census matched, e.g. '1005 W BURNSIDE ST, PORTLAND, OR, 97209' */
  matchedAddress: string
}

type CensusResponse = {
  result?: {
    addressMatches?: {
      matchedAddress?: string
      coordinates?: { x?: number; y?: number }
    }[]
  }
  errors?: string[]
}

/**
 * Returns null when Census has no match for the address. Throws when the
 * request fails or takes longer than timeoutMs, so callers can tell "no such
 * address" apart from "try again later".
 */
export const geocodeAddress = async (
  address: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<GeocodeResult | null> => {
  const oneLine = address.trim().replace(/\s+/g, ' ')
  if (!oneLine) return null

  const params = new URLSearchParams({
    address: oneLine,
    benchmark: 'Public_AR_Current',
    format: 'json',
  })

  let res: Response
  try {
    res = await fetch(`${CENSUS_URL}?${params}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError'
    throw new Error(
      timedOut
        ? `Census geocoder timed out after ${timeoutMs} ms`
        : `Census geocoder request failed: ${(err as Error).message}`,
      { cause: err }
    )
  }

  const data = (await res.json().catch(() => null)) as CensusResponse | null
  const matches = data?.result?.addressMatches
  if (!res.ok || !Array.isArray(matches)) {
    const reason = data?.errors?.join('; ') || res.statusText || 'unexpected response'
    throw new Error(`Census geocoder error (${res.status}): ${reason}`)
  }
  if (!matches.length) return null

  // An ambiguous address can match more than once; take the first
  const [{ coordinates, matchedAddress }] = matches
  if (typeof coordinates?.x !== 'number' || typeof coordinates?.y !== 'number') {
    throw new Error('Census geocoder returned a match without coordinates')
  }
  // Census gives x = longitude, y = latitude
  return {
    latitude: coordinates.y,
    longitude: coordinates.x,
    matchedAddress: matchedAddress ?? oneLine,
  }
}
