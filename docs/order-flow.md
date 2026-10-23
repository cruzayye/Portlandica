# How an order flows

Branch `feat/order-flow` wires the database foundation (`docs/data-foundation.md`) and the
Square and geocoding modules (`docs/integrations.md`) into the order form. How to get it
live, step by step: `ROLLOUT.md`.

## Submitting an order

The form makes one **order key** per order (a UUID). `createOrder` (src/app/actions/orders.ts):

1. Checks the order is complete (`orderProblem`). Nothing is written if it isn't.
2. Looks for an order already saved under this key. If there is one, this is a retry of
   the same order: it finishes that order's unfinished steps instead of booking a second
   one. If the form's details changed since, it refuses (`already_saved`) and the form
   moves to a new key.
3. Unless the partner chose "Submit Anyway", checks for another order for this customer
   today, in the database and in the Sales sheet (orders typed straight into the sheet
   count too). "Submit Anyway" books a second order under a new key.
4. Checks each batch has enough cans. If not, the form asks; "Book Anyway" sends the
   same key with `allowOversell`.
5. Finds the customer, or adds a new business to `customers`.
6. Saves the order and its lines (`create_sales_order`).
7. Runs the steps, in order, each recorded on the order (`src/lib/orderSteps.ts`):

| Step        | Does                                                                                                     | Recorded as         |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| Sales sheet | Sales rows (Donations rows for a donation); a new business also goes on Current Locations Addresses.     | `sheet_ref`         |
| Inventory   | `apply_order_inventory`: takes the cans out of the batches and writes the ledger.                        | `inventory_status`  |
| Trello      | The delivery card, due 9 AM Pacific on the delivery date picked in the form.                             | `trello_card_id`    |
| Square      | Only with Create Invoice on and `SQUARE_ACCESS_TOKEN` set, and never for a customer invoiced outside Square: a **draft** invoice. Never published or sent. | `square_invoice_id` |

A failed step doesn't stop the next one. The form shows how each step went, with a
Retry button for any that failed; the same is on the Order History tab. A retry runs
only the steps that aren't done.

8. For a new business, after the response has gone out (`after()`), the US Census
   geocoder looks up its address and writes the latitude and longitude to the customer
   and to columns C and D of its Current Locations Addresses row. No match or an error
   leaves them blank, as before.

## What each step guards against

- **Sales sheet.** The new rows, their values and an invisible developer-metadata tag
  with the order key go in as one Sheets update, so two orders saved at the same moment
  can't land on each other's rows. A retry finds the tagged rows and rewrites them
  instead of adding a second copy. The tag is removed once the step is recorded. The
  Total row's `SUM` is moved down only if the row under the last order says `Total`.
- **Inventory.** The SQL function takes each line's cans once, however often it's called.
- **Trello.** Each card ends with the line `Order #<id>`. A retry first looks for an open
  card with that line, so a card made by an attempt that didn't get recorded isn't made
  twice.
- **Square.** The Square order's reference is `<order id>-<first 8 characters of the key>`,
  and the module reuses an existing draft for the same reference. A void deletes the
  draft only after reading it again from Square, and only while it is still a draft.

## The Sales sheet rows

Same columns, formulas and tab names as before, one row per product (still and
sparkling are separate rows). One column now gets filled, and one is worked out
differently:

- **F (Sales ($))**: the row's own line amount (see "Customers and prices"), so in a mixed
  order the custom-can row and the house-stock row each show what they cost. I (Payment
  Received) is the same amount when Paid is on, 0 otherwise.
