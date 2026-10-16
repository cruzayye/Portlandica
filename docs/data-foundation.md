# Data foundation: customers, sales orders and an inventory ledger

Branch `feat/data-foundation` adds the database groundwork for three features: a
customers table, a master record of every order, and a history of every inventory
change. It contains migrations, typed server-side modules (`src/lib/db/`) and a customer
seed script. `feat/order-flow` wires it into the order form (`docs/order-flow.md`); the
order in which to apply everything is in `ROLLOUT.md`.

- **customers**: one row per business or person, so custom cans and prices no longer
  depend on typing a name exactly.
- **sales_orders** and **sales_order_lines**: every order, the batch each line draws
  from, and how each downstream step went (Sales sheet, inventory, Trello, Square). An
  idempotency key means a double click or a retry can't book the same order twice.
- **inventory_movements**: an append-only ledger. For every batch, the movements add up
  to `inventory.count`; the `inventory_ledger_check` view shows any batch where they
  don't.
- **inventory** gains `customer_id`, `archived_at` and `product`. No existing column is
  renamed, dropped or changed.
- Eight SQL functions make every change that touches stock or orders, each in one
  transaction.

Migrations: `supabase/migrations/20261017000100_customers.sql` through
`20261017000600_order_functions.sql`. They need `public.is_partner()` from database step 1
(`20261015120000_partner_access.sql`, see `SETUP.md`) and stop with a clear error if it is
missing.

## Tables

### customers

| Column                                   | Notes                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`                                   | Required, stored trimmed.                                                                                                  |
| `name_key`                               | Generated: `lower(btrim(name))`, unique. "Hotel Vintage" and "hotel vintage " are one customer. Look customers up by this. |
| `type`                                   | `business` or `individual`.                                                                                                |
| `business_type`                          | Restaurant, Cafe, Hotel… (the locations tab's Type of Business).                                                           |
| `parent_company`                         | From the Parent Companies tab. Text, like the Sales sheet's column R.                                                      |
| `price_per_can`                          | Dollars. NULL means the $1.50 default (`DEFAULT_PRICE_PER_CAN`).                                                           |
| `custom_cans`                            | True for customers with custom-printed cans.                                                                               |
| `payment_terms_days`                     | NULL means the 30-day default. Sysco is 65.                                                                                |
| `street_address`, `city`, `state`, `zip` | Parsed from the sheet's one-line address.                                                                                  |
| `latitude`, `longitude`                  | Both or neither.                                                                                                           |
| `email`                                  | Where invoices go, when known (the Square module can use it).                                                              |
| `square_customer_id`                     | Unique once linked.                                                                                                        |
| `active`                                 | False hides a customer without losing their orders.                                                                        |
| `notes`                                  | Free text. The seed puts a second address here for names listed twice.                                                     |

### inventory (new columns)

| Column        | Notes                                                                                |
| ------------- | ------------------------------------------------------------------------------------ |
| `customer_id` | The customer a custom batch was filled for. Only allowed on custom batches.          |
| `archived_at` | Set by `archive_batch`. Archived batches drop out of pickers but keep their history. |
| `product`     | `water` (default) or `dog_water`. Still vs sparkling stays in `"isStill"`.           |

Why a `product` column for dog water: "Portlandica Dog water" is still water in dog-water
cans, so with only `isStill` and `isCustom` the order form offers it for every still-water
order. A product column says what is in the can, keeps the existing flags meaning what
they mean today, and lets order lines say what was sold (`still`, `sparkling`,
`dog_water`). The migration marks the existing dog-water batch by its name. A separate
products table would be more than two products need.

### sales_orders

| Column                                                               | Notes                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `idempotency_key`                                                    | Unique. The form makes one per submission and reuses it on every retry.                                                  |
| `order_date`                                                         | Portland date (the Sales sheet's Date).                                                                                  |
| `customer_id`, `customer_name`                                       | The customer, plus their name as it was when ordered. `customer_id` can be NULL for a one-off individual.                |
| `type`                                                               | `business` or `individual`.                                                                                              |
| `delivery_type`, `delivery_date`                                     | `drop`, `ship` or `pickup`; the date is optional.                                                                        |
| `po_number`, `notes`                                                 | Optional. Sysco sends a PO number per order.                                                                             |
| `total_cans`, `total_price`                                          | `total_price` is what's charged; it can differ from the sum of the lines by rounding or a hand-typed price.              |
| `is_paid`, `create_invoice`, `is_donation`                           | A donation must have `total_price = 0`.                                                                                  |
| `sheet_status`, `inventory_status`, `trello_status`, `square_status` | `pending`, `done`, `failed` or `skipped`, each with an `_error` column. Square starts `skipped` unless `create_invoice`. |
| `trello_card_id`, `square_invoice_id`                                | Unique; required for that step to be `done`.                                                                             |
| `voided_at`, `voided_by`, `void_reason`                              | Set together by `void_order`.                                                                                            |
| `created_by`, `created_at`, `updated_at`                             | `created_by` is the Supabase Auth user, if any; NULL for the app, which uses the secret key with the team password.      |

### sales_order_lines

`product` (`still`, `sparkling`, `dog_water`), `cans`, `batch_id`, `is_custom`,
`unit_price` (dollars, four decimals so a hand-typed total can be spread over every
can) and `line_total` (generated, rounded to cents). `is_custom` is copied from the batch
by a trigger, and the same trigger refuses a batch that holds a different product (a
still line from the sparkling or dog-water batch) or is archived.

### inventory_movements

`batch_id`, `delta` (cans, never 0), `reason`, `order_id` and `order_line_id` (order
and void movements only), `note`, `created_by` (the Supabase Auth user, if any),
`made_in_app` (true when the change came through the Data API, which is how the app makes
them; added by `20261017000900_ledger_made_in_app.sql`), `created_at`. Reasons:

| Reason          | Written by                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`       | The ledger migration: each batch's count when the ledger started. Its own reason so opening balances don't show up as adjustments in reports. |
| `fill`          | `record_fill`, or a batch inserted any other way.                                                                                             |
| `order`, `void` | `apply_order_inventory` and `void_order`. At most one of each per order line.                                                                 |
| `adjustment`    | `adjust_batch` with a note, or any other count change (see below).                                                                            |
| `archive`       | `archive_batch` writing off what's left, and `unarchive_batch` putting it back.                                                               |

