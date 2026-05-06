-- Phase 3-ish: dedicated card-display fields on case_studies.
--
-- The "thumbnails" surface (companies section on home, work-record on home,
-- share-link landing, admin list) needs three things per case study: a card
-- image, a card display title, and a one-line subhead. We could repurpose
-- title / outcome_metric / hero_image_key for that, but those are wired to
-- the canonical case-study page (title, hero meta, deep-link images), so
-- pinning card copy to them removes the freedom to write tighter card copy.
--
-- Approach: nullable card_* columns. The renderer falls back to the
-- canonical fields when the card field is blank, so existing data keeps
-- rendering and BB only fills these in if she wants different card copy.

ALTER TABLE case_studies ADD COLUMN card_image_key TEXT;
ALTER TABLE case_studies ADD COLUMN card_title TEXT;
ALTER TABLE case_studies ADD COLUMN card_subhead TEXT;
