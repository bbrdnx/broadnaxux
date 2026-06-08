-- Side projects ("Now building" section) become first-class case studies.
--
-- A side project is a normal case_studies row with kind='side'. It gets the
-- exact same editor controls as a work case study, plus:
--   * external_url  — the live project link (e.g. https://mtrcd.com)
--   * card_only     — when 1, the homepage "Now building" card links straight
--                     to external_url and has no internal /work/:slug page.
--                     When 0, the card links to the internal case-study page and
--                     surfaces a small "Live ↗" link to external_url.
--   * live_label    — the status badge on the card (e.g. "Live", "Beta").
--                     Empty/NULL hides the badge.
--
-- Existing studies default to kind='work', so they keep rendering in the main
-- cinematic work grid exactly as before.

ALTER TABLE case_studies ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';   -- 'work' | 'side'
ALTER TABLE case_studies ADD COLUMN external_url TEXT;                    -- live project link (side projects)
ALTER TABLE case_studies ADD COLUMN card_only INTEGER NOT NULL DEFAULT 0; -- 1 = card links out, no internal page
ALTER TABLE case_studies ADD COLUMN live_label TEXT;                      -- card status badge text

-- ── Now building section copy (admin-editable via Site Content) ────────────
INSERT OR REPLACE INTO site_content (key, value, value_type, updated_at) VALUES
  ('building_eyebrow', 'Now building', 'text', unixepoch()),
  ('building_heading', 'On my own terms.', 'text', unixepoch()),
  ('building_intro',
   'Side projects keep me honest. No sprint planning, no stakeholders. Just decisions I make for tools I believe in.',
   'text', unixepoch());

-- ── Seed the two existing side projects so the section renders unchanged ───
-- Both are card-only today (the cards link straight out to the live sites).
INSERT OR IGNORE INTO case_studies
  (id, title, company, role, outcome_metric, hero_image_key, body_html,
   status, sort_order, kind, external_url, card_only, live_label,
   subtitle, created_at, updated_at)
VALUES
  ('mtrcd', 'MTRCD — WCAG Guide', 'Personal project', NULL, NULL, NULL, '',
   'published', 100, 'side', 'https://mtrcd.com', 1, 'Live',
   'An accessibility reference built as a product design exercise, not a prompt exercise.',
   unixepoch(), unixepoch()),
  ('the-lez-list', 'The Lez List', 'Personal project', NULL, NULL, NULL, '',
   'published', 101, 'side', 'https://thelezlist.com', 1, 'Live',
   'Connecting Black lesbians and queer women to events and experiences, by us, for us.',
   unixepoch(), unixepoch());
