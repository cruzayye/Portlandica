// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const supabaseJs = vi.hoisted(() => ({ createClient: vi.fn(() => ({ from: vi.fn() })) }))

vi.mock('@supabase/supabase-js', () => ({ createClient: supabaseJs.createClient }))

import { createClient } from './server'

const URL = 'https://project-ref.supabase.co'
const SECRET_KEY = 'sb_secret_made-up-key-for-tests'

beforeEach(() => {
  supabaseJs.createClient.mockClear()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL)
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET_KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createClient', () => {
  it('uses the secret key and keeps no auth session', async () => {
    await createClient()
    expect(supabaseJs.createClient).toHaveBeenCalledWith(URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  })

  it('never falls back to the publishable key', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_made-up')
    await expect(createClient()).rejects.toThrow('SUPABASE_SECRET_KEY is not set')
    expect(supabaseJs.createClient).not.toHaveBeenCalled()
  })

  it('refuses a publishable key pasted into SUPABASE_SECRET_KEY', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_publishable_made-up')
    await expect(createClient()).rejects.toThrow('holds the publishable key')
  })

  it('needs the project URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    await expect(createClient()).rejects.toThrow('NEXT_PUBLIC_SUPABASE_URL is not set')
  })
})
