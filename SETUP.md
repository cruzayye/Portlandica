# Team password: setup

The app sits behind one shared team password. Anyone who opens the site lands on `/login`,
types the team password, and that device stays signed in for 90 days, until someone
signs out on it, or until the password changes. There are no accounts, no emails and no
per-person sign-in.

The check runs in two places:

- `src/proxy.ts` sends any page request without a valid session cookie to `/login`.
- Every server action calls `requireUser()` first and returns `{ authError }` (shown in
  the app) instead of doing anything.

The session cookie, `portlandica_session`, is HttpOnly, Secure, SameSite=Lax and lasts 90
days. It holds when it was made, when it expires and a fingerprint of the password it
was made with, signed with `SESSION_SECRET`. It never holds the password.

The app's server talks to Supabase with the secret key. The browser never talks to
Supabase. Database step 2 then takes away the publishable key's write access.

## Do the steps in this order

| #   | Step                                     | When               |
| --- | ---------------------------------------- | ------------------ |
| 1   | Vercel env vars                          | before the deploy  |
| 2   | Deploy, then sign in once on each device |                    |
| 3   | Database step 1                          | after step 2 works |
| 4   | Database step 2 (lock the database)      | right after step 3 |

Why this order: the version of the app live before this one writes to inventory with the
publishable key. Database step 2 removes exactly that, so it has to wait until the
team-password version is live. That version writes with the secret key, which step 2
doesn't affect. Step 1 changes nothing either version uses; it adds what the later data
migrations need, and step 2 checks it's there.

## 1. Vercel env vars

Vercel → Project → Settings → **Environment Variables**. Add these three for
**Production, Preview and Development**. All three are server-only: never give them a
`NEXT_PUBLIC_` prefix.

