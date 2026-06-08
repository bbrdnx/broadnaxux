-- Job applications tracker, integrated into the admin panel.
--
-- This brings BB's local job-search tracker (tracker.xlsx) into D1 so she can
-- log and review applications from any browser via the admin panel. Each row is
-- one application: company + role, where it stands in the pipeline, the JD link,
-- the fit analysis, and R2 keys for the generated resume + cover letter.
--
-- The four document keys point at objects in PRIVATE_BUCKET (NOT the public
-- /uploads/ bucket), so application materials are never served on the public
-- site. The admin streams them behind the login at /app-docs/<key>.
--
-- Status pipeline mirrors the old tracker: in_progress, applied, followed_up,
-- interviewing, offer, denied.
--
-- Run remotely:
--   wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/0013_applications.sql

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,             -- slug, e.g. "weedmaps-product-designer"
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  location TEXT,                   -- freeform, nullable
  jd_url TEXT,                     -- the job posting link
  source TEXT,                     -- where it was found (LinkedIn, referral, ...)
  status TEXT NOT NULL DEFAULT 'in_progress',
                                   -- in_progress | applied | followed_up | interviewing | offer | denied
  fit_score INTEGER,               -- optional 0-100 self-rated fit
  fit_notes TEXT,                  -- the fit analysis
  notes TEXT,                      -- freeform notes / next steps
  salary TEXT,                     -- comp range, freeform
  resume_pdf_key TEXT,             -- PRIVATE_BUCKET keys, nullable until uploaded
  resume_docx_key TEXT,
  cover_pdf_key TEXT,
  cover_docx_key TEXT,
  applied_at INTEGER,              -- epoch seconds; set when status moves to applied
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_updated ON applications(updated_at);
