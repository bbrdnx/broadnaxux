# Barbara Broadnax — Portfolio Site Guidelines

## Voice & Writing Rules
- **No em-dashes.** Use a comma, period, or rewrite the sentence instead.
- Keep copy concise and direct.
- Descriptions on cards should be one sentence max, active voice.

## Color Palette (Dark Theme — case study pages)
- Background: #0b0b0f
- Accent: #c084fc
- Text muted: #8a8a9a

## Color Palette (Light Theme — home page)
- Background: #FBF8F1 (warm cream)
- Ink (headings/body): #05334A (navy)
- Accent: #FF5B59 (red — replaces purple)
- Muted text: #8B7F6A

## Case Study Order (home page)
1. Named Entity Recognition — IPRO
2. Design Studio — InkSoft
3. View Reservation — Alaska Airlines
4. Search & Redact — IPRO
5. Early Data Assessment — IPRO
6. Same Day Change — Alaska Airlines
7. Easy SSL Install — InkSoft

## Name Stacking (nav / branding)
BARBARA and BROADNAX stacked, with consistent letter-spacing so both lines read as equal visual weight.

## Home Page Work Section (static index.html only)
This describes the static `index.html`, which is a local-review file and is NOT what the live site serves (see Architecture below). The Work section there is a vertical sequence of cinematic stacked rows, not a card grid. Each case study alternates image and copy left/right (`data-side="left|right"`). On scroll into view each row reveals with a bottom-up wipe, a slow ken-burns settle on the image, and a gentle parallax on the media block. A frosted company logo chip sits over the bottom-right corner of each image. Each chip renders a real logo from `images/logos/<company>.svg` (`ipro`, `alaska`, `inksoft`) when that file exists, and falls back to a CSS monogram lockup (monogram tile plus wordmark, color-coded: IPRO navy, Alaska blue, InkSoft red) when it does not. The swap is handled by the chip's `<img>` `onload`/`onerror` handlers, so dropping a file at the path is all it takes. All motion is disabled under `prefers-reduced-motion`.

The live homepage is different. The Worker renders a simpler card grid (`workCard` in `cloudflare/workers/public/src/index.ts`), not the cinematic rows. The cinematic design has never been ported to the Worker.

## Navigation
Top nav, right-justified: Case Studies dropdown, then Resume and LinkedIn as secondary outline buttons, then Get in touch as the primary filled button. No Work / Companies / Building links. The Case Studies dropdown lists every case study, each linking to its `/work/:slug` page, and is keyboard-accessible (Escape, click-outside, arrow keys). Mobile bottom bar: Case Studies, Resume, LinkedIn, Get in touch.

## Architecture (two homepages)
The repo has two homepages, and only one is live. The live site is rendered by the Cloudflare Worker at `cloudflare/workers/public/src/index.ts`, which builds the homepage, case-study pages, and share-link pages from D1, and serves `barbarabroadnax.com` / `www.barbarabroadnax.com`. The static `index.html` (light cream theme, cinematic stacked rows) is a leftover from the Vercel era (`vercel.json` rewrites `/` to `/index.html`). It is kept only for local design review.

The static file is unreachable on the live site: the Worker serves `/` from D1 and 301-redirects `/index.html` to `/`, and redirects the legacy per-case-study `*.html` files to their D1-backed `/work/:slug` pages. `prepare-assets` still copies `index.html` into the Worker's asset bundle, but the routing shadows it. So edits to `index.html`, `styles.css`, and the static case-study HTML affect local preview only, not production. The two designs remain out of sync; porting the cinematic design into the Worker's `homepageTemplate` is the work to do if it should go live.

Custom share links (`/share/:token`) are served entirely by the Worker and apply per-recipient case-study versions via `?v=<version_id>`. The Case Studies dropdown on the share landing is version-aware: it lists that link's curated studies linked to the exact versions being sent. The dropdown on canonical homepage and case-study pages always links to canonical versions.

## Live homepage content (Worker, D1-backed)
Editable homepage copy lives in the `site_content` table and is managed in the admin Site Content page. The live homepage now renders only: the ticker (`ticker_label`, `ticker_phrases`), the hero (`hero_role`, `hero_tagline`), the work card grid (from published case studies), and the footer (`footer_email`, `footer_linkedin`). The hero role and tagline used to be hardcoded in the Worker; they are now editable keys with the old text as fallback. The earlier thesis / companies-block / work-record / interstitial / side-projects keys were removed when the homepage was simplified, so do not reintroduce admin controls for them.

## Companies and logos (Worker + admin)
Companies are first-class entities (`companies` table: `id` slug, `name`, `logo_image_key`, `brand_color`, `sort_order`). Manage them in the admin Companies section: one logo (uploaded to PUBLIC_BUCKET, served at `/uploads/<key>`) and one brand color per company, reused everywhere. Case studies link via `case_studies.company_id` (set with the "Company logo" dropdown in the case-study editor); if it is blank the Worker falls back to matching `companies.name` against the free-text `company` field. A company logo renders as a brand-tinted chip in three places: over the bottom-right of each homepage work-card image, beside the company name in the case-study hero, and on share-link landing cards. No logo uploaded means no chip (the text eyebrow still shows). The case-study editor's Hero image field is a direct uploader with a thumbnail preview; that image is what shows on the homepage card.

## Deploy
Deploy from the terminal with Wrangler, not the Cloudflare dashboard. There are two Workers: the public site (`cloudflare/workers/public`) and the admin panel (`cloudflare/workers/admin`). From either directory, `npm run deploy` builds and pushes that Worker (the public one auto-runs `prepare-assets` first to copy the static files into the bundle). Preview locally with `npm run dev`. First-time auth: `npx wrangler login`.

Schema changes live in `cloudflare/migrations/`. Apply each new migration to the live D1 database before deploying the Worker that depends on it, e.g. `npx wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/<file>.sql`. The DB is `broadnaxux-content`. Migrations are not auto-applied by deploy.

When handing off a deploy, always include the migration (if any), the Wrangler push for each affected Worker, and the git push, so the live site and the repo stay in sync. Give them as copy-paste terminal commands for BB to run herself (never run them on her behalf):

```
# Apply any new migration(s) to live D1
cd "<repo root>"
npx wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/<file>.sql

# Push to the live site (Cloudflare) — deploy whichever Workers changed
cd cloudflare/workers/public && npm run deploy
cd ../admin && npm run deploy

# Push to the repo (git)
cd "<repo root>"
git add -A
git commit -m "<message>"
git push
```

First-time Wrangler auth, if needed: `npx wrangler login`.
