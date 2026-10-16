import type { PGlite } from '@electric-sql/pglite'
import type { Db } from '../types'
import { asRole, type TestAuth } from './testDb'

// A small stand-in for the PostgREST client, backed by PGlite. It supports only the
// query-builder calls the db modules use, runs each call as the given role with RLS and
// grants in force, and returns rows as JSON the way PostgREST does. Anything it doesn't
// support throws, so a module can't quietly depend on behaviour these tests don't cover.

type PostgrestErrorLike = {
  message: string
  code: string
  details: string | null
  hint: string | null
}
type Response = { data: unknown; error: PostgrestErrorLike | null }

type Filter =
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'ilike'; column: string; value: unknown }
  | { op: 'is'; column: string; value: null | boolean }
  | { op: 'in'; column: string; value: unknown[] }

type Action = 'select' | 'insert' | 'update' | 'delete'

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

const toError = (err: unknown): PostgrestErrorLike => {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string }
  return {
    message: e.message ?? String(err),
    code: e.code ?? 'XX000',
    details: e.detail ?? null,
    hint: e.hint ?? null,
  }
}

const columnList = (columns: string) => {
  if (/[()!:]/.test(columns)) throw new Error(`fakeSupabase: unsupported select "${columns}"`)
  return columns.trim() === '*'
    ? '*'
    : columns
        .split(',')
        .map((column) => quote(column.trim()))
        .join(', ')
}

