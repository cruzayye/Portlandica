const PORTLAND = 'America/Los_Angeles'

/** Today's date in Portland, YYYY-MM-DD. */
export const portlandToday = (now: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PORTLAND,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** "Oct 2, 2026" for a date column, without shifting it a day by time zone. */
export const formatDay = (isoDate: string | null) => {
  if (!isoDate) return null
  const date = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** "Oct 15, 2026": the day a timestamp falls on in Portland. */
export const formatPortlandDay = (timestamp: string | null) => {
  if (!timestamp) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleDateString('en-US', {
    timeZone: PORTLAND,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** "Oct 2, 2026, 3:14 PM" in Portland time, for a timestamp. */
export const formatMoment = (timestamp: string) => {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleString('en-US', {
    timeZone: PORTLAND,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
