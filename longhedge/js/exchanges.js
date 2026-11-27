// LongHedge VN – lấy dữ liệu hợp đồng tương lai vĩnh cửu (perpetual) từ API công khai của các sàn.
// Mọi hàm trả nến dạng { t (ms, giờ mở nến), o, h, l, c, v } xếp từ cũ đến mới.

export const TF_MS = (m) => m * 60000;
export const EX_ORDER = ["binance", "bybit", "okx", "hyperliquid"];

async function req(url, opt = {}) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), opt.timeout || 12000);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Hết thời gian chờ" : e.message);
  } finally { clearTimeout(tm); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => +x;

// Gộp nến nhỏ thành nến lớn (dùng khi sàn không có sẵn khung đó). W tính từ thứ Hai 00:00 UTC.
const W0 = 345600000;
export function aggregate(src, tfMin) {
  const m = TF_MS(tfMin), week = tfMin === 10080, out = [];
  let cur = null;
  for (const b of src) {
    const k = week ? Math.floor((b.t - W0) / m) * m + W0 : Math.floor(b.t / m) * m;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return out;
}
function uniq(bars) {
  bars.sort((a, b) => a.t - b.t);
  const out = [];
  for (const b of bars) { if (out.length && out[out.length - 1].t === b.t) out[out.length - 1] = b; else out.push(b); }
  return out;
}

// ---------------- Binance USDⓈ-M ----------------
const BN = "https://fapi.binance.com";
const BN_TF = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d", 10080: "1w" };
const binance = {
  name: "Binance",
  async bars(sym, tf, count) {
    let out = [], end = null;
    while (out.length < count) {
      const lim = Math.min(1500, count - out.length + 1);
      const u = `${BN}/fapi/v1/klines?symbol=${sym}&interval=${BN_TF[tf]}&limit=${lim}` + (end ? `&endTime=${end}` : "");
      const r = await req(u);
      if (!r.length) break;
      out = r.map((k) => ({ t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) })).concat(out);
      if (r.length < lim) break;
      end = r[0][0] - 1;
    }
    return uniq(out);
  },
  async tickers() {
    const r = await req(`${BN}/fapi/v1/ticker/24hr`), o = {};
    for (const x of r) o[x.symbol] = { p: num(x.lastPrice), ch: num(x.priceChangePercent), qv: num(x.quoteVolume) };
    return o;
  },
  async instruments() {
    const r = await req(`${BN}/fapi/v1/exchangeInfo`);
    return r.symbols.filter((s) => /PERPETUAL/.test(s.contractType) && s.status === "TRADING")
      .map((s) => ({ sym: s.symbol, base: s.baseAsset, quote: s.quoteAsset, kind: s.underlyingType === "COMMODITY" ? "Hàng hóa" : s.underlyingType === "EQUITY" ? "Cổ phiếu" : s.underlyingType === "FX" ? "Ngoại hối" : "Crypto" }));
  },
};

// ---------------- Bybit (linear) ----------------
const BY = "https://api.bybit.com";
const BY_TF = { 1: "1", 5: "5", 15: "15", 30: "30", 60: "60", 240: "240", 1440: "D", 10080: "W" };
const bybit = {
  name: "Bybit",
  async bars(sym, tf, count) {
    let out = [], end = null;
    while (out.length < count) {
      const lim = Math.min(1000, count - out.length + 1);
      const r = await req(`${BY}/v5/market/kline?category=linear&symbol=${sym}&interval=${BY_TF[tf]}&limit=${lim}` + (end ? `&end=${end}` : ""));
      if (r.retCode) throw new Error(r.retMsg || "Bybit lỗi");
      const L = r.result.list || [];
      if (!L.length) break;
      out = L.map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) })).reverse().concat(out);
      if (L.length < lim) break;
      end = num(L[L.length - 1][0]) - 1;
    }
    return uniq(out);
  },
  async tickers() {
    const r = await req(`${BY}/v5/market/tickers?category=linear`), o = {};
    for (const x of r.result.list) o[x.symbol] = { p: num(x.lastPrice), ch: num(x.price24hPcnt) * 100, qv: num(x.turnover24h) };
    return o;
  },
  async instruments() {
    let out = [], cur = "";
    for (let k = 0; k < 5; k++) {
      const r = await req(`${BY}/v5/market/instruments-info?category=linear&limit=1000` + (cur ? `&cursor=${encodeURIComponent(cur)}` : ""));
      out = out.concat(r.result.list);
      cur = r.result.nextPageCursor;
      if (!cur) break;
    }
    return out.filter((s) => s.contractType === "LinearPerpetual" && s.status === "Trading").map((s) => ({ sym: s.symbol, base: s.baseCoin, quote: s.quoteCoin, kind: "Perp" }));
  },
};

