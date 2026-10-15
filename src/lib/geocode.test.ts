// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { geocodeAddress } from './geocode'

const POWELLS = '1005 W Burnside St, Portland, OR 97209'

// The Census reply for Powell's City of Books, 2026-10-15
const POWELLS_MATCH = {
  result: {
    input: {
      address: { address: POWELLS },
      benchmark: {
        isDefault: true,
        benchmarkDescription: 'Public Address Ranges - Current Benchmark',
        id: '4',
        benchmarkName: 'Public_AR_Current',
      },
    },
    addressMatches: [
      {
        tigerLine: { side: 'R', tigerLineId: '157499149' },
        coordinates: { x: -122.681258220226, y: 45.52302638429 },
        addressComponents: {
          zip: '97209',
          streetName: 'BURNSIDE',
          preType: '',
          city: 'PORTLAND',
          preDirection: 'W',
          suffixDirection: '',
          fromAddress: '1001',
          state: 'OR',
          suffixType: 'ST',
          toAddress: '1027',
          suffixQualifier: '',
          preQualifier: '',
        },
        matchedAddress: '1005 W BURNSIDE ST, PORTLAND, OR, 97209',
      },
    ],
  },
}

const NO_MATCH = { result: { input: { address: { address: POWELLS } }, addressMatches: [] } }

const replyWith = (status: number, body: object | string) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' },
      })
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('geocodeAddress', () => {
  it('returns the latitude and longitude of a match', async () => {
    vi.stubGlobal('fetch', replyWith(200, POWELLS_MATCH))

    await expect(geocodeAddress(POWELLS)).resolves.toEqual({
      latitude: 45.52302638429,
      longitude: -122.681258220226,
      matchedAddress: '1005 W BURNSIDE ST, PORTLAND, OR, 97209',
    })
  })

  it('asks the current Census benchmark for a one-line address', async () => {
    const fetch = replyWith(200, POWELLS_MATCH)
    vi.stubGlobal('fetch', fetch)

    await geocodeAddress('  1005 W Burnside St,\n  Portland, OR   97209 ')

    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      address: POWELLS,
      benchmark: 'Public_AR_Current',
      format: 'json',
    })
  })

  it('returns null when Census has no match', async () => {
    vi.stubGlobal('fetch', replyWith(200, NO_MATCH))

    await expect(geocodeAddress('1 Nowhere Lane, Portland, OR 97209')).resolves.toBeNull()
  })

  it('returns null for a blank address without calling Census', async () => {
    const fetch = replyWith(200, POWELLS_MATCH)
    vi.stubGlobal('fetch', fetch)

    await expect(geocodeAddress('   ')).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('takes the first match when an address is ambiguous', async () => {
    const [powells] = POWELLS_MATCH.result.addressMatches
    const elsewhere = {
      ...powells,
      coordinates: { x: -122.6, y: 45.6 },
      matchedAddress: 'ELSEWHERE',
    }
    vi.stubGlobal(
      'fetch',
      replyWith(200, { result: { ...POWELLS_MATCH.result, addressMatches: [powells, elsewhere] } })
    )

    await expect(geocodeAddress(POWELLS)).resolves.toMatchObject({ latitude: 45.52302638429 })
  })

  it.each([
    [
      'a server error page',
      500,
      '<html>Internal Server Error</html>',
      'Census geocoder error (500)',
    ],
    [
      'an error Census reports in JSON',
      400,
      { errors: ['Address cannot be empty'], status: '400' },
      'Census geocoder error (400): Address cannot be empty',
    ],
    ['a reply that is not JSON', 200, '<html>Maintenance</html>', 'Census geocoder error (200)'],
    ['JSON without a result', 200, { unexpected: true }, 'Census geocoder error (200)'],
    [
      'a match without coordinates',
      200,
      { result: { addressMatches: [{ matchedAddress: 'NO COORDINATES' }] } },
      'match without coordinates',
    ],
  ])('throws on %s', async (_, status, body, message) => {
    vi.stubGlobal('fetch', replyWith(status, body))

    await expect(geocodeAddress(POWELLS)).rejects.toThrow(message)
  })

  it('throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(geocodeAddress(POWELLS)).rejects.toThrow(
      'Census geocoder request failed: fetch failed'
    )
  })

  it('gives up once the timeout passes', async () => {
    // Hangs until the request is aborted, like a geocoder that never answers
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    )
    vi.stubGlobal('fetch', hang)

    const started = Date.now()
    await expect(geocodeAddress(POWELLS, { timeoutMs: 50 })).rejects.toThrow(
      'Census geocoder timed out after 50 ms'
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
