// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AIP_NOT_SET_UP, AIP_TIMEOUT_MS, fetchAipNumbers } from './aip'

// Made-up settings: no real Apps Script deployment or token.
const ENV = {
  APPS_SCRIPT_URL: 'https://script.example/macros/s/made-up-id/exec',
  APPS_SCRIPT_TOKEN: 'made-up-token-for-tests',
}
const DATA = JSON.stringify({ generated: '2026-10-18T12:00:00.000Z', revenue: { monthly: [] } })

const respond = (body: string, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status }))

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const loggedText = () => JSON.stringify(errors.mock.calls)

describe('fetchAipNumbers', () => {
  it('says it is not set up, without calling anything, until both settings exist', async () => {
    for (const env of [{}, { APPS_SCRIPT_URL: ENV.APPS_SCRIPT_URL }, { APPS_SCRIPT_TOKEN: ' ' }]) {
      const fetchImpl = respond(DATA)
      expect(await fetchAipNumbers(env, fetchImpl)).toEqual({ error: AIP_NOT_SET_UP, notSetUp: true })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('sends the token as the token parameter and returns the JSON as Apps Script sent it', async () => {
    const fetchImpl = respond(DATA)
    expect(await fetchAipNumbers({ ...ENV, APPS_SCRIPT_TOKEN: ` ${ENV.APPS_SCRIPT_TOKEN}\n` }, fetchImpl)).toEqual({
      json: DATA,
    })

    const [url, init] = fetchImpl.mock.calls[0]
    const sent = new URL(String(url))
    expect(sent.origin + sent.pathname).toBe(ENV.APPS_SCRIPT_URL)
    expect(sent.searchParams.get('token')).toBe(ENV.APPS_SCRIPT_TOKEN)
    expect(init).toMatchObject({ redirect: 'follow', cache: 'no-store' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('explains a token mismatch without repeating the token', async () => {
    const result = await fetchAipNumbers(ENV, respond(JSON.stringify({ error: 'Unauthorized' })))
    expect(result).toEqual({
      error:
        'The spreadsheet returned an error (APPS_SCRIPT_TOKEN does not match the DASHBOARD_TOKEN script property).',
    })
    expect(JSON.stringify(result) + loggedText()).not.toContain(ENV.APPS_SCRIPT_TOKEN)
  })

  it('passes on other Apps Script errors generically', async () => {
    expect(
      await fetchAipNumbers(ENV, respond(JSON.stringify({ error: 'Dashboard data unavailable' })))
    ).toEqual({ error: 'The spreadsheet returned an error.' })
  })

  it('turns away a response that is not a JSON object', async () => {
    for (const fetchImpl of [
      respond('<html>Sign in to continue</html>'),
      respond('[1, 2]'),
      respond(DATA, 500),
    ]) {
      expect(await fetchAipNumbers(ENV, fetchImpl)).toEqual({
        error: 'The spreadsheet sent an unexpected response. Try again.',
      })
    }
  })

  it('says so when the spreadsheet is too slow or unreachable, and logs no URL', async () => {
    const timeout = vi.fn<typeof fetch>(async () => {
      throw new DOMException(`Timed out after ${AIP_TIMEOUT_MS} ms`, 'TimeoutError')
    })
    expect(await fetchAipNumbers(ENV, timeout)).toEqual({
      error: 'The spreadsheet took too long to respond. Try again.',
    })

    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed for ${ENV.APPS_SCRIPT_URL}?token=${ENV.APPS_SCRIPT_TOKEN}`)
    })
    expect(await fetchAipNumbers(ENV, offline)).toEqual({ error: 'Could not reach the spreadsheet. Try again.' })
    expect(loggedText()).not.toContain(ENV.APPS_SCRIPT_TOKEN)
    expect(loggedText()).not.toContain('script.example')
  })

  it('reports a malformed URL setting', async () => {
    const fetchImpl = respond(DATA)
    expect(await fetchAipNumbers({ ...ENV, APPS_SCRIPT_URL: 'not a url' }, fetchImpl)).toEqual({
      error: 'The A.I.P Numbers settings on the server are wrong (APPS_SCRIPT_URL).',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
