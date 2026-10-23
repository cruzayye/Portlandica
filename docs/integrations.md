# Integrations: Square draft invoices and address geocoding

Two server-side modules, wired into the order flow on `feat/order-flow` (see
`docs/order-flow.md`): the Square step runs after the sheet step for orders with Create
Invoice on, and new businesses are geocoded after the order is saved.

| Module               | What it does                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/square.ts`  | `createDraftInvoice()` makes a **draft** Square invoice for an order; `deleteDraftInvoice()` deletes one when its order is voided. Neither publishes or sends one. |
| `src/lib/invoiceDraft.ts` | `draftInvoiceFor()` writes an order's draft the way Paul writes his invoices: title, number series, message, 24 packs and reminders. No network.            |
| `src/lib/geocode.ts` | `geocodeAddress()` turns a US street address into latitude/longitude with the free US Census Geocoder.                                                             |

Both use plain `fetch` and add no packages. Call them only from server code (server
actions, route handlers). Don't put `'use server'` at the top of either file: that would
turn their exports into actions the browser can call directly.

## Environment variables

| Variable              | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `SQUARE_ACCESS_TOKEN` | Access token for the Square account. Use the sandbox token while testing.  |
| `SQUARE_LOCATION_ID`  | The Square location the orders and invoices belong to.                     |
| `SQUARE_ENVIRONMENT`  | `sandbox` or `production`. Anything else is an error, so it never guesses. |

The geocoder needs no variables. Add the Square ones to `.env.local` (and to Vercel once the
invoice step is wired in), never with a `NEXT_PUBLIC_` prefix, which would ship them to the
browser:

```
# Square draft invoices (src/lib/square.ts)
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=your-sandbox-access-token
SQUARE_LOCATION_ID=your-sandbox-location-id
```

`.env.local.example` has these lines. Give this app its own token rather than reusing one from another tool. A personal
access token can do everything on the account. With OAuth instead, the module needs
`CUSTOMERS_READ`, `CUSTOMERS_WRITE`, `ORDERS_READ`, `ORDERS_WRITE`, `INVOICES_READ`,
`INVOICES_WRITE` and `ITEMS_READ` (for the Item Library).

### Getting a sandbox token and location id

1. Sign in at <https://developer.squareup.com/apps> and open (or create) an application for
   this app.
2. Set the toggle at the top of the page to **Sandbox**. On **Credentials**, copy the
   **Sandbox Access token** into `SQUARE_ACCESS_TOKEN`.
3. Choose **Locations** in the left pane, pick **Sandbox**, and copy the location id into
   `SQUARE_LOCATION_ID`. Or ask the API:

   ```bash
   curl -s https://connect.squareupsandbox.com/v2/locations -H "Square-Version: 2026-09-16" -H "Authorization: Bearer $SQUARE_ACCESS_TOKEN"
   ```

4. Set `SQUARE_ENVIRONMENT=sandbox`.

The Sandbox Square Dashboard (Developer Console → **Sandbox test accounts** → **Square
Dashboard**) doesn't support Square Invoices and never sends email, so check sandbox drafts
through the API instead (`GET /v2/invoices/{id}`, or the API Explorer). The production token
and location id come from the same pages with the toggle on **Production**; set them in Vercel
only once Paul has signed off on real drafts.

## createDraftInvoice

```ts
import { createDraftInvoice } from '@/lib/square'
import { draftInvoiceFor } from '@/lib/invoiceDraft'

