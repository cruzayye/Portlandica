import { CANS_PER_CASE } from '@/globals/constants'

/** 60 cases to a pallet. */
export const CANS_PER_PALLET = 1440

/** Two decimals at most, and never "-0". */
const round2 = (value: number) => +value.toFixed(2) || 0

export const formatNumber = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 2 })

const counted = (value: number, unit: string) =>
  `${formatNumber(value)} ${unit}${value === 1 ? '' : 's'}`

export const formatCans = (count: number) => counted(count, 'can')

export const toCases = (count: number) => counted(round2(count / CANS_PER_CASE), 'case')

export const toPallets = (count: number) => counted(round2(count / CANS_PER_PALLET), 'pallet')

export const toCost = (cost: number | null) =>
  cost === null
    ? null
    : `$${Number(cost).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "+1,440" or "-24". */
export const formatChange = (delta: number) =>
  delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta)

export type CountUnit = 'cans' | 'cases'

/**
 * The cans in a quantity typed as cans or cases, or null unless it is a whole number of
 * cans, 0 or more. 2.5 cases is 60 cans; 2.1 cases isn't a whole number of cans.
 */
export const quantityToCans = (text: string, unit: CountUnit): number | null => {
  const typed = text.trim().replace(/,/g, '')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(typed)) return null
  const value = Number(typed) * (unit === 'cases' ? CANS_PER_CASE : 1)
  const cans = Math.round(value)
  return Math.abs(value - cans) < 1e-9 && Number.isSafeInteger(cans) ? cans : null
}

/** A count as a starting value for a quantity field: in cases when it fills whole cases. */
export const countAsQuantity = (count: number): { unit: CountUnit; text: string } =>
  count < 0
    ? { unit: 'cases', text: '' }
    : count % CANS_PER_CASE === 0
      ? { unit: 'cases', text: String(count / CANS_PER_CASE) }
      : { unit: 'cans', text: String(count) }

/** Dollars typed into a field: null when blank, NaN when it isn't an amount. */
export const parseDollars = (text: string): number | null => {
  const typed = text.trim().replace(/[$,]/g, '')
  if (typed === '') return null
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(typed)) return NaN
  return Number(typed)
}
