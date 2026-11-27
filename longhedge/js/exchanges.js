// LongHedge VN – lấy dữ liệu hợp đồng tương lai vĩnh cửu (perpetual) từ API công khai của các sàn.
// Mọi hàm trả nến dạng { t (ms, giờ mở nến), o, h, l, c, v } xếp từ cũ đến mới.
// Coinbase và Kraken chặn gọi thẳng từ trình duyệt (CORS) nên cần một proxy (xem proxy/worker.js).

export const TF_MS = (m) => m * 60000;
export const EX_ORDER = ["binance", "bybit", "okx", "hyperliquid", "coinbase", "kraken"];

let PROXY = "";
export function setProxy(u) { PROXY = String(u || "").trim().replace(/\/+$/, ""); }
export const proxyReady = () => !!PROXY;

async function req(url, opt = {}, viaProxy = false) {
  if (viaProxy) {
    if (!PROXY) throw new Error("Sàn này cần proxy (Cài đặt → Proxy)");
    url = PROXY + "/?u=" + encodeURIComponent(url);
  }
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

// ---------------- Coinbase International (qua proxy) ----------------
const CB = "https://api.coinbase.com/api/v3/brokerage/market";
const CB_TF = { 1: "ONE_MINUTE", 5: "FIVE_MINUTE", 15: "FIFTEEN_MINUTE", 30: "THIRTY_MINUTE", 60: "ONE_HOUR", 1440: "ONE_DAY" };
const coinbase = {
  name: "Coinbase",
  proxy: true,
  async bars(sym, tf, count) {
    if (!CB_TF[tf]) { const base = tf === 240 ? 60 : 1440, src = await this.bars(sym, base, Math.ceil(count * tf / base) + 2); return aggregate(src, tf); }
    let out = [], end = Math.floor(Date.now() / 1000);
    const step = tf * 60 * 300;
    while (out.length < count) {
      const r = await req(`${CB}/products/${sym}/candles?granularity=${CB_TF[tf]}&start=${end - step}&end=${end}&limit=300`, {}, true);
      const L = r.candles || [];
      if (!L.length) break;
      out = L.map((k) => ({ t: num(k.start) * 1000, o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), v: num(k.volume) })).reverse().concat(out);
      end -= step;
    }
    return uniq(out);
  },
  async tickers() {
    const r = await req(`${CB}/products?product_type=FUTURE&contract_expiry_type=PERPETUAL`, {}, true), o = {};
    for (const x of r.products || []) o[x.product_id] = { p: num(x.price), ch: num(x.price_percentage_change_24h), qv: num(x.approximate_quote_24h_volume || 0) };
    return o;
  },
  async instruments() {
    const r = await req(`${CB}/products?product_type=FUTURE&contract_expiry_type=PERPETUAL`, {}, true);
    return (r.products || []).map((x) => ({ sym: x.product_id, base: (x.base_display_symbol || x.product_id.split("-")[0]), quote: "USDC", kind: "Perp" }));
  },
};

// ---------------- Kraken Futures (qua proxy) ----------------
const KR = "https://futures.kraken.com";
const KR_TF = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d", 10080: "1w" };
const kraken = {
  name: "Kraken",
  proxy: true,
  async bars(sym, tf, count) {
    let out = [], to = Math.floor(Date.now() / 1000);
    const span = tf * 60 * 2000;
    while (out.length < count) {
      const r = await req(`${KR}/api/charts/v1/trade/${sym}/${KR_TF[tf]}?from=${to - span}&to=${to}`, {}, true);
      const L = r.candles || [];
      if (!L.length) break;
      out = L.map((k) => ({ t: num(k.time), o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), v: num(k.volume) })).concat(out);
      to -= span;
    }
    return uniq(out);
  },
  async tickers() {
    const r = await req(`${KR}/derivatives/api/v3/tickers`, {}, true), o = {};
    for (const x of r.tickers || []) { const p = num(x.last), op = num(x.open24h); o[x.symbol] = { p, ch: x.change24h != null ? num(x.change24h) : op ? (p / op - 1) * 100 : 0, qv: num(x.volumeQuote || 0) }; }
    return o;
  },
  async instruments() {
    const r = await req(`${KR}/derivatives/api/v3/instruments`, {}, true);
    return (r.instruments || []).filter((x) => /^PF_/.test(x.symbol) && x.tradeable !== false)
      .map((x) => ({ sym: x.symbol, base: x.symbol.slice(3).replace(/USD$/, "").replace(/^XBT$/, "BTC"), quote: "USD", kind: "Perp" }));
  },
};

export const EX = { binance, bybit, okx, hyperliquid, coinbase, kraken };

// Lấy nến; khung sàn không hỗ trợ thì gộp từ khung nhỏ hơn.
export async function getBars(ex, sym, tf, count) {
  return EX[ex].bars(sym, tf, count);
}

// 8 sản phẩm mặc định và mã tương ứng trên từng sàn (null = sàn không có hợp đồng vĩnh cửu).
export const DEFAULT_PRODUCTS = [
  { id: "BTC", label: "Bitcoin", group: "Crypto", map: { binance: "BTCUSDT", bybit: "BTCUSDT", okx: "BTC-USDT-SWAP", hyperliquid: "BTC", coinbase: "BTC-PERP-INTX", kraken: "PF_XBTUSD" } },
  { id: "ETH", label: "Ethereum", group: "Crypto", map: { binance: "ETHUSDT", bybit: "ETHUSDT", okx: "ETH-USDT-SWAP", hyperliquid: "ETH", coinbase: "ETH-PERP-INTX", kraken: "PF_ETHUSD" } },
  { id: "WTI", label: "Dầu WTI", group: "Năng lượng", map: { binance: "CLUSDT", bybit: "CLUSDT", okx: "CL-USDT-SWAP", hyperliquid: "xyz:CL", coinbase: null, kraken: null } },
  { id: "BRENT", label: "Dầu Brent", group: "Năng lượng", map: { binance: "BZUSDT", bybit: "BZUSDT", okx: "BZ-USDT-SWAP", hyperliquid: "xyz:BRENTOIL", coinbase: null, kraken: null } },
  { id: "XAU", label: "Vàng", group: "Kim loại", map: { binance: "XAUUSDT", bybit: "XAUUSDT", okx: "XAU-USDT-SWAP", hyperliquid: "xyz:GOLD", coinbase: null, kraken: null } },
  { id: "XAG", label: "Bạc", group: "Kim loại", map: { binance: "XAGUSDT", bybit: "XAGUSDT", okx: "XAG-USDT-SWAP", hyperliquid: "xyz:SILVER", coinbase: null, kraken: null } },
  { id: "COPPER", label: "Đồng", group: "Kim loại", map: { binance: "COPPERUSDT", bybit: null, okx: "XCU-USDT-SWAP", hyperliquid: "xyz:COPPER", coinbase: null, kraken: null } },
  { id: "XPT", label: "Bạch kim", group: "Kim loại", map: { binance: "XPTUSDT", bybit: null, okx: "XPT-USDT-SWAP", hyperliquid: "xyz:PLATINUM", coinbase: null, kraken: null } },
];
