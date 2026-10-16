# Rollout: from today's live app to the new order flow

One checklist, in order. Each step says how to check it worked and how to undo it. Don't
start a step until the one before it checks out.

What gets deployed:

- **Step 2** deploys `integration/combined` (#29): the team password, the order-form
  fixes, and the data-foundation and integration code, which nothing calls yet.
- **Step 7** deploys `integration/final` (this branch, #30): the order flow wired into the
  order form, the Order History tab, and the Inventory tab rebuilt on the inventory
  ledger.

Database changes run in the Supabase SQL Editor (database steps 1 and 2) or with the
Supabase CLI (everything after). Vercel deploys whatever lands on `main`, so a branch that
needs new database objects must not reach `main` before they exist.

Before you start: Docker Desktop (for `supabase db pull`), and `npm ci` in a checkout of
this branch.

| #   | Step                                       | Where                     |
| --- | ------------------------------------------ | ------------------------- |
| 1   | Team-password env vars                     | Vercel                    |
| 2   | Deploy the team password (#29), sign in    | merge to `main`, Vercel   |
| 3   | Database steps 1 and 2 (lock the database) | Supabase SQL Editor       |
| 4   | `supabase db pull` baseline                | this branch, your machine |
| 5   | Data-foundation migrations                 | this branch, your machine |
| 6   | Seed customers                             | this branch, your machine |
| 7   | Deploy this branch (#30)                   | merge to `main`, Vercel   |
| 8   | Square sandbox test                        | your machine              |
| 9   | Square in production                       | Vercel, after Paul's OK   |

## 1. Team-password env vars

SETUP.md step 1. In Vercel → Settings → Environment Variables, for Production, Preview and
Development, set:

- `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → Secret keys.
- `TEAM_PASSWORD`: the password the team will type, at least 12 characters. A 4 or 5 word
  passphrase.
- `SESSION_SECRET`: at least 32 random characters, from `openssl rand -hex 32`.

All three are server-only: no `NEXT_PUBLIC_` prefix. Remove `ALLOWED_EMAILS` and
`ENABLE_GOOGLE_LOGIN` if they are set; nothing reads them any more.

**Check:** all three are listed for all three environments. Nothing is deployed yet, so
the live site is unchanged.

**Undo:** delete them. The live app doesn't read them.

## 2. Deploy the team password (#29), sign in

Merge `integration/combined` (#29) into `main` and let Vercel deploy it. Then everyone
signs in once on each phone and computer (SETUP.md step 2).

**Check:** SETUP.md step 2. A private window lands on `/login`; a wrong password is
refused; the right one opens the app and the Inventory tab loads; edit a count and set it
back (this checks the secret key).

**Undo:** Vercel → Deployments → the last deployment before this one → Promote to
Production. The env vars can stay.

## 3. Database steps 1 and 2 (lock the database)

SETUP.md steps 3 and 4, in the SQL Editor:

1. Run `supabase/migrations/20261015120000_partner_access.sql` (step 1). Leave
   `private.partner_emails` empty.
2. Save the current policies, run
   `supabase/migrations/20261015120100_tighten_database_permissions.sql` (step 2), and run
   its check query.

**Check:** the curl checks in SETUP.md step 4: the publishable key still reads inventory
(the monthly-close script needs that) and can no longer change it. In the app, edit a
count and set it back.

**Undo:** step 2: re-create the policies from the output you saved and
`grant insert, update, delete on public.inventory to anon;`. Do this too if you ever put
a version from before the team password back live. Step 1, only before step 5 (the
data-foundation migrations depend on it):

```sql
drop policy "Partners can manage inventory" on public.inventory;
drop function public.is_partner();
drop table private.partner_emails;
```

Step 1 also grants `authenticated` access to `inventory`. Supabase's default grants
usually include that already, so leave it.

## 4. `supabase db pull` baseline

In a checkout of **this branch** (it holds every migration so far), follow
docs/data-foundation.md steps 2 and 3: `supabase login`, `init`, `link`, then capture the
live schema as `supabase/migrations/20261015000000_remote_schema.sql` and mark it and
database steps 1 and 2 as applied. Commit the baseline on this branch. Don't merge
anything into `main` yet.

**Check:** `npx supabase migration list` shows Local and Remote matching for
`20261015000000`, `20261015120000` and `20261015120100`, and nine local-only
`20261017…` migrations.

**Undo:** nothing in the database changed except the CLI's migration history. Run
`npx supabase migration repair --status reverted 20261015000000 20261015120000 20261015120100`
and delete the baseline file.

## 5. Data-foundation migrations

Still in this branch's checkout. Optional but worth it first: rehearse on a local copy
(`npx supabase start`, `npx supabase db reset`, `npx supabase stop`; never add
`--linked`). Then:

```bash
npx supabase db push --dry-run
npx supabase db push
```

The dry run must list exactly the nine files `20261017000100_customers.sql` to
`20261017000900_ledger_made_in_app.sql`: data-foundation's six; the order flow's
`20261017000700_order_flow.sql`, which only adds four columns to `sales_orders` and new
versions of two functions nothing calls yet; `20261017000800_revoke_truncate.sql`, which
takes TRUNCATE away from the `anon` and `authenticated` roles; and
`20261017000900_ledger_made_in_app.sql`, which adds one column to `inventory_movements`
marking the changes made in the app (the Inventory tab shows them as "Team"). If it lists
anything else, stop.

**Check** (SQL Editor):

```sql
select * from inventory_ledger_check where difference <> 0;  -- no rows
select reason, count(*), sum(delta) from inventory_movements group by reason;  -- one opening row per batch with cans
select column_name from information_schema.columns
where table_name = 'sales_orders'
  and column_name in ('delivery_address', 'customer_email', 'sheet_ref', 'new_customer');  -- 4 rows
select count(*) from inventory_movements where made_in_app;  -- 0: the opening balances are the system's
```

From here until step 7, deleting a batch in today's Inventory tab fails ("has history");
retire one with `select public.archive_batch(<id>, 'why');` instead. Orders keep working.

**Undo** (only before real orders go into the new tables; it deletes them): in the SQL
Editor run `supabase/rollback/20261017000900_ledger_made_in_app.sql`, then
`supabase/rollback/20261017000700_order_flow.sql`, then
`supabase/rollback/20261017_data_foundation.sql`, then
`npx supabase migration repair --status reverted 20261017000100 20261017000200 20261017000300 20261017000400 20261017000500 20261017000600 20261017000700 20261017000800 20261017000900`.
The TRUNCATE revoke can stay; nothing needs it back.

## 6. Seed customers

docs/data-foundation.md steps 7 and 8: dry run, review `seed-output/customers.csv` and
`seed-output/batches.csv`, `--apply`, then tidy what it flagged (Dame, Embassy Suites'
price). The script uses the same `SUPABASE_SECRET_KEY` as the app, from your
`.env.local`.

Every custom batch must end up linked to its customer. The new order form offers custom
cans by `customer_id` only, so an unlinked custom batch is offered to nobody.

**Check:**

```sql
select count(*) from customers;  -- about 237
select id, name from inventory
where "isCustom" and archived_at is null and customer_id is null;  -- no rows
select name, price_per_can, payment_terms_days from customers
where price_per_can is not null or payment_terms_days is not null;  -- the eight agreed prices, Sysco on 65
```

**Undo:** `update inventory set customer_id = null where customer_id is not null;` then
`delete from customers;` (works only while no order points at a customer). Batch names
the seed trimmed stay trimmed.

## 7. Deploy this branch (#30)

In Vercel (Production, Preview, Development), check `TRELLO_API_KEY`, `TRELLO_TOKEN`,
`TRELLO_LIST_ID` and `TRELLO_BOARD_ID` are set (the three team-password variables are
there from step 1). Leave `SQUARE_ACCESS_TOKEN` unset for now;
orders with Create Invoice on then say no draft was made. `.env.local.example` lists every
variable. Then merge `integration/final` into `main` and let Vercel deploy it.

**Check**, with the next real order rather than a test one (orders write to the real
Sales sheet and Trello):

- The Order Form lists customers and shows each batch with its cans left. Picking a
  custom-can customer picks their custom batch and their price, with no "Custom order?"
  prompt.
- After Submit, the result shows Sales sheet, Inventory and Trello as done.
- The new Sales row has `SB-<batch id>` in M, the order date in H if it was paid, and
  its formulas; the Total row's `SUM` reaches it.
- The Trello card is due at 9 AM on the delivery date picked and ends with `Order #<id>`.
- The Order History tab lists the order.
- The Inventory tab groups batches by product, shows the order's cans leaving its batch
  in that batch's history (by "Team"), and a count change asks for a note.
- `select * from inventory_ledger_check where difference <> 0;` returns no rows.
- After the first new business: its row on Current Locations Addresses gets a latitude
  and longitude within a few seconds (Census geocoder). Still run App Scripts in the
  sheet as the dialog says: it also updates the store-locator map.

**Undo:** Vercel → Deployments → the step 2 deployment → Promote to Production. That
version works on the new schema (its count changes are logged as adjustments). Orders
placed in between stay in `sales_orders`, the Sales sheet and Trello.

## 8. Square sandbox test

Run the app on your machine against Square's sandbox, so nothing reaches Paul's Square
account, the real Sales sheet or the delivery board:

1. Get a sandbox access token and location id (docs/integrations.md, "Getting a sandbox
   token and location id").
2. Make a copy of the Sales sheet (File → Make a copy) and share it with the service
   account's `client_email` as Editor. Make a Trello board for testing with one list.
3. In `.env.local`: `SQUARE_ENVIRONMENT=sandbox`, the sandbox `SQUARE_ACCESS_TOKEN` and
   `SQUARE_LOCATION_ID`, `GOOGLE_SHEET_ID` of the copy, and the test board's
   `TRELLO_BOARD_ID` and `TRELLO_LIST_ID`. Supabase stays the real project, so the test
   order takes real cans until you void it.
4. `npm run dev`, sign in with the `TEAM_PASSWORD` in your `.env.local`, and place one
   case for Sysco with Create Invoice on, PO `TEST-1` and a billing email.

**Check:** the result shows Square as done. Then
`curl -s https://connect.squareupsandbox.com/v2/invoices/<square_invoice_id> -H "Square-Version: 2026-09-16" -H "Authorization: Bearer $SQUARE_ACCESS_TOKEN"`
shows `"status": "DRAFT"`, the title `PO TEST-1`, Sysco's 65-day due date and the line.
Retrying from Order History leaves the done steps alone.

**Undo:** Order History → Void the test order (its cans go back and its card is
archived). Delete the sheet copy and the test board. Nothing in production to undo.

## 9. Square in production (after Paul's OK)

Make a production access token for this app (not one from another tool). In Vercel
Production set `SQUARE_ENVIRONMENT=production`, `SQUARE_ACCESS_TOKEN` and
`SQUARE_LOCATION_ID`, and redeploy.

**Check:** with the next real order that needs an invoice (a Sysco PO, say): the result
shows Square as done; the draft is in the Square Dashboard → Invoices with the right
customer, lines, PO and due date. Send it from Square. The app never sends invoices.

**Undo:** remove `SQUARE_ACCESS_TOKEN` from Vercel and redeploy. The invoice step is then
skipped with a note on each order. Delete any wrong draft in the Square Dashboard.
