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

On phones the dialogs fill the screen (checked at 375 px wide).

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
