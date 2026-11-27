// Signals Trader568VN – bộ nhận alert TradingView và API cho terminal.
// Chạy trên Cloudflare Workers, lưu dữ liệu trong D1.

import { STRATEGIES } from "./strategies.js";
import { INDICATORS, indParams } from "./indicators.js";

const enc = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(env, req) {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin) && !allowed.includes("*")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Token: hạn.vai_trò.chữ_ký. Vai trò "admin" được chỉnh thông số chiến lược, "view" chỉ xem.
async function makeToken(env, role) {
  const head = String(Date.now() + 7 * 24 * 3600 * 1000) + "." + role;
  return head + "." + (await hmac(env.SESSION_SECRET, head));
}

async function isAuthed(env, req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, role, sig] = token.split(".");
  if (!exp || !role || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp + "." + role)) ? role : false;
}

const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
const toMs = (v) => {
  if (v === undefined || v === null || v === "") return Date.now();
  if (typeof v === "number" || /^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return isNaN(t) ? Date.now() : t;
};

// Tìm lệnh cần cập nhật: ưu tiên id do alert gửi, nếu không có thì lấy lệnh mới nhất cùng chiến lược + mã.
async function findTrade(env, a, statuses) {
  const marks = statuses.map(() => "?").join(",");
  if (a.id) {
    const row = await env.DB.prepare(
      `SELECT * FROM trades WHERE ext_id = ? AND strategy = ? AND status IN (${marks}) ORDER BY id DESC LIMIT 1`
    ).bind(a.id, a.strategy, ...statuses).first();
    if (row) return row;
  }
  return env.DB.prepare(
    `SELECT * FROM trades WHERE strategy = ? AND symbol = ? AND status IN (${marks}) ORDER BY id DESC LIMIT 1`
  ).bind(a.strategy, a.symbol, ...statuses).first();
}

async function handleAlert(env, a) {
  const ts = toMs(a.time);
  const side = String(a.side || "").toLowerCase();
  switch (a.event) {
    case "entry":
    case "pending": {
      if (side !== "buy" && side !== "sell") return { ok: false, status: 400, error: "side phải là buy hoặc sell" };
      const status = a.event === "entry" ? "open" : "pending";
      await env.DB.prepare(
        `INSERT INTO trades (ext_id, strategy, symbol, side, status, entry, sl, tp, created_at, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(a.id || null, a.strategy, a.symbol, side, status, num(a.price), num(a.sl), num(a.tp), ts, status === "open" ? ts : null).run();
      return { ok: true, outcome: status };
    }
    case "fill": {
      const t = await findTrade(env, a, ["pending"]);
      if (!t) return { ok: false, status: 404, error: "Không có lệnh chờ để khớp" };
      await env.DB.prepare(`UPDATE trades SET status = 'open', opened_at = ?, entry = COALESCE(?, entry) WHERE id = ?`)
        .bind(ts, num(a.price), t.id).run();
      return { ok: true, outcome: "filled" };
    }
    case "cancel": {
      const t = await findTrade(env, a, ["pending"]);
      if (!t) return { ok: false, status: 404, error: "Không có lệnh chờ để hủy" };
      await env.DB.prepare(`UPDATE trades SET status = 'cancelled', closed_at = ? WHERE id = ?`).bind(ts, t.id).run();
      return { ok: true, outcome: "cancelled" };
    }
    case "update": {
      const t = await findTrade(env, a, ["open", "pending"]);
      if (!t) return { ok: false, status: 404, error: "Không có lệnh để cập nhật SL/TP" };
      await env.DB.prepare(`UPDATE trades SET sl = COALESCE(?, sl), tp = COALESCE(?, tp) WHERE id = ?`)
        .bind(num(a.sl), num(a.tp), t.id).run();
      return { ok: true, outcome: "updated" };
    }
    case "tp":
    case "sl":
    case "exit": {
      const t = await findTrade(env, a, ["open"]);
      if (!t) return { ok: false, status: 404, error: "Không có lệnh đang mở để đóng" };
      const price = num(a.price) ?? (a.event === "tp" ? t.tp : a.event === "sl" ? t.sl : null);
      if (price === null) return { ok: false, status: 400, error: "Thiếu giá đóng lệnh (price)" };
      await env.DB.prepare(`UPDATE trades SET status = 'closed', exit_price = ?, result = ?, closed_at = ? WHERE id = ?`)
        .bind(price, a.event, ts, t.id).run();
      return { ok: true, outcome: "closed:" + a.event };
    }
    default:
      return { ok: false, status: 400, error: "event không hợp lệ: " + a.event };
  }
}

// Giá: chỉ báo "gia-realtime.pine" bắn mỗi nến 1 phút đã đóng.
// bars: [[t, o, h, l, c, v], ...] (t tính bằng ms), hoặc một nến lẻ qua t/o/h/l/c/v.
async function saveBars(env, body) {
  const symbol = String(body.symbol || "").trim().toUpperCase();
  if (!symbol) return json({ error: "Thiếu symbol" }, 400);
  let rows = Array.isArray(body.bars) ? body.bars : [[body.t, body.o, body.h, body.l, body.c, body.v]];
  rows = rows.map((r) => r.map(num)).filter((r) => r[0] !== null && r[4] !== null).slice(-500);
  if (!rows.length) return json({ error: "Không có nến hợp lệ" }, 400);
  rows = rows.map((r) => [r[0], r[1] ?? r[4], r[2] ?? r[4], r[3] ?? r[4], r[4], r[5] ?? 0]).sort((a, b) => a[0] - b[0]);
  const batch = [env.DB.prepare(
    `INSERT INTO bars (symbol, t, o, h, l, c, v)
     SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
     FROM json_each(?) WHERE true
     ON CONFLICT(symbol, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`
  ).bind(symbol, JSON.stringify(rows))];
  // Giá cuối, khối lượng trong ngày (dv) và giá đóng cửa hôm trước (pc) do Pine gửi kèm.
  const last = rows[rows.length - 1];
  batch.push(env.DB.prepare(
    `INSERT INTO quotes (symbol, t, c, dv, pc) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET t = excluded.t, c = excluded.c, dv = COALESCE(excluded.dv, quotes.dv), pc = COALESCE(excluded.pc, quotes.pc)
     WHERE excluded.t >= quotes.t`
  ).bind(symbol, last[0], last[4], num(body.dv), num(body.pc)));
  // Giữ 10 ngày nến 1 phút cho mỗi mã.
  batch.push(env.DB.prepare(`DELETE FROM bars WHERE symbol = ? AND t < ?`).bind(symbol, Date.now() - 10 * 24 * 3600 * 1000));
  await env.DB.batch(batch);
  let eng = "";
  try { eng = await runEngine(env, symbol, rows); } catch (e) { eng = " engine-error: " + e.message; }
  return json({ ok: true, outcome: "bars:" + rows.length + eng });
}

// ---------------- Bộ máy chiến lược chạy trên máy chủ ----------------
// Logic từng chiến lược nằm trong strategies.js (riêng tư). Ở đây chỉ gộp nến, gọi chiến lược và quản lý lệnh.

function stratParams(id, raw) {
  const p = {};
  for (const d of STRATEGIES[id].params) {
    let v = raw && raw[d.k] !== undefined && raw[d.k] !== null && raw[d.k] !== "" ? Number(raw[d.k]) : d.v;
    if (!Number.isFinite(v)) v = d.v;
    if (d.options) { if (!d.options.includes(v)) v = d.v; }
    else { v = Math.min(d.max, Math.max(d.min, v)); if (d.step >= 1) v = Math.round(v); }
    p[d.k] = v;
  }
  return p;
}

async function verOf(id, p) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(id + JSON.stringify(p))));
  return "v" + [...h.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadCfgs(env, symbol) {
  const { results } = await env.DB.prepare(`SELECT strategy, params, enabled FROM strat_cfg WHERE symbol = ?`).bind(symbol).all();
  const rows = Object.fromEntries(results.map((r) => [r.strategy, r]));
  const out = [];
  for (const id of Object.keys(STRATEGIES)) {
    const r = rows[id], p = stratParams(id, r ? JSON.parse(r.params || "{}") : null);
    out.push({ id, p, ver: await verOf(id, p), enabled: r ? !!r.enabled : true });
  }
  return out;
}

function aggregate(src, tf, end) {
  const m = tf * 60000, out = [];
  let cur = null;
  for (const b of src) {
    const k = Math.floor(b.t / m) * m;
    if (k + m > end) break;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
  }
  return out;
}

// ---------------- Quy đổi R, phí, nhật ký tín hiệu ----------------
// Giá trị 1 đơn vị giá cho 1 lot, theo hợp đồng tiêu chuẩn CME (mã CFD quy về hợp đồng CME tương ứng).
const PV = {
  GC: 100, XAU: 100, SI: 5000, XAG: 5000, PL: 50, HG: 25000, CL: 1000, BRN: 1000,
  ZC: 50, ZS: 50, ZW: 50, ZL: 600, ZM: 100, KC: 375, DXY: 1000,
  BTC: 5, ETH: 50, US100: 20, NQ: 20, US500: 50, ES: 50,
  EURUSD: 125000, GBPUSD: 62500, AUDUSD: 100000, NZDUSD: 100000,
};
const DEF_FEE = 40, ACCT = 100000, DAY_LIMIT = 0.05;
function rootKey(symbol) {
  let t = String(symbol || "").toUpperCase();
  t = t.includes(":") ? t.split(":")[1] : t;
  t = t.replace(/\.P$/, "").replace(/[12]!$/, "");
  if (/^(XAU|XAG|BTC|ETH)/.test(t)) return t.slice(0, 3);
  return t;
}
// Đô la cho 1 đơn vị giá, 1 lot. Cặp USD đứng trước (USDJPY…) đổi theo giá hiện tại.
function pointValue(symbol, px) {
  const k = rootKey(symbol);
  if (PV[k]) return PV[k];
  const m = k.match(/^USD(JPY|CHF|CAD)$/);
  if (m && px > 0) return ({ JPY: 12500000, CHF: 125000, CAD: 100000 })[m[1]] / px;
  return 1;
}
async function feeOf(env, symbol) {
  const r = await env.DB.prepare(`SELECT fee FROM sym_cfg WHERE symbol = ?`).bind(symbol).first().catch(() => null);
  return r && Number.isFinite(r.fee) ? r.fee : DEF_FEE;
}
// Ngày giao dịch tính từ 0:00 giờ Prague như FTMO.
function pragueDayStart(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = asUtc - Math.floor(ms / 1000) * 1000;
  return Date.UTC(+p.year, +p.month - 1, +p.day) - off;
}
// Phiên theo giờ Việt Nam: Á 6h–14h, Âu 14h–19h, Mỹ 19h–4h.
function sessionOf(ms) {
  const h = new Date(ms + 7 * 3600000).getUTCHours();
  return h >= 6 && h < 14 ? "Á" : h >= 14 && h < 19 ? "Âu" : h >= 19 || h < 4 ? "Mỹ" : "Ngoài giờ";
}
function adx(bars, n = 14) {
  if (bars.length < n * 2 + 1) return null;
  let tr = 0, pd = 0, md = 0, ax = null, dxs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1], up = b.h - p.h, dn = p.l - b.l;
    const t = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    const P = up > dn && up > 0 ? up : 0, M = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pd += P; md += M; if (i < n) continue; }
    else { tr = tr - tr / n + t; pd = pd - pd / n + P; md = md - md / n + M; }
    const pi = tr ? (100 * pd) / tr : 0, mi = tr ? (100 * md) / tr : 0, dx = pi + mi ? (100 * Math.abs(pi - mi)) / (pi + mi) : 0;
    if (ax === null) { dxs.push(dx); if (dxs.length === n) ax = dxs.reduce((a, c) => a + c, 0) / n; }
    else ax = (ax * (n - 1) + dx) / n;
  }
  return ax;
}

// Số nến khung lớn nạp cho chiến lược: mặc định 450, chiến lược cần lịch sử dài hơn khai báo hist(p).
function histLimit(cfgs, tf) {
  let m = 450;
  for (const c of cfgs) if (c.p.tf === tf && STRATEGIES[c.id] && STRATEGIES[c.id].hist) m = Math.max(m, STRATEGIES[c.id].hist(c.p));
  return Math.min(m, 3000);
}

// Nhớ đệm nến trong isolate để giảm lượt đọc D1 (gói miễn phí chỉ cho 5 triệu dòng/ngày).
// m1: nến 1 phút 10 ngày gần nhất; tf: nến khung lớn. Thiếu đoạn nào thì chỉ đọc bù đúng đoạn đó.
const MEM = new Map();
const D10 = 10 * 86400000;
const toObj = (r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 });
function mergeBars(arr, add, keepFrom, maxN) {
  for (const b of add) {
    const L = arr[arr.length - 1];
    if (L && L.t === b.t) arr[arr.length - 1] = b;
    else if (!L || b.t > L.t) arr.push(b);
    else { const i = arr.findIndex((x) => x.t >= b.t); if (arr[i].t === b.t) arr[i] = b; else arr.splice(i, 0, b); }
  }
  let cut = 0;
  if (keepFrom != null) while (cut < arr.length && arr[cut].t < keepFrom) cut++;
  if (maxN != null) cut = Math.max(cut, arr.length - maxN);
  if (cut > 0) arr.splice(0, cut);
}
async function m1Of(env, symbol, end) {
  let m = MEM.get(symbol);
  if (!m) { m = { m1: null, tf: new Map() }; MEM.set(symbol, m); }
  if (!m.m1) {
    m.m1 = (await env.DB.prepare(`SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t`).bind(symbol, end - D10, end).all()).results;
    m.m1End = end;
  } else if (end > m.m1End) {
    const add = (await env.DB.prepare(`SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t`).bind(symbol, m.m1End - 60000, end).all()).results;
    mergeBars(m.m1, add, end - D10);
    m.m1End = end;
  }
  return m;
}

async function runEngine(env, symbol, rows) {
  if (globalThis.__T568_NOCACHE) MEM.clear();
  const cfgs = (await loadCfgs(env, symbol)).filter((c) => c.enabled);
  const ops = [], notes = [];
  const { results: open } = await env.DB.prepare(
    `SELECT * FROM trades WHERE symbol = ? AND status = 'open' AND ver IS NOT NULL`
  ).bind(symbol).all();

  // 1) Theo dõi SL / TP / hòa vốn, MAE/MFE và giới hạn lỗ ngày trên từng nến 1 phút.
  const lastPx = rows[rows.length - 1][4], fee = await feeOf(env, symbol), pvNow = pointValue(symbol, lastPx);
  const day0 = pragueDayStart(rows[rows.length - 1][0]), dayPl = {};
  const { results: dr } = await env.DB.prepare(
    `SELECT strategy, SUM((exit_price - entry) * (CASE side WHEN 'buy' THEN 1 ELSE -1 END) * COALESCE(pv, ?) - COALESCE(fee, ?)) pl
     FROM trades WHERE symbol = ? AND status = 'closed' AND ver IS NOT NULL AND closed_at >= ? GROUP BY strategy`
  ).bind(pvNow, fee, symbol, day0).all();
  for (const r of dr) dayPl[r.strategy] = r.pl || 0;
  const lim = ACCT * DAY_LIMIT;
  for (const t of open) {
    const meta = JSON.parse(t.meta || "{}"), buy = t.side === "buy", dir = buy ? 1 : -1;
    const pv = t.pv || pvNow, tf = t.fee != null ? t.fee : fee;
    let sl = t.sl, mae = t.mae || 0, mfe = t.mfe || 0;
    // Giá mà tại đó lỗ trong ngày (đã chốt + đang mở, sau phí) chạm 5% vốn.
    const limPx = t.entry - dir * (lim + (dayPl[t.strategy] || 0) - tf) / pv;
    for (const [bt, , h, l] of rows) {
      if (bt < t.opened_at) continue;
      const hitSL = sl !== null && (buy ? l <= sl : h >= sl), hitTP = t.tp !== null && (buy ? h >= t.tp : l <= t.tp);
      const hitDL = buy ? l <= limPx : h >= limPx;
      const advX = buy ? t.entry - l : h - t.entry, favX = buy ? h - t.entry : t.entry - l;
      if (hitSL || hitTP || hitDL) {
        // Nến chạm mức: ưu tiên SL, rồi giới hạn ngày (nếu tới trước SL), rồi TP.
        const slDist = sl !== null ? (t.entry - sl) * dir : Infinity, dlDist = (t.entry - limPx) * dir;
        let res, px;
        if (hitDL && (!hitSL || dlDist < slDist)) { res = "dl"; px = limPx; }
        else if (hitSL) { res = "sl"; px = sl; }
        else { res = "tp"; px = t.tp; }
        // Nến đóng lệnh: đi ngược tối đa tới giá thoát (SL / giới hạn ngày), đi thuận tối đa tới TP.
        if (res === "tp") mfe = Math.max(mfe, (t.tp - t.entry) * dir);
        else { mae = Math.max(mae, Math.min(advX, (t.entry - px) * dir)); mfe = Math.max(mfe, favX); }
        ops.push(env.DB.prepare(`UPDATE trades SET status = 'closed', exit_price = ?, result = ?, closed_at = ?, sl = ?, mae = ?, mfe = ? WHERE id = ? AND status = 'open'`)
          .bind(px, res, bt + 60000, sl, mae, mfe, t.id));
        t.closed = true; notes.push(t.strategy + ":" + res);
        dayPl[t.strategy] = (dayPl[t.strategy] || 0) + (px - t.entry) * dir * pv - tf;
        break;
      }
      mae = Math.max(mae, advX); mfe = Math.max(mfe, favX);
      const beLvl = meta.beAt != null ? meta.beAt : meta.risk ? (buy ? t.entry + meta.risk : t.entry - meta.risk) : null;
      if (meta.be && !meta.moved && beLvl != null && (buy ? h >= beLvl : l <= beLvl)) {
        sl = t.entry; meta.moved = 1;
        ops.push(env.DB.prepare(`UPDATE trades SET sl = ?, meta = ? WHERE id = ?`).bind(sl, JSON.stringify(meta), t.id));
      }
    }
    if (!t.closed && (mae !== (t.mae || 0) || mfe !== (t.mfe || 0))) ops.push(env.DB.prepare(`UPDATE trades SET mae = ?, mfe = ? WHERE id = ?`).bind(mae, mfe, t.id));
    t.sl = sl;
  }

  // 2) Gộp nến 1 phút thành nến khung lớn khi một nến khung lớn vừa đóng (hoặc khi nhận lịch sử).
  const end = rows[rows.length - 1][0] + 60000;
  const tfs = [...new Set(cfgs.map((c) => c.p.tf))];
  const closing = tfs.filter((tf) => end % (tf * 60000) === 0);
  const rebuild = rows.length > 3 ? tfs : closing;
  if (rows.length > 3) MEM.delete(symbol); // nhận lịch sử: bỏ nhớ đệm, đọc lại từ đầu
  const mem = await m1Of(env, symbol, end);
  if (rebuild.length) {
    const big = Math.max(...rebuild) * 60000, from = Math.floor(rows[0][0] / big) * big;
    const src = mem.m1.length && mem.m1[0].t <= from ? mem.m1.filter((b) => b.t >= from)
      : (await env.DB.prepare(`SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t`).bind(symbol, from, end).all()).results;
    for (const tf of rebuild) {
      const aggO = aggregate(src, tf, end), agg = aggO.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
      if (!agg.length) continue;
      const tc = mem.tf.get(tf);
      if (tc) { if (tc.bars.length && tc.bars[tc.bars.length - 1].t < aggO[0].t - tf * 60000) mem.tf.delete(tf); else mergeBars(tc.bars, aggO, null, tc.n); }
      ops.push(env.DB.prepare(
        `INSERT INTO tfbars (symbol, tf, t, o, h, l, c, v)
         SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
         FROM json_each(?) WHERE true
         ON CONFLICT(symbol, tf, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`
      ).bind(symbol, tf, JSON.stringify(agg)));
    }
    if (ops.length) { await env.DB.batch(ops); ops.length = 0; }
  }

  // 3) Chạy chiến lược trên nến khung lớn vừa đóng.
  // Chiến lược dựa trên chỉ báo độc quyền cần nến 1 phút (10 ngày) để tự dựng các khung.
  const getSrc = async () => mem.m1.slice();
  let ctx = null;
  for (const tf of closing) {
    const need = histLimit(cfgs, tf);
    let tc = mem.tf.get(tf);
    if (!tc || tc.n < need) {
      const { results } = await env.DB.prepare(`SELECT t, o, h, l, c, v FROM tfbars WHERE symbol = ? AND tf = ? ORDER BY t DESC LIMIT ?`).bind(symbol, tf, need).all();
      tc = { n: need, bars: results.reverse() };
      mem.tf.set(tf, tc);
    }
    const bars = tc.bars.length > need ? tc.bars.slice(-need) : tc.bars.slice();
    if (!bars.length || bars[bars.length - 1].t + tf * 60000 !== end) continue;
    for (const c of cfgs.filter((x) => x.p.tf === tf)) {
      const S = STRATEGIES[c.id];
      if (bars.length < S.need(c.p)) continue;
      let out = {};
      try { out = S.run(bars, c.p, S.src ? { src: await getSrc(), end, symbol } : undefined) || {}; } catch (e) { notes.push(c.id + ":err"); continue; }
      const px = bars[bars.length - 1].c;
      let cur = open.find((t) => t.strategy === c.id && !t.closed);
      if (cur) {
        const buy = cur.side === "buy";
        if ((buy && (out.exitBuy || out.entry?.side === "sell")) || (!buy && (out.exitSell || out.entry?.side === "buy"))) {
          ops.push(env.DB.prepare(`UPDATE trades SET status = 'closed', exit_price = ?, result = 'exit', closed_at = ? WHERE id = ? AND status = 'open'`).bind(px, end, cur.id));
          dayPl[c.id] = (dayPl[c.id] || 0) + (px - cur.entry) * (buy ? 1 : -1) * (cur.pv || pvNow) - (cur.fee != null ? cur.fee : fee);
          cur.closed = true; cur = null; notes.push(c.id + ":exit");
        }
      }
      const e = out.entry;
      if (!cur && e && Number.isFinite(e.sl) && Number.isFinite(e.tp) && (e.side === "buy" ? e.sl < px && e.tp > px : e.sl > px && e.tp < px)) {
        const meta = { be: out.be ? 1 : 0, risk: Math.abs(px - e.sl) };
        if (e.beAt != null && Number.isFinite(e.beAt)) meta.beAt = e.beAt;
        const pv = pointValue(symbol, px);
        // Bối cảnh lúc phát: phiên + trạng thái thị trường theo ADX14 khung H1 (ghi ngay, không gắn lại sau).
        if (!ctx) {
          const { results: h1 } = await env.DB.prepare(`SELECT t, o, h, l, c FROM tfbars WHERE symbol = ? AND tf = 60 AND t < ? ORDER BY t DESC LIMIT 150`).bind(symbol, end).all();
          const a = adx(h1.reverse());
          ctx = { adx: a, regime: a == null ? null : a > 25 ? "Xu hướng" : "Đi ngang" };
        }
        // Giới hạn lỗ 5%/ngày tính riêng từng chiến lược: đã chạm thì tín hiệu vẫn ghi log nhưng không vào lệnh.
        const blocked = (dayPl[c.id] || 0) <= -ACCT * DAY_LIMIT ? 1 : 0;
        if (!blocked) {
          ops.push(env.DB.prepare(
            `INSERT INTO trades (ext_id, strategy, symbol, side, status, entry, sl, tp, created_at, opened_at, ver, meta, fee, pv, mae, mfe)
             SELECT NULL, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0
             WHERE NOT EXISTS (SELECT 1 FROM trades WHERE strategy = ? AND symbol = ? AND created_at = ?)`
          ).bind(c.id, symbol, e.side, px, e.sl, e.tp, end, end, c.ver, JSON.stringify(meta), fee, pv, c.id, symbol, end));
        }
        ops.push(env.DB.prepare(
          `INSERT INTO siglog (t, symbol, strategy, ver, side, entry, sl, tp, risk, pv, fee, session, regime, adx, blocked, trade_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM trades WHERE strategy = ? AND symbol = ? AND created_at = ? AND ? = 0)
           WHERE NOT EXISTS (SELECT 1 FROM siglog WHERE strategy = ? AND symbol = ? AND t = ?)`
        ).bind(end, symbol, c.id, c.ver, e.side, px, e.sl, e.tp, meta.risk, pv, fee, sessionOf(end), ctx.regime, ctx.adx, blocked,
          c.id, symbol, end, blocked, c.id, symbol, end));
        ops.push(env.DB.prepare(`INSERT OR IGNORE INTO strat_vers (strategy, symbol, ver, params, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(c.id, symbol, c.ver, JSON.stringify(c.p), Date.now()));
        notes.push(c.id + ":" + e.side + (blocked ? ":blocked" : ""));
      }
    }
  }
  if (ops.length) await env.DB.batch(ops);
  return notes.length ? " " + notes.join(",") : "";
}

async function webhook(env, req, url) {
  const raw = await req.text();
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Nội dung alert không phải JSON hợp lệ" }, 400); }
  const key = url.searchParams.get("key") || String(body.key || "");
  if (!safeEqual(key, env.WEBHOOK_KEY || "")) return json({ error: "Sai khóa webhook" }, 401);

  if (String(body.event || "").toLowerCase() === "bar") return await saveBars(env, body);

  const a = {
    event: String(body.event || "").toLowerCase(),
    strategy: String(body.strategy || "").trim(),
    symbol: String(body.symbol || "").trim().toUpperCase(),
    side: body.side, price: body.price, sl: body.sl, tp: body.tp, time: body.time,
    id: body.id !== undefined && body.id !== null && body.id !== "" ? String(body.id) : null,
  };
  if (!a.strategy || !a.symbol) return json({ error: "Thiếu strategy hoặc symbol" }, 400);

  delete body.key;
  const res = await handleAlert(env, a);
  await env.DB.prepare(`INSERT INTO alerts (received_at, body, outcome) VALUES (?, ?, ?)`)
    .bind(Date.now(), JSON.stringify(body), res.ok ? res.outcome : "error: " + res.error).run();
  return res.ok ? json({ ok: true, outcome: res.outcome }) : json({ error: res.error }, res.status);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/webhook" && req.method === "POST") return await webhook(env, req, url);

      if (url.pathname === "/api/health") return json({ ok: true, time: Date.now() }, 200, cors);

      if (url.pathname === "/api/login" && req.method === "POST") {
        const { password } = await req.json().catch(() => ({}));
        if (!env.VIEW_PASSWORD || !env.SESSION_SECRET) return json({ error: "Máy chủ chưa đặt mật khẩu" }, 500, cors);
        const pw = String(password || "");
        // Có ADMIN_PASSWORD: mật khẩu đó được chỉnh thông số, VIEW_PASSWORD chỉ xem. Chưa có: VIEW_PASSWORD được toàn quyền.
        let role = null;
        if (env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD)) role = "admin";
        else if (safeEqual(pw, env.VIEW_PASSWORD)) role = env.ADMIN_PASSWORD ? "view" : "admin";
        if (!role) return json({ error: "Sai mật khẩu" }, 401, cors);
        return json({ token: await makeToken(env, role), role }, 200, cors);
      }

      if (url.pathname === "/api/trades" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 90));
        const since = Date.now() - days * 24 * 3600 * 1000;
        const { results } = await env.DB.prepare(
          `SELECT id, strategy, symbol, side, status, entry, sl, tp, exit_price, result, created_at, opened_at, closed_at, ver,
             json_extract(meta, '$.risk') risk, fee, pv, mae, mfe
           FROM trades WHERE created_at >= ? OR status IN ('open', 'pending') ORDER BY id`
        ).bind(since).all();
        return json({ trades: results }, 200, cors);
      }

      // Nhật ký tín hiệu bất biến (chỉ ghi thêm, không sửa, không xóa).
      if (url.pathname === "/api/siglog" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
        const { results } = await env.DB.prepare(
          `SELECT id, t, symbol, strategy, ver, side, entry, sl, tp, risk, pv, fee, session, regime, adx, blocked, trade_id
           FROM siglog WHERE (? = '' OR symbol = ?) ORDER BY id DESC LIMIT 2000`
        ).bind(symbol, symbol).all();
        return json({ log: results }, 200, cors);
      }

      // Giá trị 1 điểm (hợp đồng CME) và phí mỗi lệnh của từng mã. Chỉ quản trị đổi được phí.
      if (url.pathname === "/api/spec" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const { results: q } = await env.DB.prepare(`SELECT symbol, c FROM quotes`).all();
        const { results: f } = await env.DB.prepare(`SELECT symbol, fee FROM sym_cfg`).all();
        const fees = Object.fromEntries(f.map((r) => [r.symbol, r.fee])), spec = {};
        for (const r of q) spec[r.symbol] = { pv: pointValue(r.symbol, r.c), fee: fees[r.symbol] ?? DEF_FEE };
        return json({ spec, defFee: DEF_FEE, acct: ACCT, dayLimit: DAY_LIMIT }, 200, cors);
      }
      if (url.pathname === "/api/spec" && req.method === "POST") {
        const role = await isAuthed(env, req);
        if (role !== "admin") return json({ error: "Chỉ quản trị mới được chỉnh phí" }, 403, cors);
        const b = await req.json().catch(() => ({}));
        const symbol = String(b.symbol || "").toUpperCase(), fee = Number(b.fee);
        if (!symbol || !Number.isFinite(fee) || fee < 0 || fee > 10000) return json({ error: "Phí không hợp lệ" }, 400, cors);
        await env.DB.prepare(`INSERT INTO sym_cfg (symbol, fee) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET fee = excluded.fee`).bind(symbol, fee).run();
        return json({ ok: true, symbol, fee }, 200, cors);
      }

      if (url.pathname === "/api/bars" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
        const limit = Math.min(15000, Math.max(10, Number(url.searchParams.get("limit")) || 3000));
        const since = Number(url.searchParams.get("since")) || 0;
        const { results } = await env.DB.prepare(
          `SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND t >= ? ORDER BY t DESC LIMIT ?`
        ).bind(symbol, since, limit).all();
        return json({ symbol, bars: results.reverse().map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]) }, 200, cors);
      }

      if (url.pathname === "/api/quotes" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const syms = String(url.searchParams.get("symbols") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
        const quotes = {};
        // symbols=* trả về mọi mã đang có giá gửi về.
        if (syms.length) {
          const all = syms.includes("*");
          const { results } = await (all
            ? env.DB.prepare(`SELECT symbol, t, c, dv, pc FROM quotes`)
            : env.DB.prepare(`SELECT symbol, t, c, dv, pc FROM quotes WHERE symbol IN (${syms.map(() => "?").join(",")})`).bind(...syms)
          ).all();
          for (const q of results) quotes[q.symbol] = { t: q.t, c: q.c, dv: q.dv, pc: q.pc };
        }
        return json({ quotes }, 200, cors);
      }

      if (url.pathname === "/api/strategies" && req.method === "GET") {
        const role = await isAuthed(env, req);
        if (!role) return json({ error: "Cần đăng nhập" }, 401, cors);
        const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
        const cfgs = await loadCfgs(env, symbol);
        const have = {};
        for (const tf of [...new Set(cfgs.map((c) => c.p.tf))]) {
          const r = await env.DB.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM tfbars WHERE symbol = ? AND tf = ? LIMIT ?)`).bind(symbol, tf, histLimit(cfgs, tf)).first();
          have[tf] = r ? r.n : 0;
        }
        const { results: vers } = await env.DB.prepare(`SELECT strategy, ver, params, created_at FROM strat_vers WHERE symbol = ? ORDER BY created_at`).bind(symbol).all();
        const admin = role === "admin";
        const strategies = cfgs.map((c) => {
          const S = STRATEGIES[c.id];
          // Người xem (view) chỉ thấy tên, bộ thông số và tiến độ khởi động; logic và thông số chỉ quản trị thấy.
          if (!admin) return {
            id: c.id, name: S.name, ver: c.ver, enabled: c.enabled, warm: { tf: c.p.tf, have: have[c.p.tf] || 0, need: S.need(c.p) },
            vers: vers.filter((v) => v.strategy === c.id).map((v) => ({ ver: v.ver, created_at: v.created_at })),
          };
          return {
            id: c.id, name: S.name, ver: c.ver, enabled: c.enabled, logic: S.describe(c.p),
            params: S.params.map((d) => ({ ...d, v: c.p[d.k], def: d.v })),
            warm: { tf: c.p.tf, have: have[c.p.tf] || 0, need: S.need(c.p) },
            vers: vers.filter((v) => v.strategy === c.id).map((v) => ({ ver: v.ver, params: JSON.parse(v.params), created_at: v.created_at })),
          };
        });
        return json({ role, symbol, strategies }, 200, cors);
      }

      if (url.pathname === "/api/strategies" && req.method === "POST") {
        const role = await isAuthed(env, req);
        if (!role) return json({ error: "Cần đăng nhập" }, 401, cors);
        if (role !== "admin") return json({ error: "Chỉ quản trị mới được chỉnh thông số" }, 403, cors);
        const b = await req.json().catch(() => ({}));
        const id = String(b.strategy || ""), symbol = String(b.symbol || "").toUpperCase();
        if (!STRATEGIES[id] || !symbol) return json({ error: "Thiếu chiến lược hoặc mã" }, 400, cors);
        const p = stratParams(id, b.params || {}), ver = await verOf(id, p), enabled = b.enabled === false ? 0 : 1;
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO strat_cfg (strategy, symbol, params, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(strategy, symbol) DO UPDATE SET params = excluded.params, enabled = excluded.enabled, updated_at = excluded.updated_at`)
            .bind(id, symbol, JSON.stringify(p), enabled, Date.now()),
          env.DB.prepare(`INSERT OR IGNORE INTO strat_vers (strategy, symbol, ver, params, created_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(id, symbol, ver, JSON.stringify(p), Date.now()),
        ]);
        return json({ ok: true, ver, params: p }, 200, cors);
      }

      // Chỉ báo độc quyền: máy chủ tính, trình duyệt chỉ nhận hình vẽ sẵn
      if (url.pathname === "/api/indicators" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const TFS = [60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400, 604800, 2592000];
        const list = Object.entries(INDICATORS).map(([id, I]) => ({
          id, name: I.name, short: I.short, params: I.params.filter((d) => !(I.hide || []).includes(d.k)),
          needs: Object.fromEntries(TFS.map((s) => [s, I.needs(indParams(id, {}), s)])),
        }));
        return json({ indicators: list }, 200, cors);
      }

      if (url.pathname === "/api/ind" && req.method === "POST") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const b = await req.json().catch(() => ({}));
        const I = INDICATORS[b.id];
        if (!I) return json({ error: "Không có chỉ báo này" }, 400, cors);
        const toBars = (a, max) => (Array.isArray(a) ? a.slice(-max) : []).map((x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] || 0 }));
        const htf = {};
        for (const k of ["5", "15", "60", "240", "D", "W"]) if (b.htf && b.htf[k]) htf[k] = toBars(b.htf[k], 2500);
        const ctx = {
          bars: toBars(b.bars, 4000), htf, tfSec: Math.max(60, Number(b.tfSec) || 900), mintick: Number(b.mintick) || 0.01,
          dec: Math.max(0, Math.min(8, Number(b.dec) || 2)), lastClosed: !!b.lastClosed, symbol: String(b.symbol || ""), tf: String(b.tf || ""),
        };
        const out = I.run(ctx, indParams(b.id, b.p || {}));
        return json(out, 200, cors);
      }

      return json({ error: "Không tìm thấy" }, 404, cors);
    } catch (e) {
      return json({ error: "Lỗi máy chủ: " + e.message }, 500, cors);
    }
  },
};
