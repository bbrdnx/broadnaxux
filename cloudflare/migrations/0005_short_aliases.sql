-- Phase 3: short-link aliases.
--
-- Adds an optional pretty slug to share_links so a recipient can be sent
-- /r/<slug> instead of /share/<22-char-token>. The token remains the
-- canonical identifier and underlying URL; the slug is just an alias that
-- 302-redirects to it.
--
-- Slug constraints (enforced in admin form, not DB):
--   - lowercase a-z, 0-9, hyphen
--   - 3-40 chars, must start and end with alphanumeric
--
-- Schema constraint: unique when present, NULL allowed for links without
-- an alias. SQLite supports partial unique indexes via WHERE clause.

ALTER TABLE share_links ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_slug
  ON share_links(slug)
  WHERE slug IS NOT NULL;
