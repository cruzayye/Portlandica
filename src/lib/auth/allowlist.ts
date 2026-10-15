/**
 * The partner allowlist. It comes from ALLOWED_EMAILS, a server-only env var
 * (no NEXT_PUBLIC_ prefix), so it is never sent to the browser.
 */

/** Lower-cased, de-duplicated emails from a comma-separated list. */
export const parseAllowlist = (raw: string | undefined): string[] => [
  ...new Set(
    (raw ?? '')
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  ),
]

/** Exact, case-insensitive match. An empty allowlist lets nobody in. */
export const isAllowedEmail = (email: string | null | undefined, allowlist: string[]) =>
  !!email && allowlist.includes(email.trim().toLowerCase())

export const getAllowlist = () => parseAllowlist(process.env.ALLOWED_EMAILS)
