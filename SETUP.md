# Partner sign-in: setup

The app now needs a signed-in partner. People sign in at `/login` with a link
sent to their email (and, optionally, with Google). Only emails on the partner
list get in. The check runs in three places:

- `src/proxy.ts` sends anyone who isn't a signed-in partner to `/login`.
- Every server action calls `requireUser()` first and returns
  `{ authError }` (shown in the app) instead of doing anything.
- Two database migrations limit inventory changes to signed-in partners.

## Do the steps in this order

| # | Step | When |
|---|------|------|
| 1 | Supabase Auth settings | any time |
| 2 | Email delivery | any time |
| 3 | Database step 1, then add the partner emails | **before** the deploy |
| 4 | Vercel env vars, then deploy | |
| 5 | Every partner signs in; test an inventory edit | after the deploy |
| 6 | Database step 2 | **only after** step 5 works |

Why this order: once partners sign in, the app talks to the database as a
signed-in user (the `authenticated` role) instead of anonymously. Database
step 1 gives signed-in partners access and changes nothing else, so it has to
be in place before the deploy. Database step 2 removes the older write
access, which the app version live today still uses, so it has to wait until
the new version is live.

Optional extras: a better email template (step 2b) and Google sign-in (step 2c).

## 1. Supabase Auth settings

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://portlandica.vercel.app`
- **Redirect URLs**, add:
  - `https://portlandica.vercel.app/auth/callback`
  - `http://localhost:3000/auth/callback` (local development)
  - Optional, to sign in on Vercel preview deployments:
    `https://portlandica-*-<your-vercel-scope>.vercel.app/**`

If a sign-in link sends people to the wrong site, the redirect URL is
missing from this list.

**Authentication → Sign In / Providers**:

- Leave **Email** enabled and **Confirm email** on (the defaults).
- **Allow new users to sign up:** leave it on until every partner has signed
  in once (their first link creates their account). After that you can turn
  it off; the app and the database check the partner list either way.

## 2. Email delivery: read this before testing

Supabase's built-in email sender only delivers to members of your Supabase
organization's team, and only 2 emails an hour for the whole project. Pick one:

- **Invite each partner to the organization** (Organization settings → Team),
  with the most limited role available. Fine for a few partners: they stay
  signed in on each device until they sign out, so links are rarely needed.
- **Set up custom SMTP** (Authentication → Emails → SMTP Settings) with a
  provider such as Resend or Postmark. This needs a domain you can add DNS
  records to.
- **Use Google sign-in only** (step 2c). It needs no email at all.

If the email never arrives, check this first.

### 2b. Optional: links that work in any browser

By default a sign-in link only works in the browser that asked for it. On a
phone, the Gmail app may open the link in its own browser, and the partner
sees "Open the sign-in link in the same browser you requested it from".

To make links work anywhere, edit **Authentication → Emails → Templates**,
both **Magic Link** and **Confirm signup** (a partner's first email uses
Confirm signup), and make the link:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">Sign in to Portlandica</a>
```

`/auth/callback` handles both kinds of link, so this can be changed at any time.

### 2c. Optional: Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client
   ID (type: Web application). Authorized redirect URI: the callback URL shown
   on Supabase's Google provider page
   (`https://<project-ref>.supabase.co/auth/v1/callback`). Set up the OAuth
   consent screen when asked; while it is in Testing mode, add the partners'
   Google addresses as test users.
2. Supabase → Authentication → Sign In / Providers → **Google**: enable it and
   paste the client ID and secret.
3. Set `ENABLE_GOOGLE_LOGIN=true` in Vercel (step 4).

Partners must pick the Google account whose email is on the partner list.
Anyone else is signed out straight away.

## 3. Database step 1 (before the deploy)

In Supabase → **SQL Editor**, run the whole file
`supabase/migrations/20261015120000_partner_access.sql`. Then add the partners,
in lower case, using the same list as `ALLOWED_EMAILS`:

```sql
insert into private.partner_emails (email) values
  ('partner-one@example.com'),
  ('partner-two@example.com');
```

The live site keeps working exactly as before. The emails go in this table
rather than in a migration so they stay out of this public repository.

This step also creates `public.is_partner()`, which the new inventory policy
and later migrations use. Supabase's Security Advisor will list it under warning 0029
("SECURITY DEFINER function callable by signed-in users"). That is expected:
it only tells a signed-in user whether their own email is on the list.
Signed-out callers can't run it.

