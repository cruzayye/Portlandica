'use server'

import { requireUser, type AuthFailure } from '@/lib/auth/requireUser'
import { fetchAipNumbers, type AipNumbers } from '@/lib/aip'

/**
 * The A.I.P Numbers dashboard data for the A.I.P Numbers tab. Fetched here on the server,
 * so the Apps Script address and token never reach the browser.
 */
export const getAipNumbers = async (): Promise<AipNumbers | AuthFailure> => {
  const { failure } = await requireUser()
  if (failure) return failure
  return fetchAipNumbers()
}