Nobody writes the ledger directly: the app writes it only through the functions, and
signed-in partners can only read it. A trigger on `inventory` records
every count change that doesn't come through the functions (today's Inventory tab, the
current order flow, the Supabase dashboard) as an adjustment, so the history is
complete from the day the migration runs.

## Functions

Call them from server code with `supabase.rpc()`, or through `src/lib/db`.

| Function                                                        | Does                                                                                                                                                 | Called again                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `create_sales_order(...)`                                       | Inserts the order and its lines in one transaction, totals them, returns `{created, order, lines}`.                                                  | Same idempotency key returns the existing order with `created: false`; nothing is written. |
| `apply_order_inventory(order_id, allow_negative)`               | One `order` movement per line and `count = count - cans`, all or nothing. Refuses with `insufficient_stock` (and how short) unless `allow_negative`. | No change.                                                                                 |
| `void_order(order_id, reason)`                                  | Puts back every can the order took out and marks it void. Leaves Trello, Square and the sheet to the caller.                                         | No change.                                                                                 |
| `record_order_step(order_id, step, status, external_id, error)` | Records how the sheet, Trello or Square step went (or an inventory failure).                                                                         | A `done` step stays done; a second Trello card or Square invoice id is refused.            |
| `record_fill(...)`                                              | New batch plus its `fill` movement. A custom batch takes its customer's name.                                                                        | Each call is a new batch.                                                                  |
| `adjust_batch(batch_id, new_count, note, expected_count)`       | Sets a counted number with a note. `expected_count` (optional) refuses if someone changed the count meanwhile.                                       | No change if the count already matches.                                                    |
| `archive_batch(batch_id, note)`                                 | Writes off what's left and hides the batch.                                                                                                          | No change.                                                                                 |
| `unarchive_batch(batch_id, note)`                               | Undoes the archive, restoring the written-off cans.                                                                                                  | No change.                                                                                 |

