-- Phase 1 schema for broadnaxux-content
-- Already applied to the live D1 database via the Cloudflare MCP.
-- Kept here so you can re-create the schema in a local dev DB or rebuild from scratch.

CREATE TABLE IF NOT EXISTS case_studies (
  id TEXT PRIMARY KEY,                  -- slug, e.g. "ipro-ner"
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  role TEXT,
  team TEXT,
  outcome_metric TEXT,                  -- short summary for the homepage row
  hero_image_key TEXT,                  -- R2 object key
  body_html TEXT NOT NULL,              -- full body of the case study
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published' | 'hidden'
  sort_order INTEGER NOT NULL DEFAULT 0,
  meta_role TEXT,                       -- hero metadata (rendered in case study header)
  meta_team TEXT,
  meta_rating TEXT,
  tags TEXT,                            -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'markdown' | 'json' | 'html'
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_studies_status_sort ON case_studies(status, sort_order);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
