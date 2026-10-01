-- Initial schema. See docs/design.md §2 for the reasoning behind each table.

-- A show is immutable once created (name, price, limit, seat count never change).
CREATE TABLE shows (
  id              CHAR(26)     NOT NULL,
  name            VARCHAR(200) NOT NULL,
  price_paise     BIGINT       NOT NULL,
  per_user_limit  INT          NOT NULL DEFAULT 4,
  total_seats     INT          NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_shows_price CHECK (price_paise > 0),
  CONSTRAINT chk_shows_limit CHECK (per_user_limit > 0)
);

-- One row per seat. The row IS the unit of ownership: its single `status` column means a seat
-- can never be in two states, which is what makes available + held + confirmed == total.
CREATE TABLE seats (
  show_id         CHAR(26)     NOT NULL,
  label           VARCHAR(16)  NOT NULL,
  status          ENUM('available','held','confirmed') NOT NULL DEFAULT 'available',
  reservation_id  CHAR(26)     NULL,
  user_id         VARCHAR(64)  NULL,
  hold_expires_at DATETIME(3)  NULL,
  PRIMARY KEY (show_id, label),
  KEY idx_seats_reservation (reservation_id),
  KEY idx_seats_show_status (show_id, status)
);

-- One row per successful reservation. UNIQUE (user_id, idempotency_key) is what makes
-- a retried request impossible to apply twice.
CREATE TABLE reservations (
  id               CHAR(26)     NOT NULL,
  show_id          CHAR(26)     NOT NULL,
  user_id          VARCHAR(64)  NOT NULL,
  seats            JSON         NOT NULL,
  amount_paise     BIGINT       NOT NULL,
  status           ENUM('confirmed','cancelled') NOT NULL,
  idempotency_key  VARCHAR(128) NOT NULL,
  request_hash     CHAR(64)     NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservations_user_idem (user_id, idempotency_key),
  KEY idx_reservations_show (show_id)
);

-- How many seats each user currently holds per show. Locking this single row serialises
-- one user's parallel requests, which is how the per-user limit holds under concurrency.
CREATE TABLE user_quota (
  show_id     CHAR(26)    NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  seats_held  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (show_id, user_id),
  CONSTRAINT chk_user_quota_non_negative CHECK (seats_held >= 0)
);
