import { PRODUCTS } from './stock'
import type { CountChange, NewBatchInput } from './types'
import { formatNumber } from './units'

// Checks shared by the Inventory tab's forms and its server actions. The actions can be
// called directly, so they run these again on whatever arrives; nothing here may throw.

/** The most cans one fill or count can hold. Anything bigger is almost certainly a typo. */
export const MAX_CANS = 100_000

export const MAX_NOTE_LENGTH = 500

const MAX_TEXT_LENGTH = 100

const MAX_COST = 1_000_000

const isText = (value: unknown): value is string => typeof value === 'string'

const isFilled = (value: unknown) => isText(value) && value.trim() !== ''

const isTooLong = (value: unknown, max: number) => isText(value) && value.trim().length > max

const isOptionalText = (value: unknown, max: number) =>
  value === null || value === undefined || (isText(value) && !isTooLong(value, max))

export const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

/** A real calendar date written YYYY-MM-DD. */
export const isIsoDate = (value: unknown): value is string => {
  if (!isText(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

const tooBig = `That's more than ${formatNumber(MAX_CANS)} cans. Check the number.`

/** Why a new batch can't be recorded, or null if it can. */
export const fillProblem = (input: NewBatchInput): string | null => {
  if (typeof input !== 'object' || input === null) return 'Fill in the batch details.'
  if (input.kind !== 'house' && input.kind !== 'custom') {
    return 'Choose house stock or custom cans.'
  }
  if (!PRODUCTS.includes(input.product)) return 'Choose still, sparkling or dog water.'
  if (input.kind === 'custom' && !isId(input.customerId)) {
    return 'Pick the customer these cans were filled for.'
  }
  if (input.kind === 'house' && !isFilled(input.name)) return 'Name the batch.'
  if (!isOptionalText(input.name, MAX_TEXT_LENGTH)) {
    return `Keep the name under ${MAX_TEXT_LENGTH} characters.`
  }
  if (!Number.isSafeInteger(input.cans) || input.cans <= 0) {
    return 'Enter how many cases were filled.'
  }
  if (input.cans > MAX_CANS) return tooBig
  if (!isFilled(input.source) || isTooLong(input.source, MAX_TEXT_LENGTH)) {
    return 'Pick the water source.'
  }
  if (!isIsoDate(input.fillDate)) return 'Enter the fill date.'
  if (
    input.totalCost !== null &&
    !(
      typeof input.totalCost === 'number' &&
      Number.isFinite(input.totalCost) &&
      input.totalCost >= 0 &&
      input.totalCost <= MAX_COST
    )
  ) {
    return 'Enter the total cost in dollars, or leave it blank.'
  }
  if (!isOptionalText(input.invoiceNumber, MAX_TEXT_LENGTH)) {
    return `Keep the invoice number under ${MAX_TEXT_LENGTH} characters.`
  }
  return optionalNoteProblem(input.note)
}

/** Why a note can't be saved (too long, or not text), or null. Blank is fine. */
export const optionalNoteProblem = (note: unknown): string | null =>
  isOptionalText(note, MAX_NOTE_LENGTH)
    ? null
    : `Keep the note under ${MAX_NOTE_LENGTH} characters.`

const requiredNoteProblem = (note: unknown, missing: string): string | null =>
  isFilled(note) ? optionalNoteProblem(note) : missing

/** Why a count change can't be saved, or null if it can. */
export const countChangeProblem = (change: CountChange): string | null => {
  if (typeof change !== 'object' || change === null || !isId(change.batchId)) {
    return 'Pick a batch.'
  }
  if (!Number.isSafeInteger(change.newCount) || change.newCount < 0) {
    return 'Enter the number of cans you counted (0 or more).'
  }
  if (change.newCount > MAX_CANS) return tooBig
  if (!Number.isSafeInteger(change.expectedCount)) return 'Reload the batch and try again.'
  return requiredNoteProblem(change.note, 'Say why the count is changing.')
}

/**
 * Why a batch can't be archived with this note, or null. Archiving writes off whatever
 * is left, so a batch that isn't at 0 needs a reason.
 */
export const archiveProblem = (count: number, note: unknown): string | null =>
  count === 0
    ? optionalNoteProblem(note)
    : requiredNoteProblem(note, 'Say why this batch is being archived.')
