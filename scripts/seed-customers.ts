// Seed the customers table from the Sales sheet and link custom inventory batches to
// their customers. See docs/data-foundation.md.
//
// 1. Dry run: reads the sheet (read-only) and the database, writes the plan to
//    seed-output/customers.csv and seed-output/batches.csv, and changes nothing.
//      npx tsx --env-file=.env.local scripts/seed-customers.ts
// 2. Review the CSVs (fix the sheet or add customers and re-run as needed).
// 3. Apply exactly what was reviewed. Refuses if the plan no longer matches the CSVs.
//      npx tsx --env-file=.env.local scripts/seed-customers.ts --apply
//
// Env: GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID (the app's own), plus
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard, API keys).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { google } from 'googleapis'
import {
  CUSTOMER_PAYMENT_TERMS,
  CUSTOMER_PRICING,
  applySeedPlan,
  batchesCsv,
  buildSeedPlan,
  customersCsv,
  type SeedPlan,
} from '../src/lib/db/customerSeed'
import { unwrap } from '../src/lib/db/errors'
import type { Batch, Customer } from '../src/lib/db/types'

const READ_ONLY_SHEETS = 'https://www.googleapis.com/auth/spreadsheets.readonly'

const requireEnv = (name: string) => {
  const value = process.env[name]
  if (!value)
    throw new Error(`Missing ${name}. Run with --env-file=.env.local (see the top of this file).`)
  return value
}

const readSheetTabs = async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON')),
    scopes: [READ_ONLY_SHEETS],
  })
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.batchGet({
    spreadsheetId: requireEnv('GOOGLE_SHEET_ID'),
    ranges: ["'Current Locations Addresses'!A:E", "'Parent Companies'!A:B"],
  })
  const [locations = [], parentCompanies = []] = (res.data.valueRanges ?? []).map(
    (range) => (range.values ?? []) as string[][]
  )
  return { locations, parentCompanies }
}

const summarize = (plan: SeedPlan) => {
  const inserts = plan.customers.filter((row) => row.action === 'insert').length
  const links = plan.batches.filter((row) => row.action === 'link')
  console.log(
    `Customers: ${inserts} to add, ${plan.customers.length - inserts} already in the database.`
  )
  console.log(
    `Custom batches: ${links.length} to link (${links.filter((row) => row.rename_to).length} renamed to the customer's exact name).`
  )
  for (const row of plan.customers.filter((r) => r.issues.length)) {
    console.log(`  check ${row.customer.name}: ${row.issues.join('; ')}`)
  }
  for (const row of plan.batches.filter((r) => r.action === 'unmatched')) {
    const hint = row.suggestions.length ? ` (maybe ${row.suggestions.join(', ')})` : ''
    console.log(`  unmatched batch #${row.batch_id} "${row.batch_name}"${hint}`)
  }
  for (const note of plan.notes) console.log(`  note: ${note}`)
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Usage: npx tsx --env-file=.env.local scripts/seed-customers.ts [--apply] [--out <dir>]'
    )
    return
  }
  const apply = args.includes('--apply')
  const outIndex = args.indexOf('--out')
  const outDir = outIndex >= 0 ? args[outIndex + 1] : 'seed-output'

  const db = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  )
  const [{ locations, parentCompanies }, batches, existing] = await Promise.all([
    readSheetTabs(),
    db
      .from('inventory')
      .select('id, name, isCustom, customer_id')
      .then((res) => unwrap<Pick<Batch, 'id' | 'name' | 'isCustom' | 'customer_id'>[]>(res)),
    db
      .from('customers')
      .select('id, name, name_key')
      .then((res) => unwrap<Pick<Customer, 'id' | 'name' | 'name_key'>[]>(res)),
  ])

  const plan = buildSeedPlan({
    locations,
    parentCompanies,
    pricing: CUSTOMER_PRICING,
    paymentTerms: CUSTOMER_PAYMENT_TERMS,
    batches,
    existing,
  })
  const files = {
    [path.join(outDir, 'customers.csv')]: customersCsv(plan),
    [path.join(outDir, 'batches.csv')]: batchesCsv(plan),
  }
  summarize(plan)

  if (apply) {
    const unchanged = Object.entries(files).every(
      ([file, csv]) => existsSync(file) && readFileSync(file, 'utf8') === csv
    )
    if (!unchanged) {
      mkdirSync(outDir, { recursive: true })
      for (const [file, csv] of Object.entries(files)) writeFileSync(file, csv)
      console.log(
        `\nThe plan differs from the CSVs in ${outDir}/ (or they don't exist). They've been rewritten; review them and run --apply again.`
      )
      process.exitCode = 1
      return
    }
    const result = await applySeedPlan(db, plan)
    console.log(
      `\nApplied: ${result.inserted} customers added, ${result.linked} batches linked, ${result.renamed} renamed.`
    )
    return
  }

  mkdirSync(outDir, { recursive: true })
  for (const [file, csv] of Object.entries(files)) writeFileSync(file, csv)
  console.log(
    `\nDry run only. Review ${Object.keys(files).join(' and ')}, then run again with --apply.`
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
