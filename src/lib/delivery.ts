// Dates for orders and deliveries. Deliveries run on Portland time, not the server's
// (Vercel runs in UTC) or the browser's. Pure functions, safe on the server and in the
// browser.

export const DELIVERY_TIME_ZONE = 'America/Los_Angeles'
const DELIVERY_DAYS = [3, 6] // Wednesday, Saturday
const DELIVERY_HOUR = 9

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const pacificDateParts = (now: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DELIVERY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { year: part('year'), month: part('month'), day: part('day') }
}

const pad = (n: number) => String(n).padStart(2, '0')

// 9:00 AM Pacific on the given calendar date, whether that falls in PST or PDT.
const atDeliveryHour = (date: Date) => {
  const assumingPst = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    DELIVERY_HOUR + 8
  )
  const pacificHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: DELIVERY_TIME_ZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(assumingPst)
  )
  return new Date(assumingPst - (pacificHour - DELIVERY_HOUR) * 60 * 60 * 1000)
}

/** Today's date in Portland as YYYY-MM-DD. */
export const pacificDate = (now: Date) => {
  const { year, month, day } = pacificDateParts(now)
  return `${year}-${pad(month)}-${pad(day)}`
}

/** True for a real calendar date written YYYY-MM-DD. */
export const isIsoDate = (value: string | null | undefined): value is string => {
  const match = ISO_DATE.exec(value ?? '')
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

/**
 * First Wednesday or Saturday at least two days after today's date in
 * Portland, due at 9:00 AM Pacific.
 */
export const nextDeliveryDate = (now: Date): Date => {
  const { year, month, day } = pacificDateParts(now)
  // A UTC-midnight date used only as a calendar, so the server's zone can't shift the day.
  const date = new Date(Date.UTC(year, month - 1, day + 2))
  while (!DELIVERY_DAYS.includes(date.getUTCDay())) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return atDeliveryHour(date)
}

/** The order form's default delivery date (YYYY-MM-DD): the next delivery day. */
export const defaultDeliveryDate = (now: Date) => pacificDate(nextDeliveryDate(now))

/** 9:00 AM Pacific on a YYYY-MM-DD date: when a delivery on that day is due. */
export const deliveryDue = (isoDate: string) => {
  if (!isIsoDate(isoDate)) throw new Error(`Not a date: ${isoDate}`)
  const [year, month, day] = isoDate.split('-').map(Number)
  return atDeliveryHour(new Date(Date.UTC(year, month - 1, day)))
}

export const formatDeliveryDate = (date: Date) =>
  date.toLocaleDateString('en-US', { timeZone: DELIVERY_TIME_ZONE })

/** YYYY-MM-DD as the Sales sheet writes dates: MM/DD/YYYY. */
export const sheetDate = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-')
  return `${month}/${day}/${year}`
}

/** A YYYY-MM-DD date as a spreadsheet date serial (days since 1899-12-30). */
export const sheetDateSerial = (isoDate: string) => {
  const [year, month, day] = isoDate.split('-').map(Number)
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000)
}
