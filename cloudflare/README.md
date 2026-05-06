# broadnaxux Cloudflare project

This folder lives **inside the PortfolioSite repo** and contains everything for the Cloudflare side of your portfolio: two Workers (public and admin), database migrations, and deployment scripts.

## Layout

```
PortfolioSite/                # ← the repo root (your existing portfolio)
├── index.html                # ← static site files, deployed to Vercel today
├── ipro-ner.html
├── styles.css
├── images/
├── ...
└── cloudflare/               # ← everything in this folder
    ├── DEPLOYMENT.md         # step-by-step deploy guide
    ├── migrations/
    │   ├── 0001_initial.sql        # Phase 1 schema (already applied to live D1)
    │   └── seed_site_content.sql   # initial homepage values (already applied)
    ├── scripts/
    │   ├── hash-password.mjs           # generate ADMIN_PASSWORD_HASH
    │   └── prepare-public-assets.mjs   # copies static files → workers/public/public/
    └── workers/
        ├── public/                     # serves barbarabroadnax.com
        │   ├── wrangler.toml
        │   ├── package.json
        │   ├── tsconfig.json
        │   ├── src/index.ts
        │   └── public/                 # auto-populated by prepare-public-assets.mjs
        └── admin/                      # serves admin.barbarabroadnax.com
            ├── wrangler.toml
            ├── package.json
            ├── tsconfig.json
            └── src/index.ts
```

## Already provisioned in your Cloudflare account

| Resource | Name | ID |
|---|---|---|
| D1 database | `broadnaxux-content` | `71f7a5bb-c05d-4325-8fac-fc2b8968f7f2` |
| R2 bucket (public) | `broadnaxux-public` | — |
| R2 bucket (private) | `broadnaxux-private` | — |
| Cloudflare account | Broadnaxux@gmail.com | `274658631482a2b03f8eb12bb94f27dc` |

Schema is applied. `site_content` is seeded with values pulled from your current homepage.

## What's left for you

`DEPLOYMENT.md` walks you through it. Short version:

1. `npm install` in each Worker project
2. `npx wrangler login`
3. `npm run prepare-assets` (copies static files automatically)
4. Generate an admin password hash with `scripts/hash-password.mjs`
5. Set the hash as a Worker secret
6. `npm run deploy` in each Worker project
7. Smoke-test on the `*.workers.dev` URLs
8. When happy (Phase 1+), attach `barbarabroadnax.com` and `admin.barbarabroadnax.com` to the Workers

The site stays on Vercel until you decide to cut over. Phase 0 just gets the Workers running on `*.workers.dev` URLs alongside Vercel.
