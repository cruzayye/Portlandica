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
| Square      | Only with Create Invoice on and `SQUARE_ACCESS_TOKEN` set: a **draft** invoice. Never published or sent. | `square_invoice_id` |

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

Same columns, formulas and tab names as before. Two columns now get filled:

- **M (Inventory Reference #)**: `SB-<batch id>`, the Supabase batch the row's cans came
  from. Column N looks M up on the sheet's own Inventory tab, which has no `SB-` rows, so
  N stays 0 as it is today.
- **H (Payment Date)**: the order date when Paid is on.

Dates and amounts are written as numbers and text is written as text, so nothing typed
into the form can turn into a formula. Donations rows keep `A7`/`A8` in their Inventory
Reference # so their cost lookup keeps working.

## Customers and prices

- On load, names on Current Locations Addresses that aren't in `customers` are added
  (address parsed, coordinates if the tab has them). Rows already in `customers` are
  never changed. The tab stays the list of locations.
- The form offers house stock plus custom batches linked to the customer by
  `customer_id`. A custom batch with no `customer_id` is offered to nobody; link it first.
  A line is custom when its batch is.
- Price per can: the customer's `price_per_can` when the order uses their custom cans (or
  always, for a customer whose price isn't tied to custom cans: `custom_cans` false);
  otherwise $1.50. A typed price still wins and is spread over every can.
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
- `src/lib/google/sheets.ts`, `src/lib/trello.ts`, `src/lib/square.ts`, `src/lib/geocode.ts`.
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
