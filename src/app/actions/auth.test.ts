// @vitest-environment node
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Every export of a 'use server' file can be called over HTTP, so each one must turn away
// callers without a valid team session before touching Supabase, the Google Sheet or
// Trello. This test calls every export of every action file in this folder (new files
// included) with each kind of cookie that must be refused, so an action without the
// two-line requireUser() check fails here.

const mocks = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  createClient: vi.fn(),
  appendOrder: vi.fn(),
  getLocationsFromSheet: vi.fn(),
  createTrelloCard: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.cookies.has(name) ? { name, value: mocks.cookies.get(name) } : undefined,
  }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/google/sheets', () => ({
  appendOrder: mocks.appendOrder,
  getLocationsFromSheet: mocks.getLocationsFromSheet,
}))
vi.mock('@/lib/trello', () => ({ createTrelloCard: mocks.createTrelloCard }))

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

// decrementInventory is only called by createOrder, so it throws instead.
const THROWS = new Set(['decrementInventory'])

// The arguments don't matter: the check has to run before any of them are used.
const callWithDummyArgs = (action: Action) => action({}, 1, 2, null, false)

const expectNothingTouched = () => {
  expect(mocks.createClient).not.toHaveBeenCalled()
  expect(mocks.appendOrder).not.toHaveBeenCalled()
  expect(mocks.getLocationsFromSheet).not.toHaveBeenCalled()
  expect(mocks.createTrelloCard).not.toHaveBeenCalled()
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
      expect.arrayContaining(['inventory.ts getInventory', 'orders.ts createOrder'])
    )
  })

  it.each(actions)('$label is refused before touching any data', async ({ name, action }) => {
    if (THROWS.has(name)) {
      await expect(callWithDummyArgs(action)).rejects.toThrow(message)
    } else {
      expect(await callWithDummyArgs(action)).toEqual({ authError: message })
    }
    expectNothingTouched()
  })
})

describe('server actions called by a signed-in device', () => {
  it('get the real result', async () => {
    mocks.cookies.set(SESSION_COOKIE, validToken())
    mocks.getLocationsFromSheet.mockResolvedValue([
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
    ])

    expect(await orderActions.getLocations()).toEqual([
      { name: 'Dame', address: '123 NE Broadway', businessType: 'Restaurant' },
    ])
  })
})
