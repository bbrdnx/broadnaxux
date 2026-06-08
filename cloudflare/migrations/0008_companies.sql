-- Phase 3: companies as first-class entities with a reusable logo + brand color.
--
-- Until now "company" was just a free-text field on each case study. To show a
-- company logo beside the case-study hero image on the homepage, in the
-- case-study hero band, and on share-link landing cards, we need one place to
-- store each company's logo (an R2 key in PUBLIC_BUCKET, served at /uploads/<key>)
-- and brand color. case_studies.company_id links a study to its company; the
-- public Worker also falls back to matching by name so unlinked studies still
-- pick up a logo.
--
-- Run remotely:
--   wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/0008_companies.sql
-- Or via the Cloudflare D1 MCP tool.

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,            -- slug, e.g. "ipro", "alaska-airlines", "inksoft"
  name TEXT NOT NULL,             -- display name, must match case_studies.company for fallback
  logo_image_key TEXT,           -- R2 key in PUBLIC_BUCKET, nullable until a logo is uploaded
  brand_color TEXT,              -- hex used to tint the logo chip, nullable
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);

-- Link case studies to companies. Nullable; the renderer falls back to a
-- name match when this is empty.
ALTER TABLE case_studies ADD COLUMN company_id TEXT;

-- Seed the three known companies. Brand colors are sensible defaults BB can
-- change in admin (IPRO navy, Alaska blue, InkSoft red per the site guidelines).
INSERT OR IGNORE INTO companies (id, name, logo_image_key, brand_color, sort_order, created_at, updated_at) VALUES
  ('ipro',            'IPRO',            NULL, '#0B3D5C', 1, unixepoch(), unixepoch()),
  ('alaska-airlines', 'Alaska Airlines', NULL, '#01426A', 2, unixepoch(), unixepoch()),
  ('inksoft',         'InkSoft',         NULL, '#D7263D', 3, unixepoch(), unixepoch());

-- Backfill company_id on existing case studies by matching the free-text name.
UPDATE case_studies
   SET company_id = (SELECT c.id FROM companies c WHERE c.name = case_studies.company)
 WHERE company_id IS NULL
   AND EXISTS (SELECT 1 FROM companies c WHERE c.name = case_studies.company);