// ---------------- OKX (SWAP) ----------------
const OK = "https://www.okx.com";
const OK_TF = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1H", 240: "4H", 1440: "1Dutc", 10080: "1Wutc" };
const okx = {
  name: "OKX",
  async bars(sym, tf, count) {
    const map = (k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[6]) });
    const r = await req(`${OK}/api/v5/market/candles?instId=${sym}&bar=${OK_TF[tf]}&limit=300`);
    if (r.code !== "0") throw new Error(r.msg || "OKX lỗi");
    let out = r.data.map(map).reverse();
    while (out.length < count && out.length) {
      const h = await req(`${OK}/api/v5/market/history-candles?instId=${sym}&bar=${OK_TF[tf]}&limit=100&after=${out[0].t}`);
      if (h.code !== "0" || !h.data.length) break;
      out = h.data.map(map).reverse().concat(out);
      await sleep(110);
    }
    return uniq(out);
  },
  async tickers() {
    const r = await req(`${OK}/api/v5/market/tickers?instType=SWAP`), o = {};
    for (const x of r.data) { const p = num(x.last), op = num(x.open24h); o[x.instId] = { p, ch: op ? (p / op - 1) * 100 : 0, qv: num(x.volCcy24h) * p }; }
    return o;
  },
  async instruments() {
    const r = await req(`${OK}/api/v5/public/instruments?instType=SWAP`);
    return r.data.filter((s) => s.state === "live").map((s) => { const [b, q] = s.instId.split("-"); return { sym: s.instId, base: b, quote: q, kind: "Perp" }; });
  },
};

// ---------------- Hyperliquid (gồm các sàn HIP-3 như xyz:GOLD) ----------------
const HL = "https://api.hyperliquid.xyz/info";
const HL_TF = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d", 10080: "1w" };
const hlPost = (body) => req(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let hlDexes = null;
async function hlDexList() {
  if (!hlDexes) { const d = await hlPost({ type: "perpDexs" }); hlDexes = [""].concat(d.filter(Boolean).map((x) => x.name)); }
  return hlDexes;
}
const hyperliquid = {
  name: "Hyperliquid",
  async bars(sym, tf, count) {
    const now = Date.now(), n = Math.min(count, 5000);
    const r = await hlPost({ type: "candleSnapshot", req: { coin: sym, interval: HL_TF[tf], startTime: now - (n + 2) * TF_MS(tf), endTime: now } });
    return uniq(r.map((k) => ({ t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v) })));
  },
  async tickers() {
    const o = {};
    for (const dex of await hlDexList()) {
      try {
        const [meta, ctx] = await hlPost(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
        meta.universe.forEach((u, i) => { const c = ctx[i]; if (!c) return; const p = num(c.markPx), pd = num(c.prevDayPx); o[u.name] = { p, ch: pd ? (p / pd - 1) * 100 : 0, qv: num(c.dayNtlVlm) }; });
      } catch (e) { /* một sàn con lỗi thì bỏ qua */ }
    }
    return o;
  },
  async instruments() {
    const out = [];
    for (const dex of await hlDexList()) {
      try {
        const m = await hlPost(dex ? { type: "meta", dex } : { type: "meta" });
        for (const u of m.universe) if (!u.isDelisted) out.push({ sym: u.name, base: u.name.replace(/^.*:/, ""), quote: "USD", kind: dex ? "HIP-3 · " + dex : "Perp" });
      } catch (e) { /* bỏ qua */ }
    }
    return out;
  },
};

export const EX = { binance, bybit, okx, hyperliquid };

// Lấy nến; khung sàn không hỗ trợ thì gộp từ khung nhỏ hơn.
export async function getBars(ex, sym, tf, count) {
  return EX[ex].bars(sym, tf, count);
}

// 8 sản phẩm mặc định và mã tương ứng trên từng sàn (null = sàn không có hợp đồng vĩnh cửu).
export const DEFAULT_PRODUCTS = [
  { id: "BTC", label: "Bitcoin", group: "Crypto", map: { binance: "BTCUSDT", bybit: "BTCUSDT", okx: "BTC-USDT-SWAP", hyperliquid: "BTC" } },
  { id: "ETH", label: "Ethereum", group: "Crypto", map: { binance: "ETHUSDT", bybit: "ETHUSDT", okx: "ETH-USDT-SWAP", hyperliquid: "ETH" } },
  { id: "WTI", label: "Dầu WTI", group: "Năng lượng", map: { binance: "CLUSDT", bybit: "CLUSDT", okx: "CL-USDT-SWAP", hyperliquid: "xyz:CL" } },
  { id: "BRENT", label: "Dầu Brent", group: "Năng lượng", map: { binance: "BZUSDT", bybit: "BZUSDT", okx: "BZ-USDT-SWAP", hyperliquid: "xyz:BRENTOIL" } },
  { id: "XAU", label: "Vàng", group: "Kim loại", map: { binance: "XAUUSDT", bybit: "XAUUSDT", okx: "XAU-USDT-SWAP", hyperliquid: "xyz:GOLD" } },
  { id: "XAG", label: "Bạc", group: "Kim loại", map: { binance: "XAGUSDT", bybit: "XAGUSDT", okx: "XAG-USDT-SWAP", hyperliquid: "xyz:SILVER" } },
  { id: "COPPER", label: "Đồng", group: "Kim loại", map: { binance: "COPPERUSDT", bybit: null, okx: "XCU-USDT-SWAP", hyperliquid: "xyz:COPPER" } },
  { id: "XPT", label: "Bạch kim", group: "Kim loại", map: { binance: "XPTUSDT", bybit: null, okx: "XPT-USDT-SWAP", hyperliquid: "xyz:PLATINUM" } },
];
