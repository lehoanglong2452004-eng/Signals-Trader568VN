// Signals Trader568VN – bộ nhận alert TradingView và API cho terminal.
// Chạy trên Cloudflare Workers, lưu dữ liệu trong D1.

import { STRATEGIES } from "./strategies.js";

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

async function runEngine(env, symbol, rows) {
  const cfgs = (await loadCfgs(env, symbol)).filter((c) => c.enabled);
  const ops = [], notes = [];
  const { results: open } = await env.DB.prepare(
    `SELECT * FROM trades WHERE symbol = ? AND status = 'open' AND ver IS NOT NULL`
  ).bind(symbol).all();

  // 1) Theo dõi SL / TP / hòa vốn trên từng nến 1 phút.
  for (const t of open) {
    const meta = JSON.parse(t.meta || "{}"), buy = t.side === "buy";
    let sl = t.sl;
    for (const [bt, , h, l] of rows) {
      if (bt < t.opened_at) continue;
      const hitSL = sl !== null && (buy ? l <= sl : h >= sl), hitTP = t.tp !== null && (buy ? h >= t.tp : l <= t.tp);
      if (hitSL || hitTP) {
        ops.push(env.DB.prepare(`UPDATE trades SET status = 'closed', exit_price = ?, result = ?, closed_at = ?, sl = ? WHERE id = ? AND status = 'open'`)
          .bind(hitSL ? sl : t.tp, hitSL ? "sl" : "tp", bt + 60000, sl, t.id));
        t.closed = true; notes.push(t.strategy + ":" + (hitSL ? "sl" : "tp"));
        break;
      }
      if (meta.be && !meta.moved && meta.risk && (buy ? h >= t.entry + meta.risk : l <= t.entry - meta.risk)) {
        sl = t.entry; meta.moved = 1;
        ops.push(env.DB.prepare(`UPDATE trades SET sl = ?, meta = ? WHERE id = ?`).bind(sl, JSON.stringify(meta), t.id));
      }
    }
    t.sl = sl;
  }

  // 2) Gộp nến 1 phút thành nến khung lớn khi một nến khung lớn vừa đóng (hoặc khi nhận lịch sử).
  const end = rows[rows.length - 1][0] + 60000;
  const tfs = [...new Set(cfgs.map((c) => c.p.tf))];
  const closing = tfs.filter((tf) => end % (tf * 60000) === 0);
  const rebuild = rows.length > 3 ? tfs : closing;
  if (rebuild.length) {
    const big = Math.max(...rebuild) * 60000, from = Math.floor(rows[0][0] / big) * big;
    const { results: src } = await env.DB.prepare(`SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t`).bind(symbol, from, end).all();
    for (const tf of rebuild) {
      const agg = aggregate(src, tf, end).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
      if (!agg.length) continue;
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
  for (const tf of closing) {
    const { results } = await env.DB.prepare(`SELECT t, o, h, l, c, v FROM tfbars WHERE symbol = ? AND tf = ? ORDER BY t DESC LIMIT 450`).bind(symbol, tf).all();
    const bars = results.reverse();
    if (!bars.length || bars[bars.length - 1].t + tf * 60000 !== end) continue;
    for (const c of cfgs.filter((x) => x.p.tf === tf)) {
      const S = STRATEGIES[c.id];
      if (bars.length < S.need(c.p)) continue;
      const out = S.run(bars, c.p) || {}, px = bars[bars.length - 1].c;
      let cur = open.find((t) => t.strategy === c.id && !t.closed);
      if (cur) {
        const buy = cur.side === "buy";
        if ((buy && (out.exitBuy || out.entry?.side === "sell")) || (!buy && (out.exitSell || out.entry?.side === "buy"))) {
          ops.push(env.DB.prepare(`UPDATE trades SET status = 'closed', exit_price = ?, result = 'exit', closed_at = ? WHERE id = ? AND status = 'open'`).bind(px, end, cur.id));
          cur.closed = true; cur = null; notes.push(c.id + ":exit");
        }
      }
      const e = out.entry;
      if (!cur && e && Number.isFinite(e.sl) && Number.isFinite(e.tp) && (e.side === "buy" ? e.sl < px && e.tp > px : e.sl > px && e.tp < px)) {
        const meta = { be: out.be ? 1 : 0, risk: Math.abs(px - e.sl) };
        ops.push(env.DB.prepare(
          `INSERT INTO trades (ext_id, strategy, symbol, side, status, entry, sl, tp, created_at, opened_at, ver, meta)
           SELECT NULL, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM trades WHERE strategy = ? AND symbol = ? AND created_at = ?)`
        ).bind(c.id, symbol, e.side, px, e.sl, e.tp, end, end, c.ver, JSON.stringify(meta), c.id, symbol, end));
        ops.push(env.DB.prepare(`INSERT OR IGNORE INTO strat_vers (strategy, symbol, ver, params, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(c.id, symbol, c.ver, JSON.stringify(c.p), Date.now()));
        notes.push(c.id + ":" + e.side);
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
          `SELECT id, strategy, symbol, side, status, entry, sl, tp, exit_price, result, created_at, opened_at, closed_at, ver
           FROM trades WHERE created_at >= ? OR status IN ('open', 'pending') ORDER BY id`
        ).bind(since).all();
        return json({ trades: results }, 200, cors);
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
          const r = await env.DB.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM tfbars WHERE symbol = ? AND tf = ? LIMIT 450)`).bind(symbol, tf).first();
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

      return json({ error: "Không tìm thấy" }, 404, cors);
    } catch (e) {
      return json({ error: "Lỗi máy chủ: " + e.message }, 500, cors);
    }
  },
};
