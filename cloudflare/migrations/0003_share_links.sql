-- Phase 2 schema: share-links.
--
-- A share-link is a curated, optionally password-protected, optionally
-- expiring view of a subset of case studies, with an optional custom
-- headline/message and an optional custom resume PDF. The public Worker
-- exposes them at /share/:token. The admin Worker has CRUD pages.
--
-- Per Phase 2 scope decision (2026-05-02): no per-case-study versions in
-- this round. case_study_versions and version_overrides are deferred.
--
-- Run remotely:
--   wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/0003_share_links.sql
-- Or via the Cloudflare D1 MCP tool.

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,                          -- internal ID (UUID-ish)
  token TEXT UNIQUE NOT NULL,                   -- public URL slug, ~22 chars
  name TEXT NOT NULL,                           -- internal label, e.g. "Jane @ Stripe – round 2"
  recipient_label TEXT,                         -- admin-only, e.g. "Jane Smith, Stripe"
  case_study_ids TEXT NOT NULL DEFAULT '[]',    -- JSON array of case_studies.id, controls inclusion + order
  resume_file_key TEXT,                         -- R2 key in PRIVATE_BUCKET, nullable
  resume_file_name TEXT,                        -- display filename for download
  custom_headline TEXT,                         -- optional headline replacing default H1 on /share/:token
  custom_message TEXT,                          -- optional message paragraph above the case study list (HTML)
  password_hash TEXT,                           -- nullable; same PBKDF2 format as ADMIN_PASSWORD_HASH
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                           -- nullable Unix seconds
  last_viewed_at INTEGER                        -- nullable; updated by /share/:token
);

CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links(created_at DESC);

CREATE TABLE IF NOT EXISTS share_link_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  event TEXT NOT NULL DEFAULT 'open',           -- 'open' | 'unlock_failed' | 'card_click' | 'resume_download'
  case_study_id TEXT,                           -- NULL for landing page; slug for card_click
  ip_hash TEXT,
  user_agent TEXT,
  referrer TEXT
);

CREATE INDEX IF NOT EXISTS idx_share_link_views_link ON share_link_views(share_link_id, viewed_at DESC);