const draft = await createDraftInvoice({
  orderId: squareOrderRef(order), // see "Retries" below
  ...draftInvoiceFor(order, customer),
})
// { squareInvoiceId, squareOrderId, squareCustomerId, status: 'DRAFT', dueDate: '2026-11-14',
//   invoiceNumber: 'RoseCityCinema_078', unlinkedItems: [] }
```

It finds or creates the Square customer, creates a Square order at `SQUARE_LOCATION_ID` from
Item Library items, and creates the invoice on that order as a draft. Save `squareCustomerId`
on the customer and pass it next time; save `squareInvoiceId` on the order.

The order flow builds the input with `draftInvoiceFor` (`src/lib/invoiceDraft.ts`), which
writes the draft the way Paul makes invoices by hand from his Square template ("Portlandica
Invoice Template"). See "What a draft looks like" below. The fields:

| Field                       | Notes                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderId`                   | The app's id for the order, 40 characters at most. It becomes the Square order's `reference_id` and starts the idempotency keys. Never reuse one for a different order.                                                                                          |
| `orderDate`                 | The due date counts from this day in Pacific time. Defaults to now; pass the order's `created_at` so a retry on a later day gets the same due date. It is never before today at the Square location, though: Square refuses that, so a date that has passed becomes today. |
| `customer.name`             | Who the invoice is billed to. Saved as the company name of a Square customer it creates, and matched against the Item Library's discounts.                                                                                                                       |
| `customer.email`            | Optional. Square needs an email or phone on the customer before the invoice can be sent, and an email to send it by email.                                                                                                                                       |
| `customer.squareCustomerId` | The id returned last time. Skips the lookup.                                                                                                                                                                                                                      |
| `customer.paymentTermsDays` | `0` = due on receipt, `30` = Net 30. Due date = order date (Pacific) + this many days, or today in the Square location's time zone if that is later.                                                                                                           |
| `lines`                     | `item` (the Item Library name, e.g. `24 pack - Still`), `quantity` (whole), `amountCents` (what the customer pays for the line), `listPriceCents` (used only if the item isn't in the Item Library), `discountName`, and `discountAsAmount`. See below. |
| `title`                     | The invoice title, e.g. `Rose City Cinema` or `PO #40012345`.                                                                                                                                                                                                   |
| `message`                   | The invoice's message (Square's `description`).                                                                                                                                                                                                                  |
| `serviceDate`               | `YYYY-MM-DD`, shown as the service date.                                                                                                                                                                                                                         |
| `invoiceNumber`             | A string is used as is. `{ series }` carries on the Square customer's own series (below). Left out, Square numbers the invoice (`0000042`). Unique per location.                                                                                                 |
| `reminders`                 | Up to 5 of `{ days, message }`, days after the due date (0 = on it). Square emails them while the sent invoice is unpaid.                                                                                                                                       |
| `savePaymentMethod`         | Offers to save the customer's card or bank account on the payment page.                                                                                                                                                                                          |
| `deliveryMethod`            | `EMAIL` (the default when the Square customer has an email) or `SHARE_MANUALLY`, where Square sends nothing and you send the PDF or link yourself.                                                                                                              |

All input is checked before the first request, so bad input changes nothing in Square.
Failures throw: `SquareApiError` (with `status` and Square's `errors`) for Square's answers,
or a plain `Error` for bad input, missing env vars, a total Square works out differently, or
a network failure. Production builds of Next.js hide server error messages from the
browser, so log the error on the server and show the user something like "Order saved;
invoice draft failed".

### What a draft looks like

From an order of 9 cases of still and 6 of sparkling for Ironwood, ordered Oct 14 for
delivery Oct 16, `draftInvoiceFor` gives:

- **Title:** the customer's name in the app (with the store for a chain, e.g. `Pine Street
  Jewelers (Eastside)`), or `PO #<number>` when the order has a PO, as on Paul's Sysco
  invoices.
- **Invoice number:** the next in the Square customer's series, e.g. `IronwoodCoffeeCo_35`
  after `IronwoodCoffeeCo_34`. Stores that share a Square customer share the series.
- **Service date:** the order date.
- **Message:**

  ```
  Portlandica, order of 9 cases of Still and 6 cases of Sparkling (360 cans total) @ $1.50/can for a total of $540.

  Ordered: 10/14/2026
  Delivery by: 10/16/2026

  **** MAILING ADDRESS ****
  Portlandica
  P.O. Box 5374
  Portland, OR 97228
  *********
  ```

  Custom cans read `Custom Still` and `Custom Sparkling`; cans that aren't whole cases read
  `36 cans of Still`; a pickup reads `Pickup by:`. The price per can is left out when the
  lines differ in price or a typed total doesn't come to it. Order notes stay off the
  invoice (they are delivery instructions).
- **Lines:** `24 pack - Still`, `24 pack - Sparkling`, and `24 pack - Customized Portland
  Water Can` for custom cans of either kind, from the Item Library at its prices ($36, $36,
  $48). A customer's lower price is a discount (below).
- **Due date:** the customer's terms (30 days unless set), from the order date.
- **Reminders:** the template's five: on the due date, then 1, 2, 7 and 30 days late, in
  Paul's words.
- **Payment:** card and bank transfer (ACH), with "save payment method" on, as in the
  template.

Square's API can't add the additional recipients some of Paul's invoices copy to a second
address, so add those in the Dashboard when sending. To change any of this, edit
`src/lib/invoiceDraft.ts`; its tests show each case.

### Item Library lines and discounts

Each line names an Item Library item. `createDraftInvoice` looks the item up by name (case
and spacing aside) and bills its variation at the Item Library's price. An item that isn't
there is written out by name at `listPriceCents`, and its name comes back in
`unlinkedItems` (the order flow shows a warning): the invoice is still right, but Square's
item reports won't count that line. A line that costs more than the Item Library price is
billed at its own price per pack.

When a line costs less than the Item Library price times the quantity, a discount on the
line makes up the difference, the way Paul discounts by hand:

1. Lines discounted by a percentage share one discount. If the Item Library has a
   percentage discount whose name starts like the customer's (`Rose City Discount` for
   Rose City Cinema, `The Alder Discount` for The Alder Hotel) and whose percentage gives
   every line exactly its price, that discount is used. Otherwise a discount named
   `discountName` (`Taqueria Sol Discount`) with the shortest percentage that does.
