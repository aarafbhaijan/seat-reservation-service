-- Remember the order seats were given in at creation, so GET /shows/:id lists them
-- A1, A2, ... A10 instead of the alphabetical A1, A10, A2.
-- (Locking still uses the primary key order, (show_id, label) — this column is display-only.)
ALTER TABLE seats ADD COLUMN position INT NOT NULL DEFAULT 0;
