# Phase 1 cutover runbook

This is the runbook for moving `barbarabroadnax.com` from Vercel to the Cloudflare Worker, and attaching `admin.barbarabroadnax.com` to the admin Worker.

Prereq: `deploy-phase1.sh` has run cleanly and both `__health` endpoints look healthy.

## 1. Smoke test on workers.dev (do this before cutover)

Open these in a browser and confirm everything renders correctly:

- https://broadnaxux-public.broadnaxux.workers.dev/ — homepage with all 7 case studies in the work table
- https://broadnaxux-public.broadnaxux.workers.dev/work/ipro-ner — first case study renders
- https://broadnaxux-public.broadnaxux.workers.dev/work/alaska-view-reservation — biggest case study renders, all images load
- https://broadnaxux-public.broadnaxux.workers.dev/ipro-ner.html — should 301 redirect to /work/ipro-ner
- https://broadnaxux-public.broadnaxux.workers.dev/resume.html — static resume served from ASSETS
- https://broadnaxux-admin.broadnaxux.workers.dev/ — login page; sign in, click around all sections

If anything looks wrong here, **fix it before cutover.** No traffic is on the new infra yet.

## 2. Pause Vercel (optional but recommended)

In the Vercel dashboard for the `broadnaxux` project: **Settings → Domains** — disable the `barbarabroadnax.com` and `www.barbarabroadnax.com` assignments, OR pause the deployment entirely. This frees up the domain so Cloudflare can claim it without conflicts.

If you'd rather leave Vercel running as a fallback, skip this step. The DNS update in step 3 will redirect traffic regardless of Vercel's status.

## 3. Update DNS in Cloudflare and attach Workers to custom domains

Easiest path is to let wrangler manage it. Edit two `wrangler.toml` files:

### `cloudflare/workers/public/wrangler.toml`

Uncomment the routes block at the bottom:

```toml
[[routes]]
pattern = "barbarabroadnax.com"
custom_domain = true

[[routes]]
pattern = "www.barbarabroadnax.com"
custom_domain = true
```

### `cloudflare/workers/admin/wrangler.toml`

Uncomment the routes block at the bottom:

```toml
[[routes]]
pattern = "admin.barbarabroadnax.com"
custom_domain = true
```

Then redeploy from the repo root:

```sh
cd cloudflare/workers/public && npm run deploy
cd ../admin && npm run deploy
```

Wrangler creates the necessary DNS records automatically when `custom_domain = true`. If you see an error like "record already exists", manually delete the conflicting Vercel A/CNAME records in the Cloudflare DNS dashboard for `barbarabroadnax.com`, then re-run.

## 4. Verify the cutover

```sh
curl -sI https://barbarabroadnax.com/ | head -5
curl -sf https://barbarabroadnax.com/__health
curl -sf https://admin.barbarabroadnax.com/__health
```

Both `__health` endpoints should report `"db": "connected-with-data"`.

Open `https://barbarabroadnax.com` in a browser, confirm:

- Homepage loads identically to before
- All 7 case study links work
- Old URLs (e.g. `/ipro-ner.html`) 301-redirect to `/work/ipro-ner`
- `/resume.html` and `/images/*` still work (static assets pass through)

## 5. Tear down Vercel (optional)

Once you're confident:

- Vercel dashboard → broadnaxux project → Settings → Delete project
- Take note: you'll lose Vercel Analytics history. If you want it, export first.

Alternatively, leave Vercel paused indefinitely as a cold-storage backup.
