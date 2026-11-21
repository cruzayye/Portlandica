# Inventory tab on the ledger

Branch `feat/inventory-ui` rebuilds the Inventory tab on the inventory ledger from
`feat/data-foundation` (see `docs/data-foundation.md`). Every change to a batch now goes
through one of the ledger's SQL functions, so it is recorded with who made it and why:

| In the tab   | SQL function                    | Notes                                                                                        |
| ------------ | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Add batch    | `record_fill`                   | Cases are converted to cans. A custom batch takes its customer's name.                       |
| Change count | `adjust_batch`                  | In cases or cans, with a required note. Refused if the count changed while you were editing. |
| Archive      | `archive_batch`                 | Replaces delete. Writes off what is left, so a reason is required unless the batch is at 0.  |
| Unarchive    | `unarchive_batch`               | Puts back the cans the archive wrote off.                                                    |
| History      | `inventory_movements` (read)    | Newest first.                                                                                |
| Banner       | `inventory_ledger_check` (read) | Shown only when a batch's count doesn't match its history.                                   |

The old direct-write actions in `src/app/actions/inventory.ts` (`createInventoryItem`,
`updateInventoryCount`, `deleteInventoryItem`, plus the unused `getInventory`) were deleted
when this branch and the order-flow branch were merged. Stock now changes only through the
ledger actions in `src/app/actions/batches.ts`.

## What partners see

- **The list**, grouped Still / Sparkling, house stock before custom cans. "Portlandica
  Dog water" is a batch name, listed with house still stock. Each batch shows cans, cases
  and pallets, its fill date and source. Custom batches show the customer they are
  linked to, or "No customer linked". Counts below zero are flagged in red.
- **A banner** at the top when house still or house sparkling stock is under 2,000 cans,
  when any batch is below zero, or when `inventory_ledger_check` reports a mismatch. The
  2,000 is `LOW_STOCK_THRESHOLD_CANS` in `src/components/Inventory/stock.ts`.
- **Tapping a batch** opens its details and history: date, change, what happened, the
  order (customer, date, voided), who, the note, and the count it left.
- **Archived batches** are hidden behind "Show archived". Nothing can be deleted.
- **Add batch**: house stock (named, "Portlandica" by default) or custom cans for a
  customer picked from the customers table; still or sparkling; cases, water source,
  fill date (today in Portland), and optionally cost, invoice number and a note.

- **At BLine**, under the banner: what BLine has left of each batch once every booked
  delivery is made, and, while some deliveries are still to come, how many cans are on its
  shelf today. A warning shows when a product drops under 240 cans there
  (`BLINE_LOW_STOCK_CANS` in `src/lib/bline.ts`) or goes below zero, and the latest change is
  listed. **Update** records cans **sent** to BLine or **brought back**, in cases or cans,
  dated today or earlier, or what BLine **counted** today: the difference from what should be
  on its shelf today (cans for deliveries after today are still there) is recorded as a count
  correction, with a note saying where the count came from. It is refused if an order changed
  the number while you were counting. Sending, bringing back and counting never change batch
  counts, since a batch counts its cans wherever they are; if cans were lost at BLine, change
  the batch's count too. A pallet is 60 cases (1,440 cans).
- **Deliveries**, at the bottom of At BLine: the BLine orders still to deliver, oldest
  first, each with where findelivers has it ("findelivers 261101.0008: Unassigned",
  "Failed attempt (Refused by recipient)") or "Not in findelivers yet". It warns when an
  import a day or more after an order was booked didn't find it (email BLine), when a
  delivery isn't going to plan, and when an order is past the delivery date it was booked
  for. Below: when findelivers was last imported, and for last month and this month how
  many orders BLine delivered and its fees for them, to check BLine's bill against.
  **Import findelivers** reads its Orders CSV (see "findelivers imports" below).

On phones the dialogs fill the screen (checked at 375 px wide).

### What BLine has

`bline_stock` (a view, `20261109000100_bline_delivery.sql`) works it out per batch:

- `moved`: the cans in `bline_stock_moves` (sent +, brought back -, count corrections ±).
- `booked`: cans on BLine orders that aren't void, and `pending`: those not delivered yet.
  An order is delivered once findelivers says so or someone marks it (`delivered_at`,
  `20261120000100_bline_tracking.sql`), whatever its delivery date; one findelivers has but
  hasn't delivered is not. An order nobody has tracked goes by its delivery date (or its
  order date if it has none): after today, not delivered yet. A delivery dated today counts
  as made.
- `remaining` = moved - booked: what BLine can still deliver. The order form uses it to
  offer a BLine order only the batches BLine has cans of, and the warnings use it.
- `on_hand` = remaining + pending: what should be on BLine's shelf today. A count is
  compared with it.

BLine orders aren't copied into the moves, so voiding one puts its cans back at BLine on its
own. `record_bline_move` (dated today or earlier) and `set_bline_count` (always today) are the
only ways to write the moves; `src/app/actions/bline.ts` calls them for the tab. Record a
count the day BLine makes it: a late one is measured against today's deliveries.

### findelivers imports

