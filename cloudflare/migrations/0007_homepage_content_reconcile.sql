-- Phase 3: reconcile site_content with the simplified homepage.
--
-- The "editorial hero, page tightening" homepage (public Worker) dropped the
-- thesis lines, companies block, work-record table, interstitial, and the dark
-- side-projects section. Those site_content rows were still editable in admin
-- but no longer rendered anywhere. This migration removes the dead rows and
-- seeds the two new editable hero fields (role + tagline) that replaced the
-- hardcoded copy in the Worker.
--
-- Run remotely:
--   wrangler d1 execute broadnaxux-content --remote --file=cloudflare/migrations/0007_homepage_content_reconcile.sql
-- Or via the Cloudflare D1 MCP tool.

-- Seed the new editable hero fields. Values mirror the Worker fallbacks so the
-- homepage looks identical until BB edits them.
INSERT OR REPLACE INTO site_content (key, value, value_type, updated_at) VALUES
  ('hero_role', 'Senior Product Designer', 'text', unixepoch()),
  ('hero_tagline',
   'I design end-to-end experiences built for real people in real situations. Whether it''s data management flows or tools that open up new revenue opportunities, I bring a versatile skill set to whatever the problem is. I work closely with product and engineering, lean on research to move quickly, and never lose sight of the bigger picture.',
   'text', unixepoch());

-- Remove rows the homepage no longer renders.
DELETE FROM site_content WHERE key IN (
  'thesis_line_1',
  'thesis_line_2',
  'asterisk_tooltip',
  'co_eyebrow',
  'company_context',
  'record_header',
  'interstitial_paragraph_1',
  'interstitial_paragraph_2',
  'interstitial_after_position',
  'side_projects_eyebrow',
  'side_projects_headline',
  'side_projects_lead',
  'side_projects_quote',
  'side_projects_quote_cite'
);
