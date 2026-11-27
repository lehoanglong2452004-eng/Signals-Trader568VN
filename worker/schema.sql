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

-- ===== Chiến lược chạy trên máy chủ =====
ALTER TABLE trades ADD COLUMN ver TEXT;    -- bộ thông số tạo ra lệnh (NULL = lệnh từ alert TradingView)
ALTER TABLE trades ADD COLUMN meta TEXT;   -- JSON: hòa vốn, khoảng rủi ro ban đầu

-- Nến khung lớn gộp từ nến 1 phút (tf tính bằng phút).
CREATE TABLE IF NOT EXISTS tfbars (
  symbol TEXT NOT NULL, tf INTEGER NOT NULL, t INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (symbol, tf, t)
);
-- Thông số đang dùng của từng chiến lược trên từng mã.
CREATE TABLE IF NOT EXISTS strat_cfg (
  strategy TEXT NOT NULL, symbol TEXT NOT NULL, params TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER,
  PRIMARY KEY (strategy, symbol)
);
-- Lịch sử các bộ thông số (mỗi lần đổi thông số là một bộ mới).
CREATE TABLE IF NOT EXISTS strat_vers (
  strategy TEXT NOT NULL, symbol TEXT NOT NULL, ver TEXT NOT NULL, params TEXT NOT NULL, created_at INTEGER,
  PRIMARY KEY (strategy, symbol, ver)
);

-- ===== Quy đổi R, phí, MAE/MFE, nhật ký tín hiệu =====
ALTER TABLE trades ADD COLUMN fee REAL;   -- phí $ mỗi lệnh (1 lot) lúc vào lệnh
ALTER TABLE trades ADD COLUMN pv REAL;    -- $ cho 1 đơn vị giá, 1 lot (hợp đồng CME)
ALTER TABLE trades ADD COLUMN mae REAL;   -- đi ngược nhiều nhất (theo giá)
ALTER TABLE trades ADD COLUMN mfe REAL;   -- đi thuận nhiều nhất (theo giá)
-- Phí từng mã (mặc định $40/lệnh).
CREATE TABLE IF NOT EXISTS sym_cfg (symbol TEXT PRIMARY KEY, fee REAL);
-- Nhật ký tín hiệu bất biến: ghi một lần, không sửa, không xóa (trigger chặn).
CREATE TABLE IF NOT EXISTS siglog (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL, ver TEXT,
  side TEXT NOT NULL, entry REAL, sl REAL, tp REAL, risk REAL, pv REAL, fee REAL,
  session TEXT, regime TEXT, adx REAL, blocked INTEGER NOT NULL DEFAULT 0, trade_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_siglog_sym ON siglog (symbol, t);
CREATE TRIGGER IF NOT EXISTS siglog_no_update BEFORE UPDATE ON siglog BEGIN SELECT RAISE(ABORT, 'siglog bất biến'); END;
CREATE TRIGGER IF NOT EXISTS siglog_no_delete BEFORE DELETE ON siglog BEGIN SELECT RAISE(ABORT, 'siglog bất biến'); END;
CREATE INDEX IF NOT EXISTS idx_trades_sym ON trades (symbol, status, closed_at);
