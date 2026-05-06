-- Phase 3: per-case-study versions.
--
-- A "version" is an optional alternate cut of a case study, addressable
-- at /work/:slug?v=<version_id>. Any field that's NULL on the version
-- inherits from the canonical case_studies row, so a version can override
-- only the subtitle, or only the body, or anywhere in between.
--
-- Use case: BB wants to send a Stripe recruiter a fintech-flavored cut of
-- the NER case study without forking the canonical /work/ipro-ner page.
--
-- ON DELETE CASCADE ensures versions are dropped when their parent case
-- study is deleted.

CREATE TABLE IF NOT EXISTS case_study_versions (
  id TEXT PRIMARY KEY,                  -- random base64url, used in URL ?v=<id>
  case_study_id TEXT NOT NULL REFERENCES case_studies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                  -- admin-only, e.g. "Stripe cut"
  subtitle TEXT,                        -- override; NULL = inherit
  about_html TEXT,                      -- override; NULL = inherit
  body_html TEXT,                       -- override; NULL = inherit
  meta_items TEXT,                      -- override JSON array; NULL = inherit
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_study_versions_cs
  ON case_study_versions(case_study_id);

-- Per-case-study version mapping for share-links.
-- JSON object: { "<case_study_id>": "<version_id>" }
-- Only entries for case studies in case_study_ids are honored.
ALTER TABLE share_links ADD COLUMN case_study_versions TEXT;
