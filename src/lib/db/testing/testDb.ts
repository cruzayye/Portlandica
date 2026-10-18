import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Test helpers: an in-process Postgres with a Supabase stand-in, an approximation of the
// live schema, and every migration in supabase/migrations applied in order.
//
// The app signs in with the team password and reaches the database as the service role
// (SERVICE below), and in production the partner list is empty. The migrations run that
// way here too: database step 2 is applied with no partners. Afterwards PAUL and JOHNNY
// are added to the list, so the tests can still exercise the dormant partner path
// (signed-in Supabase Auth users that public.is_partner() accepts).

const sqlDir = path.join(process.cwd(), 'src/lib/db/testing/sql')
const migrationsDir = path.join(process.cwd(), 'supabase/migrations')

export type TestAuth =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; sub: string; email: string }

// Signed-in partners (the dormant path; see the top of this file).
export const PAUL = {
  role: 'authenticated',
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'paul@example.com',
} as const satisfies TestAuth
export const JOHNNY = {
  role: 'authenticated',
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'johnny@example.com',
} as const satisfies TestAuth
// Signed in, but not a partner.
export const STRANGER = {
  role: 'authenticated',
  sub: '00000000-0000-4000-8000-000000000003',
  email: 'stranger@example.com',
} as const satisfies TestAuth
export const ANON = { role: 'anon' } as const satisfies TestAuth
export const SERVICE = { role: 'service_role' } as const satisfies TestAuth

export const migrationFiles = () =>
  readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

const readSql = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8')

/** The made-up partner emails, added after the migrations unless `partners` is false. */
export const TEST_PARTNER_EMAILS = [PAUL.email, JOHNNY.email]

/** Stub, live baseline and the given migration files, in order. */
export const createDb = async (files: string[]) => {
  const pg = new PGlite()
  await pg.exec(readSql(sqlDir, 'supabase-stub.sql'))
  await pg.exec(readSql(sqlDir, 'live-baseline.sql'))
  for (const file of files) {
    try {
      await pg.exec(readSql(migrationsDir, file))
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return pg
}

export const createMigratedDb = async ({ partners = true }: { partners?: boolean } = {}) => {
  const pg = await createDb(migrationFiles())
  if (partners) {
    await pg.query('insert into private.partner_emails (email) select unnest($1::text[])', [
      TEST_PARTNER_EMAILS,
    ])
  }
  return pg
}

const claimsFor = (auth: TestAuth) =>
  auth.role === 'authenticated'
    ? { role: auth.role, sub: auth.sub, email: auth.email }
    : { role: auth.role }

/**
 * Run statements the way PostgREST does: in one transaction, as the request's role,
 * with its JWT claims set. Rolls back if any statement fails.
 */
export const asRole = <T>(
  pg: PGlite,
  auth: TestAuth,
  work: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>
) =>
  pg.transaction(async (tx) => {
    await tx.query(`set local role ${auth.role}`)
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claimsFor(auth)),
    ])
    return work(tx)
  })
