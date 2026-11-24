CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id      TEXT,
  strategy    TEXT    NOT NULL,
  symbol      TEXT    NOT NULL,
  side        TEXT    NOT NULL,             -- buy | sell
  status      TEXT    NOT NULL,             -- pending | open | closed | cancelled
  entry       REAL,
  sl          REAL,
  tp          REAL,
  exit_price  REAL,
  result      TEXT,                         -- tp | sl | exit
  created_at  INTEGER NOT NULL,             -- ms
  opened_at   INTEGER,
  closed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_lookup ON trades (strategy, symbol, status);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  outcome     TEXT
);
