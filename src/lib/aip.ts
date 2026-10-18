// A.I.P Numbers: the dashboard numbers Paul's Apps Script web app builds from the Sales
// sheet (its doGet in DashboardAPI.js). Server-only: it reads APPS_SCRIPT_URL and
// APPS_SCRIPT_TOKEN, and the token must never reach a browser. See docs/aip-numbers.md.

/** Apps Script reads the whole Sales sheet, which can take a while. */
export const AIP_TIMEOUT_MS = 60_000

export const AIP_NOT_SET_UP =
  "A.I.P Numbers isn't connected in this app yet (APPS_SCRIPT_URL and APPS_SCRIPT_TOKEN aren't set)."

/** The dashboard JSON exactly as Apps Script sent it, or what to tell the person instead. */
export type AipNumbers = { json: string } | { error: string; notSetUp?: true }

type Env = Record<string, string | undefined>

export const fetchAipNumbers = async (
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<AipNumbers> => {
  // Trimmed because values pasted into Vercel often pick up a trailing newline
  const scriptUrl = env.APPS_SCRIPT_URL?.trim()
  const scriptToken = env.APPS_SCRIPT_TOKEN?.trim()
  if (!scriptUrl || !scriptToken) return { error: AIP_NOT_SET_UP, notSetUp: true }

  let url: URL
  try {
    url = new URL(scriptUrl)
  } catch {
    console.error('A.I.P Numbers: APPS_SCRIPT_URL is not a URL')
    return { error: 'The A.I.P Numbers settings on the server are wrong (APPS_SCRIPT_URL).' }
  }
  url.searchParams.set('token', scriptToken)

  let upstream: Response
  try {
    upstream = await fetchImpl(url, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(AIP_TIMEOUT_MS),
    })
  } catch (err) {
    // Only the error's name: the URL, which carries the token, can show up in messages.
    const name = err instanceof Error ? err.name : 'Error'
    console.error('A.I.P Numbers: the Apps Script request failed:', name)
    return name === 'TimeoutError'
      ? { error: 'The spreadsheet took too long to respond. Try again.' }
      : { error: 'Could not reach the spreadsheet. Try again.' }
  }

  const text = await upstream.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // Not JSON (e.g. a Google sign-in or error page): handled below.
  }

  if (!upstream.ok || !data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('A.I.P Numbers: unexpected Apps Script response, HTTP', upstream.status)
    return { error: 'The spreadsheet sent an unexpected response. Try again.' }
  }
  const scriptError = (data as { error?: unknown }).error
  if (scriptError) {
    console.error('A.I.P Numbers: Apps Script said:', String(scriptError))
    const hint =
      scriptError === 'Unauthorized'
        ? ' (APPS_SCRIPT_TOKEN does not match the DASHBOARD_TOKEN script property)'
        : ''
    return { error: `The spreadsheet returned an error${hint}.` }
  }
  return { json: text }
}