const queryBuilder = (pg: PGlite, auth: TestAuth, table: string) => {
  let action: Action = 'select'
  let columns = '*'
  let returning = false
  let payload: Record<string, unknown>[] = []
  let cardinality: 'many' | 'single' | 'maybeSingle' = 'many'
  let limitTo: number | null = null
  const filters: Filter[] = []
  const orders: { column: string; ascending: boolean }[] = []

  const build = () => {
    const params: unknown[] = []
    const param = (value: unknown) => {
      params.push(value)
      return `$${params.length}`
    }
    const where = filters.map((filter) => {
      const column = quote(filter.column)
      switch (filter.op) {
        case 'eq':
          return `${column} = ${param(filter.value)}`
        case 'neq':
          return `${column} <> ${param(filter.value)}`
        case 'gt':
          return `${column} > ${param(filter.value)}`
        case 'gte':
          return `${column} >= ${param(filter.value)}`
        case 'lt':
          return `${column} < ${param(filter.value)}`
        case 'lte':
          return `${column} <= ${param(filter.value)}`
        case 'ilike':
          return `${column} ilike ${param(filter.value)}`
        case 'in':
          return `${column} = any(${param(filter.value)})`
        case 'is':
          return `${column} is ${filter.value === null ? 'null' : filter.value ? 'true' : 'false'}`
      }
    })
    const whereSql = where.length ? ` where ${where.join(' and ')}` : ''
    const target = `public.${quote(table)}`
    const returningSql = returning ? ` returning to_jsonb(t) as row` : ''

    if (action === 'select') {
      const orderSql = orders.length
        ? ` order by ${orders.map((o) => `${quote(o.column)} ${o.ascending ? 'asc' : 'desc'}`).join(', ')}`
        : ''
      const limitSql = limitTo === null ? '' : ` limit ${limitTo}`
      return {
        sql: `select to_jsonb(t) as row from (select ${columnList(columns)} from ${target}${whereSql}${orderSql}${limitSql}) t`,
        params,
      }
    }
    if (action === 'insert') {
      const keys = [...new Set(payload.flatMap((row) => Object.keys(row)))]
      const values = payload
        .map(
          (row) => `(${keys.map((key) => (key in row ? param(row[key]) : 'default')).join(', ')})`
        )
        .join(', ')
      return {
        sql: `insert into ${target} as t (${keys.map(quote).join(', ')}) values ${values}${returningSql}`,
        params,
      }
    }
    if (action === 'update') {
      const sets = Object.entries(payload[0]).map(
        ([key, value]) => `${quote(key)} = ${param(value)}`
      )
      return {
        sql: `update ${target} as t set ${sets.join(', ')}${whereSql}${returningSql}`,
        params,
      }
    }
    return { sql: `delete from ${target} as t${whereSql}${returningSql}`, params }
  }

  const execute = async (): Promise<Response> => {
    try {
      const { sql, params } = build()
      const rows = await asRole(
        pg,
        auth,
        async (tx) => (await tx.query<{ row: unknown }>(sql, params)).rows
      )
      const data = rows.map((r) => r.row)
      if (action !== 'select' && !returning) return { data: null, error: null }
      if (cardinality === 'many') return { data, error: null }
      if (data.length > 1 || (cardinality === 'single' && data.length === 0)) {
        return {
          data: null,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
            details: `The result contains ${data.length} rows`,
            hint: null,
          },
        }
      }
      return { data: data[0] ?? null, error: null }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  const builder = {
    select: (cols = '*') => {
      columns = cols
      if (action !== 'select') returning = true
      return builder
    },
    insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
      action = 'insert'
      payload = Array.isArray(rows) ? rows : [rows]
      return builder
    },
    update: (patch: Record<string, unknown>) => {
      action = 'update'
      payload = [patch]
      return builder
    },
    delete: () => {
      action = 'delete'
      return builder
    },
    eq: (column: string, value: unknown) => (filters.push({ op: 'eq', column, value }), builder),
    neq: (column: string, value: unknown) => (filters.push({ op: 'neq', column, value }), builder),
    gt: (column: string, value: unknown) => (filters.push({ op: 'gt', column, value }), builder),
    gte: (column: string, value: unknown) => (filters.push({ op: 'gte', column, value }), builder),
    lt: (column: string, value: unknown) => (filters.push({ op: 'lt', column, value }), builder),
    lte: (column: string, value: unknown) => (filters.push({ op: 'lte', column, value }), builder),
    ilike: (column: string, value: string) => (
      filters.push({ op: 'ilike', column, value }),
      builder
    ),
    in: (column: string, value: unknown[]) => (filters.push({ op: 'in', column, value }), builder),
    is: (column: string, value: null | boolean) => (
      filters.push({ op: 'is', column, value }),
      builder
    ),
    order: (column: string, options: { ascending?: boolean } = {}) => {
      orders.push({ column, ascending: options.ascending ?? true })
      return builder
    },
    limit: (count: number) => {
      limitTo = count
      return builder
    },
    single: () => {
      cardinality = 'single'
      return builder
    },
    maybeSingle: () => {
      cardinality = 'maybeSingle'
      return builder
    },
    then: <T1 = Response, T2 = never>(
      onfulfilled?: ((value: Response) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
    ) => execute().then(onfulfilled, onrejected),
  }
  return builder
}

const rpc = (pg: PGlite, auth: TestAuth, fn: string, args: Record<string, unknown> = {}) => {
  const execute = async (): Promise<Response> => {
    try {
      const meta = await pg.query<{ retset: boolean; composite: boolean }>(
        `select p.proretset as retset, t.typtype = 'c' as composite
         from pg_proc p join pg_type t on t.oid = p.prorettype
         where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
        [fn]
      )
      if (meta.rows.length !== 1) throw new Error(`fakeSupabase: no single public function ${fn}`)
      const { retset, composite } = meta.rows[0]
      const params: unknown[] = []
      const named = Object.entries(args)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
          params.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value)
          return `${quote(name)} => $${params.length}`
        })
      const call = `public.${quote(fn)}(${named.join(', ')})`
      const sql = composite
        ? `select to_jsonb(r) as value from ${call} r`
        : `select ${call} as value`
      const rows = await asRole(
        pg,
        auth,
        async (tx) => (await tx.query<{ value: unknown }>(sql, params)).rows
      )
      const values = rows.map((r) => r.value)
      return { data: retset ? values : (values[0] ?? null), error: null }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }
  return {
    then: <T1 = Response, T2 = never>(
      onfulfilled?: ((value: Response) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
    ) => execute().then(onfulfilled, onrejected),
  }
}

/** A Db that talks to PGlite as the given user. */
export const fakeSupabase = (pg: PGlite, auth: TestAuth): Db =>
  ({
    from: (table: string) => queryBuilder(pg, auth, table),
    rpc: (fn: string, args?: Record<string, unknown>) => rpc(pg, auth, fn, args),
  }) as unknown as Db
