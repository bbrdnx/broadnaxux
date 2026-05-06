# Deployment Runbook — Phase 0

This walks you through deploying the two Workers. Time estimate: 30–45 minutes the first time, mostly waiting for installs.

**Where you are:** this `cloudflare/` folder lives inside your `PortfolioSite` repo. Commands below assume you're in `~/GitHub/PortfolioSite/cloudflare/` unless noted.

---

## Pre-flight: install Node 20+ if you don't have it

```bash
node --version  # should print v20 or higher
```

If you don't have Node, install via [nvm](https://github.com/nvm-sh/nvm) or [the official installer](https://nodejs.org/).

---

## Step 1 — Install wrangler in each Worker project (5 min)

```bash
cd ~/GitHub/PortfolioSite/cloudflare

(cd workers/public && npm install)
(cd workers/admin  && npm install)
```

This installs `wrangler` (Cloudflare's CLI) and the Workers types in each project. The `(cd … && …)` form runs each install in a subshell so you stay at the `cloudflare/` root.

## Step 2 — Sign in to Cloudflare (1 min)

```bash
cd workers/public
npx wrangler login
```

Browser opens, you approve, terminal confirms. You only need to do this once — the credentials are shared across both Worker projects.

Verify with:
```bash
npx wrangler whoami
```

You should see `Broadnaxux@gmail.com` and the account ID `274658631482a2b03f8eb12bb94f27dc`.

```bash
cd ../..
```

## Step 3 — Stage the static portfolio assets (10 sec)

Because `cloudflare/` lives inside the same repo as your portfolio, an npm script handles this automatically. From `cloudflare/workers/public/`:

```bash
cd workers/public
npm run prepare-assets
cd ../..
```

That copies `index.html`, all 7 case study pages, `resume.html`, `prototype-layout.html`, `styles.css`, `favicon.svg`, `barbara-broadnax-resume.pdf`, and the entire `images/` folder from the repo root into `workers/public/public/`. (You can re-run this any time you change the static site.)

Bonus: `npm run deploy` and `npm run dev` automatically run `prepare-assets` first via a `predeploy`/`predev` hook, so you don't have to remember.

## Step 4 — Generate and set the admin password (3 min)

```bash
node scripts/hash-password.mjs
```

It'll prompt for a password (≥12 chars), confirm it, then print a hash and the exact wrangler command. Run that command:

```bash
cd workers/admin
npx wrangler secret put ADMIN_PASSWORD_HASH
# paste the hash when prompted
cd ../..
```

Verify:
```bash
cd workers/admin
npx wrangler secret list
# should show ADMIN_PASSWORD_HASH
cd ../..
```

## Step 5 — Deploy the public Worker (2 min)

```bash
cd workers/public
npx wrangler deploy
```

This uploads the Worker plus the static assets. Output shows a `*.workers.dev` URL, e.g.:
```
https://broadnaxux-public.<your-subdomain>.workers.dev
```

Smoke-test it:
```bash
WORKER_URL="https://broadnaxux-public.<your-subdomain>.workers.dev"
curl -sI "$WORKER_URL/" | head -5
curl -s "$WORKER_URL/__health" | python3 -m json.tool
curl -sI "$WORKER_URL/ipro-ner.html" | head -5
curl -sI "$WORKER_URL/styles.css" | head -5
```

You want HTTP 200 on all four, and `/__health` should report `db: connected-with-data`.

```bash
cd ../..
```

## Step 6 — Deploy the admin Worker (2 min)

```bash
cd workers/admin
npx wrangler deploy
```

Output gives you a second `*.workers.dev` URL:
```
https://broadnaxux-admin.<your-subdomain>.workers.dev
```

Smoke-test:
```bash
ADMIN_URL="https://broadnaxux-admin.<your-subdomain>.workers.dev"
curl -s "$ADMIN_URL/__health" | python3 -m json.tool
# should show ok: true, password_configured: true
```

Then open the URL in a browser, enter your password, and you should land on the dashboard placeholder. Click "Sign out", confirm you're back on the login screen.

```bash
cd ../..
```

## Step 7 — Stop here, hand back to me (Phase 0 is done)

At this point:
- Both Workers are deployed at `*.workers.dev` URLs
- Auth works
- D1 and R2 are wired up
- The static site is mirrored on Cloudflare alongside its Vercel copy
- `barbarabroadnax.com` still resolves to Vercel — no user-facing change yet

Phase 0 is complete. Ping me with the two `*.workers.dev` URLs so I can run my own smoke checks, and we'll plan Phase 1 (case study CRUD, site content editor, importing your existing case studies).

The custom-domain cutover (`barbarabroadnax.com` → `broadnaxux-public`, `admin.barbarabroadnax.com` → `broadnaxux-admin`) is a one-line config change in `wrangler.toml` followed by one DNS record. We'll do that as part of Phase 1 once the admin can actually edit content.

---

## Troubleshooting

**`wrangler deploy` says "binding DB references nonexistent database".**
Confirm the database ID in the wrangler.toml matches what `npx wrangler d1 list` shows. Should be `71f7a5bb-c05d-4325-8fac-fc2b8968f7f2`.

**`/__health` returns 500.**
Check `npx wrangler tail` while curling the endpoint to see the actual error.

**Admin login returns 500.**
Most likely the secret didn't save. `npx wrangler secret list` should show `ADMIN_PASSWORD_HASH`. Re-run `wrangler secret put` if it doesn't.

**Admin login returns 401 even with the right password.**
The hash format is `salt:iterations:hash` separated by colons. If your password contains a `:` and you somehow used it as the secret value instead of the hash output, that'd break parsing. Re-run `node scripts/hash-password.mjs` and use *its* output.

**Static asset 404s on the public Worker.**
Files are missing from `workers/public/public/`. The Worker can only serve what's in that folder when you run `wrangler deploy`. Re-copy and redeploy.
