// @vitest-environment node
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every export of a 'use server' file can be called over HTTP, so each one must turn away
// callers without a valid team session before touching Supabase, the Google Sheet, Trello
// or Square. This test calls every export of every action file in this folder (new files
// included) with each kind of cookie that must be refused, so an action without the
// two-line requireUser() check fails here.

const mocks = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  createClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  sheets: vi.fn(),
  trello: vi.fn(),
  square: vi.fn(),
  getLocationsFromSheet: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.cookies.has(name) ? { name, value: mocks.cookies.get(name) } : undefined,
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    mocks.createClient()
    return { from: mocks.from, rpc: mocks.rpc }
  },
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
vi.mock('@/lib/square', () => ({
  createDraftInvoice: mocks.square,
  deleteDraftInvoice: mocks.square,
}))
vi.mock('next/server', () => ({ after: vi.fn() }))

import * as orderActions from './orders'
import { SIGNED_OUT, SIGN_IN_NOT_SET_UP } from '@/lib/auth/authFailure'
import { SESSION_COOKIE } from '@/lib/auth/session'
import { rejectedTokens, stubTestAuthEnv, validToken } from '@/lib/auth/testing/sessions'

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
  expect(mocks.createClient).not.toHaveBeenCalled()
  expect(mocks.from).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.sheets).not.toHaveBeenCalled()
  expect(mocks.getLocationsFromSheet).not.toHaveBeenCalled()
  expect(mocks.trello).not.toHaveBeenCalled()
  expect(mocks.square).not.toHaveBeenCalled()
}

beforeEach(() => {
  mocks.cookies.clear()
  stubTestAuthEnv()
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const refusedCallers = [
  { caller: 'a signed-out caller', cookie: null, env: {}, message: SIGNED_OUT },
  ...Object.entries(rejectedTokens()).map(([kind, cookie]) => ({
    caller: `a caller whose cookie is ${kind}`,
    cookie,
    env: {},
    message: SIGNED_OUT,
  })),
  {
    caller: 'any caller while TEAM_PASSWORD is not set',
    cookie: validToken(),
    env: { TEAM_PASSWORD: '' },
    message: SIGN_IN_NOT_SET_UP,
  },
]

describe.each(refusedCallers)('server actions called by $caller', ({ cookie, env, message }) => {
  beforeEach(() => {
    if (cookie !== null) mocks.cookies.set(SESSION_COOKIE, cookie)
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  })

  it('finds the action files', () => {
    expect(actions.map((a) => a.label)).toEqual(
      expect.arrayContaining([
        'orders.ts createOrder',
        'orders.ts getOrderFormData',
        'orderHistory.ts listOrders',
        'orderHistory.ts retryOrder',
        'orderHistory.ts voidOrder',
        'batches.ts loadInventory',
        'batches.ts getBatchHistory',
      ])
    )
  })

  it.each(actions)('$label is refused before touching any data', async ({ action }) => {
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

describe('server actions called by a signed-in device', () => {
  it('get the real result', async () => {
    mocks.cookies.set(SESSION_COOKIE, validToken())
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