2. Lines marked `discountAsAmount` (cans that don't fill the last pack), or lines no one
   percentage fits (a typed total), take an exact amount off: the Item Library's discount of
   that name and amount when there is one (`Half Case Order`, $18.00), otherwise one named
   `discountName`.

Before making anything, it asks Square to work the order out (`POST /v2/orders/calculate`).
If Square's total isn't the app's to the cent (a percentage rounded differently), every
discount becomes an exact amount; if the total is still off (a tax set up on an item, say),
it makes nothing and throws.

`src/lib/square.test.ts` covers cases like Paul's (with made-up customers): a 17.05%
custom-can discount, 10% on two lines, two hotels with 12.5% discounts, half cases and typed
totals.

### Invoice numbers

With `invoiceNumber: { series }`, it reads the Square customer's invoices at the location,
newest first. The newest numbered like `RoseCityCinema_077` sets the series and its zero
padding, and the number goes one past the highest in that series: `RoseCityCinema_078`.
Square's own numbers (`0000019`) don't count. A customer with no such invoice starts at
`<series>_01`, where `draftInvoiceFor` makes the series from the name (`Northgate Apartments` →
`NorthgateApartments`, `Salt & Pine` → `Salt&Pine`). If Square says a number is taken (by
an invoice made by hand in the meantime, or another customer's), it tries the next, up to
five numbers.

### How a draft becomes a sent invoice

1. `createDraftInvoice` leaves the invoice in `DRAFT`. Square sends nothing and the customer
   sees nothing.
2. Someone opens the Square Dashboard → **Invoices**, finds the draft, checks it, adds any
   additional recipients, and sends it. The invoice becomes `UNPAID` (or `SCHEDULED` if a
   send date is picked).
   - `EMAIL`: Square emails it to the customer's address.
   - `SHARE_MANUALLY`: Square sends nothing. Download the PDF or copy the link and send it
     through the customer's own channel (an accounts-payable inbox or vendor portal). Use one
     channel only; AP systems log a second copy as a duplicate invoice.
3. If the customer pays outside Square (ACH to the bank account, say), mark the invoice paid
   in the Dashboard so it doesn't stay open.

Sending through the API (`POST /v2/invoices/{id}/publish`, which needs the invoice's current
`version`) is deliberately left out; adding it needs Paul's OK. Deleting a draft in Square
cancels its order. Calling `createDraftInvoice` again for that order then makes a new order
and draft.

### Retries and duplicates

Calling `createDraftInvoice` again for the same order returns the existing draft instead of
making a second customer, order or invoice:

- Every write carries an idempotency key that starts with the order id
  (`portlandica-customer-…`, `portlandica-order-…`, `portlandica-invoice-…`). Order and
  invoice keys end in a hash of the request, so a repeated request gets the original result
  while a different one (the next invoice number, or an order made again after its draft was
  deleted) gets its own key.
- Square forgets idempotency keys after a while, so before creating anything it looks for what
  an earlier attempt made: the order by `reference_id` (one that isn't canceled), then the
  invoice on that order (Square allows one invoice per order).
- Network failures, timeouts (10 seconds per request), 429s and 5xx responses are retried, three
  attempts in all. Other errors throw straight away.
- A retry returns the existing invoice as it stands in Square, with its current status, even if
  the order's lines changed in between. Edit the draft in Square if they did.
- Because the order id is the key, an id reused for a different order would return the earlier
  order's invoice.

### Finding the Square customer

In order: the saved `squareCustomerId` (if Square says it's gone, after a merge or delete, it
carries on down this list); a customer this module created before, found by the reference id
`portlandica:<name>`; a customer with the same email **and** the same name (several customers
can share one billing inbox, so email alone isn't enough); otherwise a new customer with the
company name, email and reference id. Names match ignoring case and extra spaces. It never
edits a customer it finds, so if that customer has no email in Square, add it there.

## deleteDraftInvoice

```ts
import { deleteDraftInvoice } from '@/lib/square'

const result = await deleteDraftInvoice(order.square_invoice_id)
// { outcome: 'deleted' } | { outcome: 'not_draft', status: 'PAID' } | { outcome: 'not_found' }
```

Voiding an order calls it (`docs/order-flow.md`, "Voiding"). Square's `DeleteInvoice`
(`DELETE /v2/invoices/{id}?version=…`) deletes only drafts, at the version it is given, and
sets the invoice's Square order to `CANCELED`; deleted invoices are no longer returned by
`GET /v2/invoices/{id}`. So the module:

- reads the invoice first (`GET /v2/invoices/{id}`) and deletes only if its status is
  `DRAFT`, passing the `version` it just read;
- returns `not_draft` with Square's status (`UNPAID`, `SCHEDULED`, `PAID` and so on)
  without touching anything, so a person can cancel or refund it in Square;
- returns `not_found` when Square has no invoice with that id;
- when the delete fails, reads the invoice again: gone counts as deleted (a reply lost after
  Square deleted it), sent in the meantime counts as `not_draft`, and a draft that is still
  there throws, leaving it for a person.

It needs the same env vars and the `INVOICES_WRITE` and `ORDERS_WRITE` permissions as
`createDraftInvoice`.

## geocodeAddress

```ts
import { geocodeAddress } from '@/lib/geocode'

const point = await geocodeAddress('1005 W Burnside St, Portland, OR 97209')
// { latitude: 45.52302638429, longitude: -122.681258220226, matchedAddress: '1005 W BURNSIDE ST, PORTLAND, OR, 97209' }
```

- Asks `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` (benchmark
  `Public_AR_Current`). Free, no key, US addresses only.
- Returns `null` when Census has no match (a typo, a PO box, a brand-new building) or the
  address is blank.
- Throws on HTTP errors, unexpected replies and network failures, and after 5 seconds (pass
  `{ timeoutMs }` to change it). So `null` means "no such address" and a throw means "try again
  later".

This replaces the manual "run App Scripts" step after adding a new business: write
`latitude` and `longitude` into columns C and D of the new row in "Current Locations
Addresses". Run it after the order is saved (for example inside `after()` from `next/server`), so a slow or
unavailable geocoder can't hold up or fail an order, and leave the cells blank on `null` or an
error, as today. To check the geocoder by hand:

```bash
curl -s 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=1005+W+Burnside+St%2C+Portland%2C+OR+97209&benchmark=Public_AR_Current&format=json'
```

## Tests

`npm test` covers both modules with `fetch` mocked, so nothing goes over the network.
`src/lib/square.test.ts` runs against an in-memory fake of the Square endpoints
(`src/lib/testing/fakeSquare.ts`) that, like Square, replays repeated idempotency keys,
allows one invoice per order and one invoice number per location, keeps a version on every
invoice, deletes only drafts, and prices orders from its Item Library (whole quantities, a
line's percentage discount rounded to the cent, an amount discount once per line). That is
how the retry tests check nothing is created twice, how the discount tests check a draft's
total, and how the void tests (`src/app/actions/orderHistory.test.ts`) check only drafts are
deleted. `src/lib/invoiceDraft.test.ts` checks the wording, packs and numbering from orders
like Paul's. The same Square rules were checked against the Square sandbox on 2026-10-22
(34 custom packs at 17.05% off come to $1,353.74, as on Paul's own invoice for such an
order).
`src/lib/geocode.test.ts` uses a real Census reply for Powell's City of Books as its
fixture.

The Square API version is pinned in `square.ts` (`SQUARE_VERSION = '2026-09-16'`). Bump it on
purpose, after reading Square's changelog, and re-run the tests.
