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

## Home Page Work Section (static index.html)
The Work section is a vertical sequence of cinematic stacked rows, not a card grid. Each case study alternates image and copy left/right (`data-side="left|right"`). On scroll into view each row reveals with a bottom-up wipe, a slow ken-burns settle on the image, and a gentle parallax on the media block. A frosted company logo chip pops in over the bottom-right corner of each image. Logo chips are CSS placeholders (monogram tile plus wordmark), color-coded per company (IPRO navy, Alaska blue, InkSoft red). To swap in a real logo, replace the chip's inner spans with an `<img>`. All motion is disabled under `prefers-reduced-motion`.

## Navigation
Top nav, right-justified: Case Studies dropdown, then Resume and LinkedIn as secondary outline buttons, then Get in touch as the primary filled button. No Work / Companies / Building links. The Case Studies dropdown lists every case study, each linking to its `/work/:slug` page, and is keyboard-accessible (Escape, click-outside, arrow keys). Mobile bottom bar: Case Studies, Resume, LinkedIn, Get in touch.

## Architecture (two homepages)
The repo has two homepages. The static `index.html` is the cinematic dark design used for local review. The live site is rendered by the Cloudflare Worker at `cloudflare/workers/public/src/index.ts`, which builds the homepage, case-study pages, and share-link pages from D1. These two designs are currently out of sync and should be reconciled before treating the static file as the source of truth.

Custom share links (`/share/:token`) are served entirely by the Worker and apply per-recipient case-study versions via `?v=<version_id>`. The Case Studies dropdown on the share landing is version-aware: it lists that link's curated studies linked to the exact versions being sent. The dropdown on canonical homepage and case-study pages always links to canonical versions.

## Deploy
Deploy from the terminal with Wrangler, not the Cloudflare dashboard. From `cloudflare/workers/public`: `npm run deploy` (auto-runs `prepare-assets` to copy the static files into the bundle, then `wrangler deploy`). Preview locally with `npm run dev`. First-time auth: `npx wrangler login`.

When handing off a deploy, always include both the Wrangler push and the git push commands so the live site and the repo stay in sync. Give them as copy-paste terminal commands for BB to run herself (never run them on her behalf):

```
# Push to the live site (Cloudflare)
cd cloudflare/workers/public
npm run deploy

# Push to the repo (git)
git add -A
git commit -m "<message>"
git push
```

First-time Wrangler auth, if needed: `npx wrangler login`.