- **M (Inventory Reference #)**: `SB-<batch id>`, the Supabase batch the row's cans came
  from. Column N looks M up on the sheet's own Inventory tab, which has no `SB-` rows, so
  N stays 0 as it is today.

**H (Payment Date)** stays blank, as before, even with Paid on: some customers are on
autopay, which pays about 30 days later, so the date goes in when the money arrives.

Dates and amounts are written as numbers and text is written as text, so nothing typed
into the form can turn into a formula. Donations rows keep `A7`/`A8` in their Inventory
Reference # so their cost lookup keeps working.

## Customers and prices

- On load, names on Current Locations Addresses that aren't in `customers` are added
  (address parsed, coordinates if the tab has them). Rows already in `customers` are
  never changed. The tab stays the list of locations.
- The form offers house stock plus custom batches linked to the customer by
  `customer_id`. A custom batch with no `customer_id` is offered to nobody; link it first.
  A line is custom when its batch is. Still or sparkling comes from the batch's
  `"isStill"`; "Portlandica Dog water" is house still stock, offered and sold like any
  other.
- Each line has its own price per can (`linePrices` in `src/lib/orders.ts`), so an order
  that mixes a customer's custom cans with house stock is priced line by line. A line
  from their custom batch is at their `price_per_can`. A house-stock line is at their
  `price_per_can` only if they aren't a custom-can account (`custom_cans` false; Ben
  Bridge's $1.35 is for regular cans), otherwise at $1.50. No agreed price means $1.50.
  Under the Price, the form shows each line, e.g. "Still: 240 cans at $2.00 (Hotel
  Vintage's price) · Sparkling: 48 cans at $1.50".
- A typed price still wins. It replaces the total and is spread over the lines in
  proportion to their automatic prices: every line's price per can is scaled by the same
  factor, so custom cans stay dearer than house stock. With one price on every line, that
  is an even spread over every can, as before. The form shows the split, e.g. "Typed
  price, split in proportion to each line's automatic price: Still $434.78 · Sparkling
  $65.22 (automatic: $552.00)". The order keeps the typed total exactly.
- The Sales rows and the Square draft use the same line amounts (`lineAmounts`): each
  line's total, moved by a cent where a typed total needs it to add up. The draft is made
  the way Paul makes invoices by hand (`src/lib/invoiceDraft.ts`; `docs/integrations.md`,
  "What a draft looks like"): the business (or `PO #…`) as the title, the next number in
  the customer's series, the order date as the service date, his message with the cases,
  price, total, order and delivery dates and the mailing address, and 24 packs from the
  Square Item Library less the customer's discount, so it comes to the order's total to the
  cent. A line the Item Library doesn't have is still billed, with a warning.
- Square terms: the customer's `payment_terms_days` (Sysco is 65); otherwise Net 30 for a
  business, and due on receipt for an individual (DTC customers usually pay on the
  website when they order). An individual booked from the form has no customer row, so
  the order's type decides.
- Customers invoiced outside Square (`customers.invoiced_outside_square`, on for the Market of
  Choice stores, which are billed through their own spreadsheet) never get a Square draft. With
  Create Invoice on, the order still marks its Sales row, the result says the customer is invoiced
  outside Square, and Order History shows "Invoiced outside Square; no draft made". To change it,
  run `update customers set invoiced_outside_square = true where name_key = '<name, lower case>';`
  in the SQL Editor.
- A billing email typed with Create Invoice on is saved on the customer; a Square
  customer id is saved after the first draft.

## Voiding

Order History → Void asks why, then `void_order` puts the cans back and the Trello card
is archived. If the order has a Square invoice:

- **Still a draft:** the app deletes it (`deleteDraftInvoice` in `src/lib/square.ts`
  reads the invoice for its current version and deletes that version; Square then
  cancels the draft's Square order). The deletion is recorded on the order: its Square
  step becomes `skipped`, and `square_invoice_id` keeps the deleted draft's id. Order
  History shows "Its draft invoice was deleted in Square."
- **Already sent, scheduled, paid or anything else:** left alone. The result says what
  it is and to cancel or refund it in Square by hand.
- **No `SQUARE_ACCESS_TOKEN`:** nothing is checked; the result says Square isn't set up
  here and to delete, cancel or refund the invoice in the Square Dashboard by hand.
- **Square refuses the delete, or has no invoice with that id:** nothing is recorded and
  the result says what to check in the Square Dashboard.

The app doesn't edit Sales rows: the result lists the rows to fix by hand.

## Code

- `src/app/actions/orders.ts`: `getOrderFormData`, `createOrder`.
- `src/app/actions/orderHistory.ts`: `listOrders`, `retryOrder`, `voidOrder`.
- `src/lib/orderSteps.ts`: the step runner. `src/lib/customerSync.ts`: customers from the
  locations tab, geocoding.
- `src/lib/google/sheets.ts`, `src/lib/trello.ts`, `src/lib/square.ts` (with
  `src/lib/invoiceDraft.ts` for what the draft says), `src/lib/geocode.ts`.
- `supabase/migrations/20261017000700_order_flow.sql`: four columns on `sales_orders`
  (`delivery_address`, `customer_email`, `sheet_ref`, `new_customer`) so any step can run
  again from the order alone, and a `record_order_step` that lets a void order's Square
  step go from done to skipped once its draft is deleted. Undo:
  `supabase/rollback/20261017000700_order_flow.sql`.

## Tests

`npm test` runs the actions and the step runner against the real migrations in PGlite,
with Sheets, Trello, Square and the geocoder mocked. They reach the database as the service
role, as the app's server does with the secret key, with nobody on the partner list. The
void tests run the real Square module against `src/lib/testing/fakeSquare.ts`, an
in-memory Square that keeps invoice versions and deletes only drafts. Sign-in (the team
password) is covered by `src/app/actions/auth.test.ts` and
`src/app/login/actions.test.ts`. `src/lib/google/testing/fakeSheets.ts`
is an in-memory Sheets that applies inserts, writes and tags for real, so the sheet tests
check the rows as they end up, retries and two orders written at once.
