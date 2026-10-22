# A.I.P Numbers in the app

The A.I.P Numbers tab shows Paul's owner dashboard: revenue, customers, reorder
predictions, top customers and collections. It used to be a separate site shown in a
frame with its own password. Now the app serves the page and fetches its numbers, so the
team password is the only one.

## How it works

- `public/aip/index.html` draws the dashboard (Chart.js from cdnjs). It contains no
  numbers. The tab loads it in a frame with `sandbox="allow-scripts"` and no
  `allow-same-origin`, so the page runs apart from the app: it can't use the team session,
  call the app's actions or read its storage.
- `src/components/AipNumbers` calls the `getAipNumbers` server action
  (`src/app/actions/aip.ts`) and posts the result into the frame. The page's Refresh Data
  button asks for the numbers again.
- `getAipNumbers` checks the team session like every action. Then `src/lib/aip.ts` fetches
  the dashboard JSON from Paul's Apps Script web app (`doGet` in his `DashboardAPI.js`),
  passing `APPS_SCRIPT_TOKEN` as the `token` parameter. Both settings stay on the server.
  The script only answers with data when the token matches its `DASHBOARD_TOKEN` script
  property.
- `src/proxy.ts` doesn't send `/aip/` to the sign-in page. The page has no data, and this
  way the sandboxed frame loads it the same way in every browser.
- If `APPS_SCRIPT_URL` or `APPS_SCRIPT_TOKEN` is missing, the page says A.I.P Numbers isn't
  connected. The standalone dashboard was retired on 2026-10-21, and its old address now
  forwards to this app.

## Setting it up

1. Paul sets the `DASHBOARD_TOKEN` script property in the Apps Script project, deploys the
   `DashboardAPI.js` that checks it as a new web app deployment (Execute as: Me, Who has
   access: Anyone) and sends the deployment's `/exec` URL and the token to whoever manages
   Vercel.
2. In Vercel (Production and Preview) set `APPS_SCRIPT_URL` and `APPS_SCRIPT_TOKEN`, then
   redeploy.
3. Check: sign in and open A.I.P Numbers. The header says "Last refreshed" with the current
   time, and the charts are drawn. Refresh Data loads them again.

If the tab says the token doesn't match, `APPS_SCRIPT_TOKEN` and the `DASHBOARD_TOKEN`
script property differ; set them to the same value. A slow spreadsheet (over 60 seconds)
shows "took too long", and Refresh Data tries again.

## Changing the dashboard page

Edit `public/aip/index.html`. Its numbers arrive only as `message` events from the app:

| Message | Meaning |
| --- | --- |
| `{ type: 'aip:loading' }` | The app is fetching; show the spinner. |
| `{ type: 'aip:data', json }` | The dashboard JSON as Apps Script sent it, as a string. |
| `{ type: 'aip:error', message }` | Show the message in the header. |

The page sends only `{ type: 'aip:refresh' }`. Because its origin is opaque, it can't use
`localStorage`, `sessionStorage` or cookies, and it can't open pop-ups.

### Numbers the page reads (since 2026-10-19)

Apps Script now sends `summary.growth`, `summary.ytd`, `summary.activeCustomers`, `forecast[].low`,
`expected`, `high`, `topByYear`, `topAllTime`, `collections.agingByDue` and `collections.terms`. Each
prediction also has `tooNew`, `regularityScore`, and the statuses `Past Due` and `Lapsed`. The page
still works with an Apps Script from before then: it falls back to the older fields, shows "Needs
the updated Apps Script" where a number is missing, and works out Lapsed and Past Due itself.

To try it locally, run the app with `npm run dev`, point `APPS_SCRIPT_URL` at the Apps
Script deployment (or any server that answers like it), and open the tab after signing in.
