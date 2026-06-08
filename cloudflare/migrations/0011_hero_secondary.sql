-- Secondary hero image (the "mobile" companion to the primary hero image).
--
-- Most case-study projects are responsive sites with a desktop and a mobile
-- view. The primary hero image (hero_image_key) is the large desktop shot; this
-- adds an optional second image that, on the public site, overlaps the primary
-- one as a floating phone-shaped panel with a faster parallax on scroll.
--
-- It mirrors the primary image's controls exactly:
--   hero_image_key_2  R2 key (or URL) for the secondary image. NULL = not set.
--   hero_fit_2        'cover' (crop) | 'contain' (letterbox) | 'frame' (no crop)
--   hero_pos_x_2      object-position X %, 0-100 (default 50 = center)
--   hero_pos_y_2      object-position Y %, 0-100 (default 50 = center)
--
-- Rendering rules (public Worker):
--   * both images set    -> desktop fills the frame, mobile floats over the
--                           inner edge (nearest the copy) with parallax.
--   * only one set       -> that image fills the frame using its own fit/pos
--                           settings; no overlay. ("show the one that exists")
--   * neither set        -> no image, exactly as before.
--
-- hero_image_key_2 has no NOT NULL/default so an unset secondary image stays
-- NULL; the fit/pos columns default to the same neutral values as the primary,
-- so every existing study keeps rendering exactly as before.
ALTER TABLE case_studies ADD COLUMN hero_image_key_2 TEXT;
ALTER TABLE case_studies ADD COLUMN hero_fit_2 TEXT NOT NULL DEFAULT 'cover';
ALTER TABLE case_studies ADD COLUMN hero_pos_x_2 INTEGER NOT NULL DEFAULT 50;
ALTER TABLE case_studies ADD COLUMN hero_pos_y_2 INTEGER NOT NULL DEFAULT 50;
