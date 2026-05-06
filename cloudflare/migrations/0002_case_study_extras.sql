-- Phase 1 schema extensions for case_studies.
--
-- The original schema had meta_role / meta_team / meta_rating, but case studies
-- in practice use varying labels (Role/Team/Rating, Role/Timeline/Outcome, etc).
-- We model the case-meta block as a JSON array of {label, value} pairs instead.
--
-- Also splitting the case-hero copy into structured fields so the renderer can
-- reassemble the hero band: subtitle (the lead paragraph) + about_html (the
-- "About <Company>" paragraph). body_html stays for everything below the hero.

ALTER TABLE case_studies ADD COLUMN subtitle TEXT;
ALTER TABLE case_studies ADD COLUMN about_html TEXT;
ALTER TABLE case_studies ADD COLUMN meta_items TEXT; -- JSON array of {label, value}
