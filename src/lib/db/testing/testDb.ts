import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

// Test helpers: an in-process Postgres with a Supabase stand-in, an approximation of the
// live schema, and every migration in supabase/migrations applied in order.

const sqlDir = path.join(process.cwd(), 'src/lib/db/testing/sql')
const migrationsDir = path.join(process.cwd(), 'supabase/migrations')

export type TestAuth =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; sub: string; email: string }

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

export const createMigratedDb = async () => {
  const pg = new PGlite()
  await pg.exec(readSql(sqlDir, 'supabase-stub.sql'))
  await pg.exec(readSql(sqlDir, 'live-baseline.sql'))
  for (const file of migrationFiles()) {
    try {
      await pg.exec(readSql(migrationsDir, file))
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
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
