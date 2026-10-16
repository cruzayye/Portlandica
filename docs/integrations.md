# Integrations: Square draft invoices and address geocoding

Two server-side modules. Neither is wired into the order flow yet.

| Module               | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/lib/square.ts`  | `createDraftInvoice()` makes a **draft** Square invoice for an order. It never publishes or sends one. |
| `src/lib/geocode.ts` | `geocodeAddress()` turns a US street address into latitude/longitude with the free US Census Geocoder. |

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

`.env.local.example` isn't changed on this branch; add these lines to it when the invoice step
is wired in. Give this app its own token rather than reusing one from another tool. A personal
access token can do everything on the account. With OAuth instead, the module needs
`CUSTOMERS_READ`, `CUSTOMERS_WRITE`, `ORDERS_READ`, `ORDERS_WRITE`, `INVOICES_READ` and
`INVOICES_WRITE`.

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

const draft = await createDraftInvoice({
  orderId: order.id, // the order's database id; see "Retries" below
  orderDate: new Date(order.created_at),
  customer: {
    name: 'Example Foods Northwest, Inc.',
    email: billingEmail,
    squareCustomerId: customer.square_customer_id, // null the first time
    paymentTermsDays: 30,
  },
  lines: [
    { name: 'Still Cans', cans: 240, unitPrice: 1.5 },
    { name: 'Sparkling Cans', cans: 48, unitPrice: 1.5 },
  ],
  poNumber: '40012345',
})
// { squareInvoiceId, squareOrderId, squareCustomerId, status: 'DRAFT', dueDate: '2026-11-14', invoiceNumber: '0000042' }
```

It finds or creates the Square customer, creates a Square order at `SQUARE_LOCATION_ID`, and
creates the invoice on that order as a draft. Save `squareCustomerId` on the customer and pass
it next time; save `squareInvoiceId` and `status` on the order.

| Field                       | Notes                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderId`                   | The app's id for the order, 40 characters at most. It becomes the Square order's `reference_id` and the idempotency keys. Never reuse one for a different order.           |
| `orderDate`                 | The due date counts from this day in Pacific time. Defaults to now; pass the order's `created_at` so a retry on a later day gets the same due date.                        |
| `customer.name`             | Who the invoice is billed to, exactly as it should read (e.g. a distributor's legal name). Saved as the Square customer's company name.                                    |
| `customer.email`            | Optional. Square needs an email or phone on the customer before the invoice can be sent, and an email to send it by email.                                                 |
| `customer.squareCustomerId` | The id returned last time. Skips the lookup.                                                                                                                               |
| `customer.paymentTermsDays` | `0` = due on receipt, `30` = Net 30. Due date = order date (Pacific) + this many days.                                                                                     |
| `lines`                     | `name`, `cans`, `unitPrice` (dollars per can). Optional `caseSize` bills by the case: 1,440 cans at $1.50 with `caseSize: 24` becomes 60 × $36.00, to match a PO in cases. |
| `poNumber`                  | Becomes the invoice title (`PO 40012345`) and the first line of the description.                                                                                           |
| `note`                      | Added to the description.                                                                                                                                                  |
| `remitTo`                   | Added to the description as `Remit to: …`. Square's custom invoice fields need the paid Invoices Plus plan, so this uses the description instead.                          |
| `invoiceNumber`             | Optional, unique per location, e.g. a per-customer series. Square numbers the invoice (`0000042`) when it's left out.                                                      |
| `deliveryMethod`            | `EMAIL` (the default when the Square customer has an email) or `SHARE_MANUALLY`, where Square sends nothing and you send the PDF or link yourself.                         |

Prices must be whole cents per billed unit. It throws rather than round, because rounding
would change what the customer is billed. If an agreed total doesn't divide into a whole-cent
price per can (say $500 for 300 cans), bill it as one lot with `caseSize` equal to `cans`:
`{ name: 'Still Cans (300)', cans: 300, unitPrice: 500 / 300, caseSize: 300 }` gives one line
of 1 × $500.00.

All input is checked before the first request, so bad input changes nothing in Square.
Failures throw: `SquareApiError` (with `status` and Square's `errors`) for Square's answers,
or a plain `Error` for bad input, missing env vars or a network failure. Production builds of
Next.js hide server error messages from the browser, so log the error on the server and show
the user something like "Order saved; invoice draft failed".

### Distributor POs

Built for distributors that pay against purchase orders, such as Sysco, which wants one
invoice per PO billed to its legal entity name, with the PO number, a remit-to address and Net
terms. That's `customer.name`, `poNumber`, `remitTo` and `paymentTermsDays`. Name the line the
way the PO does, and use `caseSize` if the PO counts cases.

### How a draft becomes a sent invoice

1. `createDraftInvoice` leaves the invoice in `DRAFT`. Square sends nothing and the customer
   sees nothing.
2. Someone opens the Square Dashboard → **Invoices**, finds the draft, checks the lines, PO,
   due date and customer, and sends it. The invoice becomes `UNPAID` (or `SCHEDULED` if a send
   date is picked).
   - `EMAIL`: Square emails it to the customer's address.
   - `SHARE_MANUALLY`: Square sends nothing. Download the PDF or copy the link and send it
     through the customer's own channel (an accounts-payable inbox or vendor portal). Use one
     channel only; AP systems log a second copy as a duplicate invoice.
3. If the customer pays outside Square (ACH to the bank account, say), mark the invoice paid
   in the Dashboard so it doesn't stay open.

Sending through the API (`POST /v2/invoices/{id}/publish`, which needs the invoice's current
`version`) is deliberately left out; adding it needs Paul's OK. Older Square forum posts say
API-made drafts didn't appear in the Invoices mobile app, so look in the web Dashboard and
confirm with the first real draft. Deleting a draft in Square cancels its order; to replace
it, make the new invoice in the Dashboard.

### Retries and duplicates

Calling `createDraftInvoice` again for the same order returns the existing draft instead of
making a second customer, order or invoice:

- Every write carries an idempotency key built from the order id
  (`portlandica-customer-…`, `portlandica-order-…`, `portlandica-invoice-…`). Square answers a
  repeated key with the original result.
- Square forgets idempotency keys after a while, so before creating anything it looks for what
  an earlier attempt made: the order by `reference_id`, then the invoice on that order (Square
  allows one invoice per order).
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
`src/lib/square.test.ts` runs against an in-memory fake of the Square endpoints that, like
Square, replays repeated idempotency keys and allows one invoice per order. That is how the
retry tests check nothing is created twice. `src/lib/geocode.test.ts` uses a real Census reply
for Powell's City of Books as its fixture.

The Square API version is pinned in `square.ts` (`SQUARE_VERSION = '2026-09-16'`). Bump it on
purpose, after reading Square's changelog, and re-run the tests.
