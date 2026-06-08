-- Per-case-study control for how the hero image sits in the homepage
-- cinematic row frame.
--
-- The homepage rows use a fixed 16:10 frame. With the default object-fit:
-- cover, off-ratio images (tall screenshots, square art) get cropped to fill.
-- hero_fit lets BB switch an individual study to 'contain' so the whole image
-- shows (letterboxed against the frame background) instead of being cropped.
--
-- Default 'cover' keeps every existing study rendering exactly as before.
ALTER TABLE case_studies ADD COLUMN hero_fit TEXT NOT NULL DEFAULT 'cover';
