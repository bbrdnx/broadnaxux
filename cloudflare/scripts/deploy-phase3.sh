#!/usr/bin/env bash
# deploy-phase3.sh — applies Phase 3 migrations and deploys both Workers
# in one go. Designed to be run by a human, not a CI system: prompts for
# confirmation, prints clear status, fails loud.
#
# To run:  bash ~/GitHub/PortfolioSite/cloudflare/scripts/deploy-phase3.sh

set -euo pipefail

# Pretty output
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

step() { printf "\n${BOLD}▸ %s${RESET}\n" "$1"; }
ok()   { printf "${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$1"; }
die()  { printf "${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO="$( cd "$SCRIPT_DIR/../.." && pwd )"
DB="broadnaxux-content"

cat <<'BANNER'

  ┌──────────────────────────────────────────────────────────────────┐
  │  Phase 3 deploy: drag-and-drop, /r/<slug>, analytics, versions   │
  └──────────────────────────────────────────────────────────────────┘

This script will:
  1. Check that wrangler is installed and you're logged into Cloudflare
  2. Apply migration 0005 (short-link aliases) to live D1
  3. Apply migration 0006 (case study versions) to live D1
  4. Deploy the public Worker
  5. Deploy the admin Worker
  6. Hit /__health on both to confirm they're up

If anything fails, it stops immediately and tells you what went wrong.
You can safely re-run this script — applied migrations skip cleanly.

BANNER

read -r -p "Proceed? [y/N] " confirm
case "$confirm" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# ─── 1. Sanity checks ───────────────────────────────────────────────────
step "Checking prerequisites"

cd "$REPO/cloudflare/workers/admin" 2>/dev/null \
  || die "Can't find $REPO/cloudflare/workers/admin. Is the repo path right?"

if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  die "wrangler isn't installed in cloudflare/workers/admin/node_modules. Run: cd $REPO/cloudflare/workers/admin && npm install"
fi
ok "wrangler available ($(npx --no-install wrangler --version 2>&1 | head -1))"

if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  warn "Not logged into Cloudflare. Running: npx wrangler login"
  npx --no-install wrangler login || die "Login failed. Aborting."
fi
ok "Logged into Cloudflare as $(npx --no-install wrangler whoami 2>&1 | grep -E 'You are logged in|email' | head -1 | sed 's/.*: //')"

# ─── 2. Apply migrations ────────────────────────────────────────────────
apply_migration () {
  local file="$1"
  local label="$2"
  step "Applying migration: $label"
  printf "${DIM}File: %s${RESET}\n" "$file"

  if npx --no-install wrangler d1 execute "$DB" --remote --file="$file" 2>&1 | tee /tmp/d1-out.txt; then
    if grep -qE 'duplicate column name|already exists' /tmp/d1-out.txt; then
      ok "Migration was already applied previously. Continuing."
    else
      ok "Migration applied."
    fi
  else
    # Wrangler exits non-zero on duplicate-column too, so check the output
    if grep -qE 'duplicate column name|already exists' /tmp/d1-out.txt; then
      ok "Migration was already applied previously. Continuing."
    else
      die "Migration $label failed. See output above."
    fi
  fi
}

apply_migration "$REPO/cloudflare/migrations/0005_short_aliases.sql" \
  "0005 short-link aliases"

apply_migration "$REPO/cloudflare/migrations/0006_case_study_versions.sql" \
  "0006 case study versions"

# ─── 3. Deploy both Workers ─────────────────────────────────────────────
step "Deploying broadnaxux-public"
cd "$REPO/cloudflare/workers/public"
npm run deploy
ok "Public Worker deployed"

step "Deploying broadnaxux-admin"
cd "$REPO/cloudflare/workers/admin"
npm run deploy
ok "Admin Worker deployed"

# ─── 4. Health checks ───────────────────────────────────────────────────
step "Hitting /__health on both Workers"
PUB="https://broadnaxux-public.broadnaxux.workers.dev/__health"
if curl -sf --max-time 10 "$PUB" | head -c 400; then
  echo; ok "Public Worker is responding"
else
  warn "Public /__health didn't return a 2xx. Custom domain may still work; check https://barbarabroadnax.com/"
fi
echo

# Admin /__health requires auth, so just check that the Worker responds at all
ADMIN="https://broadnaxux-admin.broadnaxux.workers.dev/login"
if curl -sf --max-time 10 -o /dev/null "$ADMIN"; then
  ok "Admin Worker is responding"
else
  warn "Admin login page didn't return 2xx. Check https://admin.barbarabroadnax.com/login"
fi

# ─── 5. Done. Smoke test reminder ───────────────────────────────────────
cat <<'NEXT'

  ┌──────────────────────────────────────────────────────────────────┐
  │                          ✓ Deploy done                           │
  └──────────────────────────────────────────────────────────────────┘

Five-minute smoke test (open https://admin.barbarabroadnax.com):

  1. Drag-and-drop
     · Edit any share-link
     · Grab the ⋮⋮ handle on a selected case study and drag it
     · A purple line shows where it will drop. Save and reload.

  2. Short URL
     · On the same edit page, type "smoke-test" in the Short URL field
     · Save
     · Open https://barbarabroadnax.com/r/smoke-test in a new tab
     · It should redirect to the share-link page

  3. Analytics
     · Back in the share-links list, click "Analytics" on any link
     · Confirm the tiles, 30-day chart, and recent activity render

  4. Per-case-study version
     · Edit any case study (e.g. "Named Entity Recognition")
     · Scroll to "Versions of this case study" at the bottom
     · Click "+ New version", label it "Smoke test", change the subtitle, save
     · Click "Preview ↗" — confirm the variant subtitle renders
     · Then edit a share-link, add that case study, pick "Smoke test" from
       the version dropdown, save
     · Open the share-link, hover the case study card — URL should include ?v=...

When you're done with the smoke test, delete the test version and the test
share-link. They cascade cleanly.

NEXT