The order flow's `20261017000700_order_flow.sql` makes one exception to "a done step stays
done": once a void deletes the order's Square draft, its Square step is recorded as
`skipped`, keeping the invoice id.

All eight are `security definer` with `search_path = ''`, executable only by
`authenticated` and `service_role`, and they call `public.is_partner()` for every request
that comes through the API. The SQL Editor (no API request) and the service role are
trusted; the app's server calls them as the service role. Errors carry a hint such as
`insufficient_stock`, `batch_archived` or `order_void`; `DbError` in
`src/lib/db/errors.ts` turns those into codes.

## Who can do what

- **The app** (its server, with the secret key: the service role): everything. Every
  server action checks the team password session first (`SETUP.md`).
- **Service role** (scripts such as the seed): everything.
- **Partners** (signed in through Supabase Auth, `is_partner()`): read every new table; add
  and edit customers directly; change orders and the ledger only through the functions.
  Dormant with the team password: nobody signs in through Supabase Auth and the partner
  list is empty.
- **Signed-in non-partners**: nothing on the new tables or functions.
- **The publishable key on its own**: nothing on the new tables or functions. Reading
  `inventory` works as before and now includes the three new columns.

## Choices worth knowing

1. **New names instead of renaming `orders`.** The legacy `orders` table stays exactly as
   it is. Renaming it would also mean renaming its key constraint and sequence, and could
   break anything still pointing at it. "Sales order" also matches the Sales sheet and
   keeps orders apart from fills. Drop the legacy table once you're sure nothing reads it.
2. **Archive, don't delete.** Batches with any history can't be deleted; archive them.
   That is every batch once the opening balances are in.
3. **Stock doesn't silently go negative.** The UI can ask "only 100 cans left, book it
   anyway?" and retry with `allow_negative`, like it does for same-day duplicates.
4. **Retries are safe by design.** Create returns the existing order on a repeat, apply
   and void act once, and `pendingSteps(order)` lists what is left, so a failed Trello or
   Square call is retried on its own without rebooking the order.
5. **Whose custom batch a line may use is left to the UI** (`batchesForLine`), so a
   hotel group can still share a fill when you decide it should.
