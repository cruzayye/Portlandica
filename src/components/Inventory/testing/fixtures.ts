import type { Batch } from '@/lib/db/types'
import type { CustomerOption, HistoryEntry } from '../types'

// Test data for the Inventory tab's tests.

export const batch = (over: Partial<Batch> & { id: number }): Batch => ({
  created_at: '2026-01-01T00:00:00Z',
  name: 'Portlandica',
  count: 1440,
  isCustom: false,
  isStill: true,
  fillDate: '2026-09-26',
  totalCost: null,
  invoiceNumber: null,
  source: 'Opal Springs',
  initialCount: null,
  customer_id: null,
  archived_at: null,
  product: 'water',
  ...over,
})

export const customer = (
  over: Partial<CustomerOption> & { id: number; name: string }
): CustomerOption => ({ customCans: false, active: true, ...over })

export const historyEntry = (over: Partial<HistoryEntry> & { id: number }): HistoryEntry => ({
  at: '2026-10-02T22:14:00Z',
  change: -24,
  balance: 1416,
  reason: 'adjustment',
  order: null,
  by: 'you',
  note: null,
  ...over,
})
