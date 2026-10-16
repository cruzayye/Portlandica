/**
 * The team-password settings. Both are server-only env vars (no NEXT_PUBLIC_ prefix), so
 * they are never sent to the browser. See SETUP.md.
 *
 * - TEAM_PASSWORD: the one password the team signs in with.
 * - SESSION_SECRET: signs the session cookie. Changing it signs every device out.
 *
 * If either is missing or too short, sign-in is switched off: nobody gets in.
 */

export const MIN_TEAM_PASSWORD_LENGTH = 12
export const MIN_SESSION_SECRET_LENGTH = 32

export type AuthConfig = { password: string; sessionSecret: string }

export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; problems: string[] }

type Env = Record<string, string | undefined>

const problemWith = (name: string, value: string, minLength: number) => {
  if (!value) return `${name} is not set`
  if (value.length < minLength) return `${name} is shorter than ${minLength} characters`
  return null
}

/** Checks the settings without logging. The proxy uses this on every request. */
export const checkAuthConfig = (env: Env): AuthConfigResult => {
  const password = env.TEAM_PASSWORD ?? ''
  const sessionSecret = env.SESSION_SECRET ?? ''
  const problems = [
    problemWith('TEAM_PASSWORD', password, MIN_TEAM_PASSWORD_LENGTH),
    problemWith('SESSION_SECRET', sessionSecret, MIN_SESSION_SECRET_LENGTH),
  ].filter((problem) => problem !== null)

  return problems.length
    ? { ok: false, problems }
    : { ok: true, config: { password, sessionSecret } }
}

/**
 * The settings from process.env. When they are unusable this logs which one is wrong (never
 * its value), so a deploy with a missing or short value is easy to spot in the server log.
 */
export const getAuthConfig = (): AuthConfigResult => {
  const result = checkAuthConfig(process.env)
  if (!result.ok) {
    console.error(
      `Team sign-in is switched off until the environment variables are fixed: ${result.problems.join('; ')}. See SETUP.md.`
    )
  }
  return result
}
