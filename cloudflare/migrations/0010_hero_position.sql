-- Per-case-study focal point for the homepage hero image.
--
-- With hero_fit = 'cover' the 16:10 frame crops the image, and CSS
-- object-position decides which part stays in view. These two columns store
-- that as percentages (0-100): hero_pos_x is left↔right, hero_pos_y is
-- top↔bottom. 50/50 is dead center, which is the browser default, so every
-- existing study keeps rendering exactly as before.
ALTER TABLE case_studies ADD COLUMN hero_pos_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE case_studies ADD COLUMN hero_pos_y INTEGER NOT NULL DEFAULT 50;
