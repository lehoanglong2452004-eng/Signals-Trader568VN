// Signals Trader568VN – bộ nhận alert TradingView và API cho terminal.
// Chạy trên Cloudflare Workers, lưu dữ liệu trong D1.

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

async function makeToken(env) {
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return exp + "." + (await hmac(env.SESSION_SECRET, exp));
}

async function isAuthed(env, req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
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

async function webhook(env, req, url) {
  const raw = await req.text();
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Nội dung alert không phải JSON hợp lệ" }, 400); }
  const key = url.searchParams.get("key") || String(body.key || "");
  if (!safeEqual(key, env.WEBHOOK_KEY || "")) return json({ error: "Sai khóa webhook" }, 401);

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
        if (!safeEqual(String(password || ""), env.VIEW_PASSWORD)) return json({ error: "Sai mật khẩu" }, 401, cors);
        return json({ token: await makeToken(env) }, 200, cors);
      }

      if (url.pathname === "/api/trades" && req.method === "GET") {
        if (!(await isAuthed(env, req))) return json({ error: "Cần đăng nhập" }, 401, cors);
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 90));
        const since = Date.now() - days * 24 * 3600 * 1000;
        const { results } = await env.DB.prepare(
          `SELECT id, strategy, symbol, side, status, entry, sl, tp, exit_price, result, created_at, opened_at, closed_at
           FROM trades WHERE created_at >= ? OR status IN ('open', 'pending') ORDER BY id`
        ).bind(since).all();
        return json({ trades: results }, 200, cors);
      }

      return json({ error: "Không tìm thấy" }, 404, cors);
    } catch (e) {
      return json({ error: "Lỗi máy chủ: " + e.message }, 500, cors);
    }
  },
};