BLine runs its deliveries in findelivers.com (Finmile's software). Our login there only
views, but its Orders page downloads a CSV of our deliveries: BLine's number for each
("Shipper order ID", e.g. 261101.0007), status, when BLine entered it, recipient, address,
when it was delivered and why an attempt failed. Its times are Portland time.

**Import findelivers** (`BlineImportDialog`) reads that file on the server
(`src/lib/findelivers.ts`) and matches each row to a BLine order. BLine types our orders in
by hand, with its own spellings (a shop's short name, a branch's street), so a row matches on:

- the address: house number and street name, ignoring directions (NE, Northeast), street
  types (St, Ave), units (Suite A) and anything after them;
- the name: the share of the shorter name's words found in the other ("Juniper" in
  "Juniper Foods" counts fully);
- the dates: BLine entered the row from 3 days before the order's date to 14 days after.

Both the address and the name matching makes it sure; either one alone (or the street
without the number, as when BLine mistypes it) asks for a check. Each
order goes with one row at most, best match first, then the closest date, so a customer's
two orders in a week each get their own row. Once saved, a row is tied to its order by
BLine's number, and later imports use that. Pickups (BLine collecting our pallets) are left
out.

The dialog lists each row with the order picked for it, which can be changed or set to none.
Rows that add nothing to what an earlier import recorded are only listed. Orders not
delivered yet that no row matches show as "Not in this file". Saving reads the file again on
the server and records each row with `record_bline_tracking`: BLine's number, the status,
the delivery time and the reason an attempt failed. A delivery stays recorded when an older
file says otherwise. Each order found delivered for the first time gets its Trello card
checked off ("Mark complete"); if that fails, the result says to do it by hand. Importing the
same file twice is safe.

Order History shows the same for each BLine order, with **Mark delivered** (as of now, for
when findelivers is behind or the file isn't to hand; it checks off the Trello card) and
**Clear** (a wrong match or a mark made by mistake: the order counts as not delivered again,
its Trello card is unchecked, and the next import matches it again).

### Who made a change

With the team password there are no per-person accounts, so the tab shows **Team** for
every change made in the app and **System** for the rest (the opening balances, the SQL
Editor, the Supabase dashboard). The app's server writes as the service role, so its
changes carry no user id; `inventory_movements.made_in_app`
(`20261017000900_ledger_made_in_app.sql`) tells them apart: it is true when the change
came through the Data API.

## Code

- `src/app/actions/batches.ts`: the tab's server actions (`loadInventory`, `addBatch`,
  `changeBatchCount`, `archiveInventoryBatch`, `unarchiveInventoryBatch`,
  `getBatchHistory`). Each starts with the `requireUser()` check and returns
  `{ ok: false, error }` instead of throwing.
- `src/lib/db/orderSummaries.ts`: reads the customer, date and void status of the orders
  in a batch's history.
- `src/app/actions/blineTracking.ts`: BLine's deliveries (`loadBlineDeliveries`), the
  findelivers import (`readFindeliversFile`, `saveFindeliversFile`) and Order History's
  `markOrderDelivered` and `clearOrderDelivery`. `src/lib/db/blineTracking.ts` reads and
  writes the tracking columns; `src/lib/findelivers.ts` reads the CSV and matches rows.
- `src/components/Inventory/BlineDeliveries.tsx`, `BlineImportDialog.tsx` and
  `blineDeliveryRows.ts` (wording); `src/components/OrderHistory/BlineDelivery.tsx`.
- `src/components/Inventory/`: the tab. `Inventory.tsx` loads everything once;
  `BatchList`, `StockAlerts`, `BatchDialog` (details, history, `ChangeCountForm`,
  `ArchiveForm`) and `AddBatchDialog` do the rest. Pure helpers (`units.ts`, `stock.ts`,
  `validation.ts`, `history.ts`, `dates.ts`) are shared with the actions, which run the
  same checks again on the server.

## Before deploying

1. **Apply the data-foundation migrations first** (after the team-password rollout,
   `ROLLOUT.md` steps 1 to 3), following `docs/data-foundation.md`. This tab reads `customers`, `inventory_movements` and
   `inventory_ledger_check` and calls the ledger functions; without them it shows "Could
   not load the inventory."
2. **Seed the customers** (`scripts/seed-customers.ts`). Without them, house-stock fills
   still work but the custom-cans customer list is empty.
3. Until the order-flow branch lands, the current order form still offers archived
   batches (at 0 cans), because it reads `inventory` directly.

## Tests

- `src/app/actions/batches.test.ts`: the actions with the data modules mocked: what reaches
  the ledger functions, what is refused first, and how database errors read.
- `src/app/actions/batches.pglite.test.ts`: the same actions against the real migrations
  in PGlite: fills, a stale count, archive and unarchive, orders and voids in the history,
  a forced ledger mismatch, and a server key the database refuses. The server client
  runs as the service role, as the app's does.
- `src/components/Inventory/*.test.ts(x)`: the list, banner, archived toggle, batch
  dialog, count change, archive, add batch, sign-in messages, and the pure helpers.

## Not verified

- Nothing ran against the real Supabase project; nothing was applied there.
- No real phone: the layout was checked at 375 px in a browser, with stand-in data.
- The findelivers import was checked against a real Orders CSV (November 2026) and the live
  BLine orders on a laptop, outside the app: every delivery matched the right order. The
  dialog itself was only tested in jsdom.
