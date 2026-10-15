// Errors from the database, sorted into the cases a caller can act on. The SQL functions
// tag their errors with a hint (see supabase/migrations/2026101700*); constraint and
// permission errors are recognised by their Postgres code.

export type DbErrorCode =
  | 'not_partner'
  | 'invalid_input'
  | 'duplicate'
  | 'not_found'
  | 'customer_not_found'
  | 'batch_not_found'
  | 'order_not_found'
  | 'batch_archived'
  | 'batch_has_history'
  | 'insufficient_stock'
  | 'product_batch_mismatch'
  | 'count_changed'
  | 'order_void'
  | 'step_already_done'
  | 'external_id_conflict'
  | 'unknown'

const HINT_CODES: DbErrorCode[] = [
  'not_partner',
  'invalid_input',
  'customer_not_found',
  'batch_not_found',
  'order_not_found',
  'batch_archived',
  'batch_has_history',
  'insufficient_stock',
  'product_batch_mismatch',
  'count_changed',
  'order_void',
  'step_already_done',
  'external_id_conflict',
]

const PG_CODES: Record<string, DbErrorCode> = {
  '42501': 'not_partner', // permission denied, or a row-level security check failed
  '23505': 'duplicate',
  '23514': 'invalid_input',
  '23502': 'invalid_input',
  '23503': 'invalid_input',
  '22P02': 'invalid_input',
  PGRST116: 'not_found',
}

export type PostgrestErrorLike = {
  message: string
  code?: string | null
  details?: string | null
  hint?: string | null
}

/** How short a batch is, from an insufficient_stock error. */
export type StockShortfall = { batchId: number; available: number; needed: number }

const codeFor = (error: PostgrestErrorLike): DbErrorCode => {
  const hint = error.hint as DbErrorCode | null | undefined
  if (hint && HINT_CODES.includes(hint)) return hint
  return PG_CODES[error.code ?? ''] ?? 'unknown'
}

const parseShortfall = (details: string | null): StockShortfall | null => {
  if (!details) return null
  try {
    const parsed = JSON.parse(details) as { batch_id: number; available: number; needed: number }
    return { batchId: parsed.batch_id, available: parsed.available, needed: parsed.needed }
  } catch {
    return null
  }
}

export class DbError extends Error {
  readonly code: DbErrorCode
  readonly pgCode: string | null
  readonly details: string | null
  /** For insufficient_stock: which batch and by how much. */
  readonly shortfall: StockShortfall | null

  constructor(error: PostgrestErrorLike) {
    super(error.message)
    this.name = 'DbError'
    this.code = codeFor(error)
    this.pgCode = error.code ?? null
    this.details = error.details ?? null
    this.shortfall = this.code === 'insufficient_stock' ? parseShortfall(this.details) : null
  }
}

/** Throw a DbError if a Supabase call failed; otherwise return its data. */
export const unwrap = <T>({
  data,
  error,
}: {
  data: unknown
  error: PostgrestErrorLike | null
}): T => {
  if (error) throw new DbError(error)
  return data as T
}