| Variable              | Value                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY` | Supabase → **Project Settings → API Keys → Secret keys**. Copy the secret key, or create one just for this app so it can be replaced on its own. It bypasses every database rule. |
| `TEAM_PASSWORD`       | The password the team will type. At least 12 characters; a passphrase of 4 or 5 unrelated words is easy to type on a phone and hard to guess.                                     |
| `SESSION_SECRET`      | At least 32 random characters. Nobody types it. Make one with `openssl rand -hex 32`.                                                                                             |

- Keep `NEXT_PUBLIC_SUPABASE_URL` and the Google Sheets and Trello variables as they are.
- The app no longer reads `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ALLOWED_EMAILS` or
  `ENABLE_GOOGLE_LOGIN`. Remove them from Vercel if they're there. (Keep the publishable
  key itself: Paul's monthly-close script uses it.)
- Share the team password the way you share other passwords. Never put it, the secret
  key or the session secret in this repository: it is public.
- Env var changes only apply to new deployments, so deploy after setting them.

For local work, copy `.env.local.example` to `.env.local` and fill in the same three.

If `TEAM_PASSWORD` or `SESSION_SECRET` is missing or too short, nobody can sign in:
`/login` says "Sign-in is not set up on this site yet", and the server log (Vercel →
Logs) says which variable is wrong, never its value.

## 2. Deploy, then sign in once on each device

Merge and let Vercel deploy. Then:

- Open the site in a private window: you should land on `/login`, with one password
  field.
- A wrong password says "That is not the team password" after a short pause.
- The right password opens the app. Each person signs in once on each phone and computer.
  The browser may offer to save the password.
- Edit one inventory count and set it back. This checks the secret key: the app now
  reads and writes as the service role. Avoid test orders: they write to the Sales sheet
  and Trello.
- If the app opens but can't load the inventory, check `SUPABASE_SECRET_KEY` (the log
  says "SUPABASE_SECRET_KEY is not set" when it's missing).

Preview deployments work the same way. The cookie belongs to one address, so sign in
once on each preview URL.

## 3. Database step 1

In Supabase → **SQL Editor**, run the whole file
`supabase/migrations/20261015120000_partner_access.sql`.

It adds `private.partner_emails`, `public.is_partner()` and the "Partners can manage
inventory" policy. They stay dormant: nobody signs in through Supabase Auth, so leave
`private.partner_emails` empty and the policy lets nobody in. The data-foundation
migrations and their functions call `public.is_partner()`, so step 1 has to exist.

Supabase's Security Advisor will list `is_partner()` under warning 0029 ("SECURITY
DEFINER function callable by signed-in users"). That is expected: it only tells a
signed-in user whether their own email is on the (empty) list. Signed-out callers can't
run it.

The repo has no `supabase/config.toml`, so the SQL Editor is the simplest way to run
both database steps. Both are safe to run twice.

## 4. Database step 2: lock the database

1. Save the current policies, so you can restore them exactly if needed:
   ```sql
   select * from pg_policies
   where schemaname = 'public' and tablename in ('inventory', 'orders');
   ```
2. Run the whole file
   `supabase/migrations/20261015120100_tighten_database_permissions.sql`.
   It stops with an error, changing nothing, if step 1 isn't applied.
3. Run the check query at the bottom of that file.
4. In the app, edit a count and set it back again.
5. Check what the publishable key can do on its own (`URL` is
   `NEXT_PUBLIC_SUPABASE_URL`; `KEY` is the publishable key from Supabase → Project
   Settings → API Keys):
   ```bash
   # Still works (the monthly-close script reads inventory this way):
   curl -s "$URL/rest/v1/inventory?select=id&limit=1" -H "apikey: $KEY"
   # Now refused: "permission denied for table inventory".
   # id=-1 matches no row, so this changes nothing either way.
   curl -s -X PATCH "$URL/rest/v1/inventory?id=eq.-1" -H "apikey: $KEY" \
     -H "Content-Type: application/json" -d '{"count":0}'
   ```

**If you ever roll the app back** to a version from before the team password, roll back
database step 2 as well (re-create the policies from the output saved in 4.1, and
`grant insert, update, delete on public.inventory to anon;`). Old versions write with the
publishable key.

Optional: nobody signs in through Supabase Auth any more, so you can turn off
**Authentication → Sign In / Providers → Allow new users to sign up**. Nothing depends on
it either way: with an empty partner list, a Supabase Auth user can't read or change
anything.

## Changing the password

Set a new `TEAM_PASSWORD` in Vercel (all three environments) and redeploy. Every device
is signed out at once, because each session carries a fingerprint of the password it was
made with, and everyone signs in again with the new one. Do this when someone leaves,
when a signed-in phone or laptop is lost, or when the password has been shared more
widely than you'd like.

- Changing `SESSION_SECRET` also signs every device out, without changing the password.
- To replace the Supabase secret key: create a new secret key, put it in
  `SUPABASE_SECRET_KEY`, redeploy, then delete the old key in Supabase. Nobody is signed
  out.
- **Sign out** at the bottom of the app signs out that device only.

## Using the Supabase CLI later

Do this only after both database steps are done: the last command below marks them as
already run. These migrations expect the existing `inventory` and `orders` tables, so the
CLI needs a baseline of the live schema that sorts before them. Run `npx supabase login`,
`npx supabase init` and `npx supabase link --project-ref <project-ref>` first. `db pull`
needs Docker Desktop running, and an empty `supabase/migrations` folder:

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

If `db pull` asks "Update remote migration history table?", answer **n**. The last line
marks the two database steps as already run (you ran them in the SQL Editor). After that,
a local `supabase db reset` rebuilds everything.

## Notes for development

- Every server action in `src/app/actions/` must start with
  `const { failure } = await requireUser()` and `if (failure) return failure`.
  `src/app/actions/auth.test.ts` calls every exported action with no cookie and with
  forged, expired, edited and old-password cookies, and fails if one gets past the check.
  The server uses the secret key, so this check is what keeps the database closed to
  everyone else.
- The secret key is only used on the server (`src/lib/supabase/server.ts`). There is no
  browser Supabase client; keep it that way. To check a build:
  `npm run build && grep -rlE "SUPABASE_SECRET_KEY|TEAM_PASSWORD|SESSION_SECRET" .next/static`
  should print nothing.
- The sign-in actions live in `src/app/login/actions.ts` (not `src/app/actions/`) because
  `signIn` has to work before anyone is signed in.
- `npm run dev` serves `http://localhost:3000`; only there does the cookie drop its
  Secure flag.