The repo has no `supabase/config.toml`, so the SQL Editor is the simplest way
to run these files. Both are safe to run twice.

## 4. Vercel env vars, then deploy

Vercel → Project → Settings → **Environment Variables** (Production, Preview
and Development):

- `ALLOWED_EMAILS`: comma-separated partner emails. Same list as
  `private.partner_emails`. Server-only: no `NEXT_PUBLIC_` prefix.
- `ENABLE_GOOGLE_LOGIN`: `true` only if you did step 2c.
- Leave the Supabase, Google Sheets and Trello variables as they are.

Env var changes only apply to new deployments, so deploy after setting them.
For local work, copy `.env.local.example` to `.env.local`.

## 5. Check the deploy (before database step 2)

- Open the site in a private window: you should land on `/login`.
- Each partner requests a link, opens it, and sees the Inventory tab load.
- One partner edits an inventory count and then sets it back. This checks
  that a signed-in partner can read and write. Avoid test orders: they write
  to the Sales sheet and Trello.
- Optional: add an item named `TEST - delete me` and delete it (checks
  insert and delete).

## 6. Database step 2 (only after step 5 works)

1. Save the current policies, so you can restore them exactly if needed:
   ```sql
   select * from pg_policies
   where schemaname = 'public' and tablename in ('inventory', 'orders');
   ```
2. Run the whole file
   `supabase/migrations/20261015120100_tighten_database_permissions.sql`.
   It stops with an error, changing nothing, if step 1 isn't applied or the
   partner list is empty.
3. Run the check query at the bottom of that file.
4. In the app, edit a count and set it back again.
5. Check what the publishable key can do on its own (`URL` and `KEY` are
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`):
   ```bash
   # Still works (the monthly-close script reads inventory this way):
   curl -s "$URL/rest/v1/inventory?select=id&limit=1" -H "apikey: $KEY"
   # Now refused: "permission denied for table inventory".
   # id=-1 matches no row, so this changes nothing either way.
   curl -s -X PATCH "$URL/rest/v1/inventory?id=eq.-1" -H "apikey: $KEY" \
     -H "Content-Type: application/json" -d '{"count":0}'
   ```

**If you ever roll the app back** to a version from before sign-in, roll back
database step 2 as well (re-create the policies from the output saved in 6.1,
and `grant insert, update, delete on public.inventory to anon;`). Old versions
write without a signed-in user.

## Adding or removing a partner later

- **Add:** insert the email into `private.partner_emails`, add it to
  `ALLOWED_EMAILS` in Vercel, and redeploy. If sign-ups are off, also create
  the user under Authentication → Users.
- **Remove:** delete the row from `private.partner_emails` (the database
  stops accepting their changes at once), remove the email from
  `ALLOWED_EMAILS` and redeploy, and delete the user under Authentication →
  Users.

## Using the Supabase CLI later

Do this only after both database steps are done: the last command below marks
them as already run. These migrations expect the existing `inventory` and
`orders` tables, so the CLI needs a baseline of the live schema that sorts
before them. Run
`npx supabase login`, `npx supabase init` and
`npx supabase link --project-ref <project-ref>` first. `db pull` needs Docker
Desktop running, and an empty `supabase/migrations` folder:

```bash
mkdir -p supabase/migrations
mv supabase/migrations supabase/migrations.aside
mkdir supabase/migrations
npx supabase db pull
mv supabase/migrations/*_remote_schema.sql supabase/migrations.aside/20261015000000_remote_schema.sql
rmdir supabase/migrations
mv supabase/migrations.aside supabase/migrations
npx supabase migration repair --status applied 20261015000000
npx supabase migration repair --status applied 20261015120000 20261015120100
```

If `db pull` asks "Update remote migration history table?", answer **n**. The
last line marks these two files as already run (you ran them in the SQL
Editor). After that, a local `supabase db reset` rebuilds everything; step 2
skips its partner-list check when inventory is empty, as it is on a fresh
database.

## Notes for development

- Every server action in `src/app/actions/` must start with
  `const { failure } = await requireUser()` and `if (failure) return failure`.
  `src/app/actions/auth.test.ts` calls every exported action while signed out
  and fails if one gets past the check.
- The Supabase key is only used on the server. Importing
  `src/lib/supabase/client.ts` into a client component would put it in the
  browser bundle.
- The sign-in actions live in `src/app/login/actions.ts` (not
  `src/app/actions/`) because they have to work before anyone is signed in.
