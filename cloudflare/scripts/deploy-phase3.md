# Phase 3 deploy runbook

Phase 3 ships four polish features on top of Phase 2 share-links:

1. Drag-and-drop reorder in the share-link composer
2. Short-link aliases (`/r/<slug>` → `/share/<token>`)
3. Per-link analytics page (`/share-links/:id/analytics`)
4. Per-case-study versions (`/work/:slug?v=<vid>`)

Two new migrations land with this phase: `0005_short_aliases.sql` and
`0006_case_study_versions.sql`.

## Order of operations

Apply migrations BEFORE deploying the Workers. Both Workers fall back
gracefully if the columns/tables aren't there yet (the features show as
empty/disabled), so out-of-order is safe but not ideal.

### 1. Apply migrations to the live D1

```bash
cd ~/GitHub/PortfolioSite

# 0005: adds share_links.slug + partial unique index
wrangler d1 execute broadnaxux-content --remote \
  --file=cloudflare/migrations/0005_short_aliases.sql

# 0006: case_study_versions table + share_links.case_study_versions column
wrangler d1 execute broadnaxux-content --remote \
  --file=cloudflare/migrations/0006_case_study_versions.sql
```

Verify:

```bash
wrangler d1 execute broadnaxux-content --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'case%';"
# should include case_studies, case_study_versions

wrangler d1 execute broadnaxux-content --remote --command \
  "PRAGMA table_info(share_links);"
# should include slug AND case_study_versions columns
```

### 2. Deploy both Workers

```bash
cd ~/GitHub/PortfolioSite
bash cloudflare/scripts/deploy-phase1.sh
```

(Same script as Phase 1 — it just deploys both Workers in sequence and
hits `/__health` on each.)

### 3. Smoke test (manual, ~5 min)

Open https://admin.barbarabroadnax.com and walk through:

**Drag-and-drop:**
- Edit any existing share-link
- Grab the `⋮⋮` handle on a selected case study and drag it to a new position
- Drop indicator (purple line) should appear above/below the target row
- Save and confirm order persists on reload

**Short-link alias:**
- On the same edit page, set Short URL to e.g. `smoke-test`
- Save
- Visit https://barbarabroadnax.com/r/smoke-test — should 302 to `/share/<token>`
- Try a duplicate slug on a different link — should reject with a friendly toast
- Try `new` or `admin` as slug — should reject as reserved

**Per-link analytics:**
- From the share-links list, click "Analytics" on any link with views
- Confirm: tiles populate, 30-day bar chart renders, recent activity table shows events
- Open the link in an incognito window, click a card, then refresh analytics — counts should bump

**Per-case-study versions:**
- Edit any case study (e.g. ipro-ner)
- Scroll to the "Versions of this case study" section at the bottom
- Click "+ New version", label it "Smoke test", change the subtitle, save
- Visit https://barbarabroadnax.com/work/ipro-ner?v=&lt;the-id-from-the-version-page&gt; — should render with the new subtitle, canonical body
- Now edit a share-link, add the case study, pick "Smoke test" from the version dropdown next to it
- Save and open the share-link — the case study card should link to `/work/ipro-ner?v=<vid>` (check by hovering)
- Click the card, confirm the variant subtitle renders

### 4. Clean up the smoke test

- Delete the test share-link
- Delete the "Smoke test" version from the case study editor
- Both cascade cleanly (versions cascade on case-study delete; share-link views cascade on share-link delete)

## Rollback

Both migrations are additive (one ALTER TABLE adds a nullable column,
one CREATE TABLE). To roll back:

```sql
-- 0006 rollback
ALTER TABLE share_links DROP COLUMN case_study_versions;
DROP TABLE case_study_versions;

-- 0005 rollback
DROP INDEX IF EXISTS idx_share_links_slug;
ALTER TABLE share_links DROP COLUMN slug;
```

Wrangler doesn't have a native migration rollback, so run via
`wrangler d1 execute --command`. SQLite's DROP COLUMN landed in 3.35;
D1 is on a recent enough SQLite to support it.

## Known behavioral notes

- `/r/<slug>` does a 302 redirect — recipients see the canonical
  `/share/<token>` URL after click. Pretty URL is in the email; address
  bar shows the real one. If you'd rather pass-through render under
  `/r/`, that's a future polish — requires duplicating share-link
  sub-routes and re-scoping the unlock cookie path.
- Version IDs are not guessable (12 random bytes) but they're not
  secrets either — they're addressable at `/work/:slug?v=<vid>` with no
  auth. Don't rely on them being private.
- A version with all fields blank inherits everything from canonical.
  Useful for testing; not useful in production. The version list shows
  "no overrides — pure inherit" for these.
- If a share-link references a version that's since been deleted, the
  case study still renders — just at canonical. The map entry becomes
  a no-op rather than an error.