6. **Beyond the brief**, all small: `name_key`, `email`, `notes`, `po_number`,
   `order_date`, `voided_by`, the `opening` reason, `create_sales_order` (an order and its
   lines can't be written atomically through the REST API otherwise),
   `record_order_step`, `unarchive_batch`, `adjust_batch`'s `expected_count`,
   `inventory_ledger_check`, and a tested rollback script.

## What changes for the app that's live today

The migrations are safe to apply before the UI is wired. Four visible effects:

- Count edits in the Inventory tab and the current order form's decrements appear in the
  ledger as adjustments. Counts themselves don't change.
- **Deleting a batch in the Inventory tab now fails** ("has history and cannot be
  deleted"). Until the new UI lands, retire a batch in the SQL Editor with
  `select public.archive_batch(<id>, 'why');`. The old UI will still list it, at 0 cans.
- Batch names are trimmed when saved, so "Hotel Vintage " can't happen again.
- The old order form still offers the dog-water batch for still orders; the new pickers
  don't.

Paul's monthly-close script keeps working: it reads the same columns, now with three
more alongside.

## Steps for Johnny, in order

1. **Finish `SETUP.md` first** (team password live, database steps 1 and 2 done). These
   migrations need step 1's `public.is_partner()`, and `supabase db push` applies every
   pending migration in order, so pushing before then would also apply step 2 before the
   team-password version is live.

2. **Set up the Supabase CLI** (it's a dev dependency). `db pull` needs Docker Desktop
   running.

   ```bash
   npx supabase login
   npx supabase init
   npx supabase link --project-ref <project-ref>
   ```

   `<project-ref>` is the subdomain in `NEXT_PUBLIC_SUPABASE_URL` (also under Project
   Settings → General). Skip `init` if `supabase/config.toml` already exists.

3. **Capture the live schema as the baseline with `supabase db pull`.** It has to run
   with an empty `supabase/migrations` folder, so set any migration files aside first,
   then name the baseline so it sorts before every other migration:

   ```bash
   mkdir -p supabase/migrations
   mv supabase/migrations supabase/migrations.aside
   mkdir supabase/migrations
   npx supabase db pull
   mv supabase/migrations/*_remote_schema.sql supabase/migrations.aside/20261015000000_remote_schema.sql
   rmdir supabase/migrations
   mv supabase/migrations.aside supabase/migrations
   npx supabase migration repair --status applied 20261015000000
   ```

   If `db pull` asks "Update remote migration history table?", answer **n**. If you
   answered y, also mark the version it recorded as reverted with
   `npx supabase migration repair --status reverted <version>`. Then mark database steps 1
   and 2, which you ran in the SQL Editor, as applied:

   ```bash
   npx supabase migration repair --status applied 20261015120000 20261015120100
   ```

   Commit the baseline file.

4. **Merge `feat/data-foundation`** (on `integration/combined` it already is). If
   `package-lock.json` conflicts, take either side and run `npm install`. Then check:

   ```bash
   npm ci
   npm test
   npx tsc --noEmit
   ```

   Optional but worth it: rehearse the whole chain (baseline, database steps 1 and 2,
   these six) on a local copy first. It needs Docker. `db reset` without `--linked` only
   touches the local database; never add `--linked`.

   ```bash
   npx supabase start
   npx supabase db reset
   npx supabase stop
   ```

   A clean reset proves the migrations apply on the real schema. The local copy has no
   rows, so the data checks in step 6 only mean something on the live database.

5. **Preview, then apply.**

   ```bash
   npx supabase migration list
   npx supabase db push --dry-run
   ```

   `migration list` should show Local and Remote matching for everything except the
   six `20261017…` files, and the dry run should list exactly those six. (On
   `integration/final` there are more; follow `ROLLOUT.md` step 5 there.) If it lists
   anything else, stop and sort that out first. Then:

   ```bash
   npx supabase db push
   ```

   (Without the CLI, running the six files in order in the SQL Editor does the same.)

6. **Check the result** in the SQL Editor:

   ```sql
   select * from inventory_ledger_check where difference <> 0;  -- expect no rows
   select id, name, product from inventory where product = 'dog_water';  -- the dog water batch
   select reason, count(*), sum(delta) from inventory_movements group by reason;  -- one opening row per batch with cans
   ```

   Security Advisor will list warning 0029 for the eight new functions ("callable by
   signed-in users"). That's expected: they check `is_partner()` themselves. If anything
   looks wrong now, before real data goes in, `supabase/rollback/20261017_data_foundation.sql`
   removes everything these migrations added.

7. **Seed the customers.** The script uses the app's own `SUPABASE_SECRET_KEY`,
   `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID` and `NEXT_PUBLIC_SUPABASE_URL` from
   `.env.local` (`SETUP.md`; server only, never `NEXT_PUBLIC_`, never committed), and reads
   the sheet with the read-only scope.

   ```bash
   npx tsx --env-file=.env.local scripts/seed-customers.ts
   ```

   This is a dry run: it changes nothing and writes `seed-output/customers.csv` and
   `seed-output/batches.csv` (git-ignored; they contain prices). On the 2026-10-15 data
   it plans 237 customers and links 9 of the 10 custom batches; Hotel Vintage's batch is
   renamed to drop its trailing space. Expect these to be flagged:
   - **Dame**: custom batch, no customer by that name.
   - **Embassy Suites by Hilton Portland Downtown**: custom batches but no agreed price,
     so it would default to $1.50.
   - **Farmer and the Beast, Happy Day Juice Co, La Arepa**: listed twice; the second
     address goes in notes.
   - **Foodie Stash, Vanport Jazz Festival, Spirit of Sage, Sysco**: no address.
   - **Nomad Getaways**: address the parser couldn't place.

   Fix anything you want fixed in the sheet and run the dry run again. When the CSVs
   look right:

   ```bash
   npx tsx --env-file=.env.local scripts/seed-customers.ts --apply
   ```

   `--apply` writes only if a fresh plan matches the CSVs you reviewed; otherwise it
   rewrites them and stops. The customers go in as one all-or-nothing insert.

8. **Tidy up what the seed flagged.** For Dame, add the customer, then run the dry run
   and `--apply` again to link the batch:

   ```sql
   insert into customers (name, custom_cans) values ('Dame', true);
   ```

   Set Embassy Suites' price if it isn't $1.50
   (`update customers set price_per_can = 2.00 where name_key = 'embassy suites by hilton portland downtown';`).
   Then delete the `seed-output` folder.

9. **Optional: generate types** once everything is in, to replace the hand-written ones
   in `src/lib/db/types.ts`:

   ```bash
   npx supabase gen types typescript --linked > src/lib/db/database.types.ts
   ```

## For the session that wires the UI

- Create the client with `createClient()` from `@/lib/supabase/server` and pass it to the
  functions in `src/lib/db` (`customers.ts`, `inventory.ts`, `orders.ts`).
- **Order flow:** keep a `newIdempotencyKey()` in the form's state, made fresh after each
  successful order and reused on retries. Then `createSalesOrder` → `applyOrderInventory`
  → sheet → Trello → Square, recording each outcome with `recordOrderStep`.
  `pendingSteps(order)` and `listUnfinishedOrders` drive a retry button.
- **Insufficient stock:** catch `DbError` with `code === 'insufficient_stock'`, show
  `error.shortfall`, and retry with `{ allowNegative: true }` if the partner confirms.
  Production builds strip thrown error messages from server actions, so return result
  objects to the client rather than throwing.
- **Prices:** `priceLines(lines, { pricePerCan: pricePerCan(customer), totalPrice,
isDonation })`; pass the same `total_price` to `createSalesOrder` when the partner typed
  a total. Square needs whole-cent unit prices, so a typed total that doesn't divide
  evenly is billed as one lot (see `docs/integrations.md` on `feat/integrations`).
- **Square:** use the order's `id` as the never-reused order id, `paymentTermsDays(customer)`
  for terms, `customer.email` when known, and store ids with
  `recordOrderStep(db, id, 'square', 'done', { externalId })` and
  `updateCustomer(db, id, { square_customer_id })`.
- **Batch pickers:** `batchesForLine(await listBatches(db), product, { id, name })`.
- **Inventory tab:** `adjustBatch(db, id, newCount, note, { expectedCount })`,
  `archiveBatch` in place of delete, `recordFill` for new batches, `listMovements` for
  history.
- **Same-day warning:** `findSameDayOrders(db, { orderDate, customerId, customerName })`.
- **Form values:** the fixed order form's `customerType` `existing`/`new` maps to
  `business` and `individual` to `individual`; `deliveryTypeFromForm('Drop')` gives
  `drop`.

## Tests

`npm test` runs the migrations in PGlite, an in-process Postgres, on top of a Supabase
stand-in (roles, `auth.uid()` and default grants) and an approximation of the live schema
and its access today, with a few batches shaped like the real ones
(`src/lib/db/testing/sql/`). Database steps 1 and 2 run first with an empty partner list,
as in production; two made-up partners are added afterwards so the dormant partner path is
still covered. `migrations.test.ts` exercises the SQL as anon, a signed-in non-partner,
partners and the service role (which the app uses). The module and seed tests go through
`testing/fakeSupabase.ts`, a small stand-in for the REST client that runs each call as
the given role, so RLS, grants and the functions' argument names are all exercised.

## Not verified

- Nothing has run against the real database. Live column types (for example whether
  `count` is `integer` or `bigint`, `"fillDate"` `date` or `text`) are guesses; the SQL
  is written to work either way, and `db pull` will show the real ones.
- PGlite is Postgres 18; Supabase runs 15 or 17. Nothing 18-only is used.
- The REST client in tests is a stand-in, not PostgREST itself.
- Two orders applied at the same moment: rows are locked in a fixed order to
  avoid deadlocks, but PGlite has one connection, so this isn't tested.
- The migrations haven't been applied on top of the real baseline; the optional
  rehearsal in step 4 does that before anything touches production.
