// @vitest-environment node
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every export of a 'use server' file can be called over HTTP, so each one
// must turn away callers who aren't signed-in partners before touching
// Supabase, the Google Sheet or Trello. This test calls every export of every
// action file in this folder (new files included), so an action without the
// check fails here.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  appendOrder: vi.fn(),
  getLocationsFromSheet: vi.fn(),
  createTrelloCard: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}))
vi.mock('@/lib/google/sheets', () => ({
  appendOrder: mocks.appendOrder,
  getLocationsFromSheet: mocks.getLocationsFromSheet,
}))
vi.mock('@/lib/trello', () => ({ createTrelloCard: mocks.createTrelloCard }))

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

// decrementInventory is only called by createOrder, so it throws instead.
const THROWS = new Set(['decrementInventory'])

// The arguments don't matter: the check has to run before any of them are used.
const callWithDummyArgs = (action: Action) => action({}, 1, 2, null, false)

const expectNothingTouched = () => {
  expect(mocks.from).not.toHaveBeenCalled()
  expect(mocks.appendOrder).not.toHaveBeenCalled()
  expect(mocks.getLocationsFromSheet).not.toHaveBeenCalled()
  expect(mocks.createTrelloCard).not.toHaveBeenCalled()
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
      expect.arrayContaining(['inventory.ts getInventory', 'orders.ts createOrder'])
    )
  })

  it.each(actions)('$label is refused before touching any data', async ({ name, action }) => {
    mocks.getUser.mockResolvedValue({ data: { user }, error: null })

    if (THROWS.has(name)) {
      await expect(callWithDummyArgs(action)).rejects.toThrow(message)
    } else {
      expect(await callWithDummyArgs(action)).toEqual({ authError: message })
    }
    expectNothingTouched()
  })
})

describe('server actions called by a partner', () => {
  it('get the real result', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'partner@example.com' } },
      error: null,
    })
    mocks.getLocationsFromSheet.mockResolvedValue([
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
    ])

    expect(await orderActions.getLocations()).toEqual([
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
    ])
  })
})
