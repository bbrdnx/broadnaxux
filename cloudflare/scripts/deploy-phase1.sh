#!/usr/bin/env bash
# deploy-phase1.sh — deploy public + admin Workers to workers.dev URLs.
#
# Run from any directory.  After this finishes, smoke test both URLs:
#   https://broadnaxux-public.broadnaxux.workers.dev/
#   https://broadnaxux-admin.broadnaxux.workers.dev/
#
# Custom-domain cutover happens separately, after the workers.dev URLs
# look right. See cloudflare/scripts/cutover-phase1.md.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

echo "Repo root: $REPO_ROOT"
echo

echo "── Deploying broadnaxux-public ──────────────────────────────────"
cd "$REPO_ROOT/cloudflare/workers/public"
npm run deploy
echo

echo "── Deploying broadnaxux-admin ───────────────────────────────────"
cd "$REPO_ROOT/cloudflare/workers/admin"
npm run deploy
echo

echo "── Smoke checking __health ──────────────────────────────────────"
echo "Public worker:"
curl -sf https://broadnaxux-public.broadnaxux.workers.dev/__health | head -c 400
echo
echo
echo "Admin worker:"
curl -sf https://broadnaxux-admin.broadnaxux.workers.dev/__health | head -c 400
echo
echo
echo "Done. Open the workers.dev URLs in a browser to spot-check, then run"
echo "the cutover steps in cloudflare/scripts/cutover-phase1.md."
