// @vitest-environment node
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every export of a 'use server' file can be called over HTTP, so each one
// must turn away callers who aren't signed-in partners before touching
// Supabase, the Google Sheet, Trello or Square. This test calls every export of
// every action file in this folder (new files included), so an action without
// the check fails here.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  sheets: vi.fn(),
  trello: vi.fn(),
  square: vi.fn(),
  getLocationsFromSheet: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc,
  }),
}))
vi.mock('@/lib/google/sheets', () => ({
  getLocationsFromSheet: mocks.getLocationsFromSheet,
  findSameDaySheetOrder: mocks.sheets,
  writeOrderToSheet: mocks.sheets,
  untagOrderRows: mocks.sheets,
  findOrderRows: mocks.sheets,
  writeLocationCoordinates: mocks.sheets,
}))
vi.mock('@/lib/trello', () => ({
  createTrelloCard: mocks.trello,
  archiveTrelloCard: mocks.trello,
}))
vi.mock('@/lib/square', () => ({ createDraftInvoice: mocks.square }))
vi.mock('next/server', () => ({ after: vi.fn() }))

import * as orderActions from './orders'
import { NOT_A_PARTNER, SIGNED_OUT } from '@/lib/auth/authFailure'

type Action = (...args: unknown[]) => Promise<unknown>

const modules = import.meta.glob<Record<string, unknown>>(['./*.ts', '!./*.test.ts'], {
  eager: true,
})
const actions = Object.entries(modules).flatMap(([file, exports]) =>
  Object.entries(exports).map(([name, action]) => ({
    label: `${file.slice(2)} ${name}`,
    name,
    action: action as Action,
  }))
)

// The arguments don't matter: the check has to run before any of them are used.
const callWithDummyArgs = (action: Action) => action({}, 1, 2, null, false)

const expectNothingTouched = () => {
  expect(mocks.from).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.sheets).not.toHaveBeenCalled()
  expect(mocks.getLocationsFromSheet).not.toHaveBeenCalled()
  expect(mocks.trello).not.toHaveBeenCalled()
  expect(mocks.square).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.stubEnv('ALLOWED_EMAILS', 'partner@example.com')
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.each([
  {
    caller: 'a signed-out caller',
    user: null,
    message: SIGNED_OUT,
  },
  {
    caller: 'a signed-in non-partner',
    user: { id: 'user-2', email: 'stranger@example.com' },
    message: NOT_A_PARTNER,
  },
])('server actions called by $caller', ({ user, message }) => {
  it('finds the action files', () => {
    expect(actions.map((a) => a.label)).toEqual(
      expect.arrayContaining([
        'inventory.ts getInventory',
        'orders.ts createOrder',
        'orders.ts getOrderFormData',
        'orderHistory.ts listOrders',
        'orderHistory.ts retryOrder',
        'orderHistory.ts voidOrder',
      ])
    )
  })

  it.each(actions)('$label is refused before touching any data', async ({ action }) => {
    mocks.getUser.mockResolvedValue({ data: { user }, error: null })

    expect(await callWithDummyArgs(action)).toEqual({ authError: message })
    expectNothingTouched()
  })
})

// Answers every query with no rows, and records what was inserted.
const emptyTable = (inserted: unknown[]) => () => {
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    in: () => query,
    order: () => query,
    limit: () => query,
    insert: (rows: unknown) => {
      inserted.push(rows)
      return query
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [], error: null }),
  }
  return query
}

describe('server actions called by a partner', () => {
  it('get the real result', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'partner@example.com' } },
      error: null,
    })
    const inserted: unknown[] = []
    mocks.from.mockImplementation(emptyTable(inserted))
    mocks.getLocationsFromSheet.mockResolvedValue([
      {
        name: 'Dame',
        address: '123 NE Broadway',
        latitude: null,
        longitude: null,
        businessType: 'Restaurant',
      },
      {
        name: 'Dame',
        address: '123 NE Broadway',
        latitude: null,
        longitude: null,
        businessType: 'Restaurant',
      },
    ])

    expect(await orderActions.getOrderFormData()).toMatchObject({
      businessTypes: ['Restaurant'],
      batches: [],
      warnings: [],
    })
    // The locations tab's names go into the customers table, once each.
    expect(inserted).toEqual([[expect.objectContaining({ name: 'Dame', type: 'business' })]])
  })
})
