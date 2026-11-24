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

-- Nến 1 phút do chỉ báo pine/gia-realtime.pine gửi về.
CREATE TABLE IF NOT EXISTS bars (
  symbol  TEXT    NOT NULL,
  t       INTEGER NOT NULL,                 -- ms, giờ mở nến
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (symbol, t)
);

-- Giá cuối và khối lượng trong ngày của từng mã cho bảng giá.
CREATE TABLE IF NOT EXISTS quotes (
  symbol  TEXT PRIMARY KEY,
  t       INTEGER NOT NULL,                 -- ms, nến 1 phút mới nhất
  c       REAL,                             -- giá cuối
  dv      REAL,                             -- khối lượng trong ngày
  pc      REAL                              -- giá đóng cửa phiên trước
);
