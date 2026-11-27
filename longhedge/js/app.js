// LongHedge VN – giao diện terminal.
import { EX, EX_ORDER, DEFAULT_PRODUCTS, getBars } from "./exchanges.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const VN = 7 * 3600000;
const pad = (n) => String(n).padStart(2, "0");
const fmtT = (ms) => { const d = new Date(ms + VN); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fmtD = (ms) => { const d = new Date(ms + VN); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const nf = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("vi-VN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const sg = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + nf(Math.abs(v), d));
const neg = (v) => (v > 0.0049 ? "−" + nf(v) : "0,00");
const decOf = (p) => (p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 7);
const px = (v, ref) => nf(v, decOf(Math.abs(ref ?? v)));
const DAY = 86400000;

// ---------------- Trạng thái lưu trên trình duyệt ----------------
const KEY = "longhedge.v1";
const DEF_COL = {
  classic: { acc: "#e8590c", up: "#000000", dn: "#d1001f", vwap: "#7b2cbf", vol: "#1f5fd6", hollow: true },
  modern: { acc: "#ffa630", up: "#e8e6e1", dn: "#ff4d4d", vwap: "#c58bff", vol: "#2f7bff", hollow: false },
};
const DEF = {
  theme: "classic", colors: { classic: { ...DEF_COL.classic }, modern: { ...DEF_COL.modern } }, fs: 12,
  ex: "binance", autoFb: true, hist: 3000,
  custom: [], sel: "BTC", tf: 15, strat: "ema", detTab: "logic", view: "T",
  params: {}, acct: 100000, risk: 1, fee: 0.05, from: "",
  rules: { p1: 10, p2: 5, dl: 5, tl: 10, days: 4, max: 0 },
};
let S;
try { S = { ...DEF, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch (e) { S = { ...DEF }; }
S.rules = { ...DEF.rules, ...S.rules };
S.colors = { classic: { ...DEF_COL.classic, ...(S.colors?.classic || {}) }, modern: { ...DEF_COL.modern, ...(S.colors?.modern || {}) } };
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* trình duyệt chặn lưu */ } }, 200); };
if (!EX[S.ex]) S.ex = "binance";

// ---------------- Bộ chạy chiến lược (Web Worker) ----------------
const worker = new Worker(new URL("./engine.js", import.meta.url), { type: "module" });
let reqN = 0;
const pend = new Map();
const ask = (msg) => new Promise((res) => { const id = ++reqN; pend.set(id, res); worker.postMessage({ ...msg, reqId: id }); });
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "progress") { onProgress(m); return; }
  const f = pend.get(m.reqId);
  if (f) { pend.delete(m.reqId); f(m); }
};

let META = [];           // [{id,name,params}]
const RES = {};          // key ex|sym -> {id: result}
let runKey = "", runBusy = false, runAgain = false;

// ---------------- Sản phẩm & sàn ----------------
const products = () => DEFAULT_PRODUCTS.concat(S.custom);
const prodOf = (id) => products().find((p) => p.id === id) || DEFAULT_PRODUCTS[0];
const exOk = (ex) => !!EX[ex];
// Mã của sản phẩm trên sàn ex; undefined = chưa dò (mã tự thêm), null = không có.
const symOn = (p, ex) => (p.map ? p.map[ex] : undefined);
function sourceOf(p) {
  const order = [S.ex].concat(EX_ORDER.filter((e) => e !== S.ex));
  for (const ex of order) { if (!exOk(ex)) continue; const s = symOn(p, ex); if (s) return { ex, sym: s }; }
  return null;
}
const instCache = {};
async function instruments(ex) {
  if (!instCache[ex]) instCache[ex] = EX[ex].instruments().catch((e) => { delete instCache[ex]; throw e; });
  return instCache[ex];
}
// Dò mã tự thêm trên sàn khác theo đồng gốc (ưu tiên USDT, rồi USDC, USD).
async function resolveCustom(ex) {
  const need = S.custom.filter((p) => p.map[ex] === undefined);
  if (!need.length || !exOk(ex)) return;
  let L;
  try { L = await instruments(ex); } catch (e) { return; }
  for (const p of need) {
    const c = L.filter((x) => x.base.toUpperCase() === p.base.toUpperCase());
    const best = ["USDT", "USDC", "USD"].map((q) => c.find((x) => x.quote === q)).find(Boolean) || c[0];
    p.map[ex] = best ? best.sym : null;
  }
  save();
}

// ---------------- Giao diện chung ----------------
function applyTheme() {
  const r = document.documentElement, c = S.colors[S.theme];
  r.dataset.theme = S.theme;
  r.style.setProperty("--fs", S.fs + "px");
  for (const k of ["acc", "up", "dn", "vwap", "vol"]) r.style.setProperty("--c-" + k, c[k]);
  $("#mC").classList.toggle("on", S.theme === "classic");
  $("#mM").classList.toggle("on", S.theme === "modern");
  document.querySelectorAll("[data-col]").forEach((i) => (i.value = c[i.dataset.col]));
  $("#hollow").checked = !!c.hollow;
  if (chart) styleChart();
}
$("#mC").onclick = () => { S.theme = "classic"; save(); applyTheme(); };
$("#mM").onclick = () => { S.theme = "modern"; save(); applyTheme(); };
document.querySelectorAll("[data-col]").forEach((i) => (i.oninput = () => { S.colors[S.theme][i.dataset.col] = i.value; save(); applyTheme(); }));
$("#hollow").onchange = (e) => { S.colors[S.theme].hollow = e.target.checked; save(); applyTheme(); };
$("#colReset").onclick = () => { S.colors[S.theme] = { ...DEF_COL[S.theme] }; save(); applyTheme(); };
$("#fsUp").onclick = () => { S.fs = Math.min(16, S.fs + 1); save(); applyTheme(); };
$("#fsDn").onclick = () => { S.fs = Math.max(10, S.fs - 1); save(); applyTheme(); };
const setPop = $("#setPop");
$("#btnSet").onclick = () => { setPop.hidden = !setPop.hidden; $("#btnSet").setAttribute("aria-expanded", String(!setPop.hidden)); };
setPop.querySelector("[data-close]").onclick = () => { setPop.hidden = true; };
$("#autoFb").checked = S.autoFb; $("#autoFb").onchange = (e) => { S.autoFb = e.target.checked; save(); };
$("#histSel").value = String(S.hist); $("#histSel").onchange = (e) => { S.hist = +e.target.value; save(); runEngine(true); };
$("#expP").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "LongHedge VN", saved: new Date().toISOString(), params: S.params }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "longhedge-thong-so.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#impP").onclick = () => $("#impF").click();
$("#impF").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); if (!j.params || typeof j.params !== "object") throw new Error("File không có thông số"); S.params = j.params; save(); renderDet(); runEngine(true); banner("Đã nhập thông số từ file " + f.name, 4000); }
  catch (err) { banner("Không đọc được file: " + err.message, 6000); }
  e.target.value = "";
};
const fs = (el) => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.());
$("#fsPage").onclick = () => fs(document.documentElement);
$("#fsChart").onclick = () => fs($("#chartBox"));
$("#fsEval").onclick = () => fs($(".evbox"));

let bannerT = 0;
function banner(html, ms) {
  const b = $("#banner"); b.innerHTML = html; b.hidden = false;
  clearTimeout(bannerT); if (ms) bannerT = setTimeout(() => (b.hidden = true), ms);
}
setInterval(() => { const d = new Date(Date.now() + VN); $("#clk").textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} · ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; }, 1000);

function fillEx() {
  $("#exSel").innerHTML = EX_ORDER.map((e) => `<option value="${e}" >${EX[e].name}${e === "binance" ? " (mặc định)" : ""}</option>`).join("");
  $("#exSel").value = S.ex;
}
$("#exSel").onchange = (e) => switchEx(e.target.value);
async function switchEx(ex, why) {
  S.ex = ex; save(); fillEx();
  await resolveCustom(ex);
  if (!why) $("#banner").hidden = true;
  renderWl(); loadChart(); refreshTickers(); runEngine(true);
}

// tab Terminal / Đánh giá
function setView(v) {
  S.view = v; save();
  $("#navT").classList.toggle("on", v === "T"); $("#navE").classList.toggle("on", v === "E");
  $("#viewT").hidden = v !== "T"; $("#viewE").hidden = v !== "E";
  if (v === "E") renderEval();
}
$("#navT").onclick = () => setView("T");
$("#navE").onclick = () => setView("E");

// ---------------- Danh mục ----------------
const TICK = {}; // ex -> {sym:{p,ch}}
function renderWl() {
  const groups = {};
  for (const p of products()) (groups[p.group] = groups[p.group] || []).push(p);
  let h = "";
  for (const [g, L] of Object.entries(groups)) {
    h += `<div class="grp">${esc(g)}</div>`;
    for (const p of L) {
      const src = sourceOf(p), t = src && TICK[src.ex] && TICK[src.ex][src.sym];
      const tag = p.custom ? '<span class="tag">TỰ THÊM</span>' : "";
      const other = src && src.ex !== S.ex ? `<span class="tag">${EX[src.ex].name}</span>` : "";
      h += `<div class="wrow ${p.id === S.sel ? "on" : ""} ${src ? "" : "na"}" data-id="${esc(p.id)}" title="${src ? esc(EX[src.ex].name + " · " + src.sym) : "Không có trên các sàn đang dùng được"}">
        <div><div class="wtk">${esc(src ? src.sym : p.map?.[S.ex] || p.id)}${tag}${other}</div><div class="wnm">${esc(p.label)}</div></div>
        <div><div class="wpx num">${t ? px(t.p) : "—"}</div><div class="wch num ${t ? (t.ch >= 0 ? "up" : "down") : ""}">${t ? sg(t.ch) + "%" : src ? "" : "Không có"}</div></div>
        ${p.custom ? `<button class="wx" data-del="${esc(p.id)}" title="Xóa khỏi danh mục">✕</button>` : ""}</div>`;
    }
  }
  $("#wl").innerHTML = h;
}
$("#wl").onclick = (e) => {
  const del = e.target.closest("[data-del]");
  if (del) { S.custom = S.custom.filter((p) => p.id !== del.dataset.del); if (S.sel === del.dataset.del) S.sel = "BTC"; save(); renderWl(); selectProduct(S.sel); return; }
  const r = e.target.closest(".wrow"); if (r) selectProduct(r.dataset.id);
};
async function refreshTickers() {
  const need = new Set(products().map(sourceOf).filter(Boolean).map((s) => s.ex));
  await Promise.all([...need].map(async (ex) => { try { TICK[ex] = await EX[ex].tickers(); } catch (e) { /* bỏ qua lần này */ } }));
  renderWl();
}

// ---------------- Tìm mã ----------------
let ddList = [], ddIdx = -1;
$("#q").addEventListener("input", searchNow);
$("#q").addEventListener("focus", searchNow);
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#dd").hidden = true; e.target.blur(); }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); ddIdx = Math.max(0, Math.min(ddList.length - 1, ddIdx + (e.key === "ArrowDown" ? 1 : -1))); paintDd(); }
  if (e.key === "Enter" && ddList[ddIdx]) pick(ddList[ddIdx], true);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("#dd").hidden = true; if (!e.target.closest("#setPop,#btnSet")) setPop.hidden = true; });
async function searchNow() {
  const q = $("#q").value.trim().toUpperCase(), dd = $("#dd");
  if (!q) { dd.hidden = true; return; }
  dd.hidden = false;
  let L;
  try { L = await instruments(S.ex); } catch (e) { dd.innerHTML = `<div class="ft">Không tải được danh sách mã của ${EX[S.ex].name}: ${esc(e.message)}</div>`; return; }
  const alias = { DAU: "CL", OIL: "CL", WTI: "CL", BRENT: "BZ", VANG: "XAU", GOLD: "XAU", BAC: "XAG", SILVER: "XAG", DONG: "COPPER", COPPER: "COPPER", "BẠCH KIM": "XPT", PLATINUM: "XPT", "VÀNG": "XAU", "BẠC": "XAG", "DẦU": "CL", "ĐỒNG": "COPPER" };
  const q2 = alias[q] || q;
  const sc = (x) => { const s = x.sym.toUpperCase(), b = x.base.toUpperCase(); return b === q2 ? 0 : s.startsWith(q2) ? 1 : b.startsWith(q2) ? 2 : s.includes(q2) ? 3 : 9; };
  ddList = L.filter((x) => sc(x) < 9).sort((a, b) => sc(a) - sc(b) || a.sym.length - b.sym.length).slice(0, 30);
  ddIdx = ddList.length ? 0 : -1;
  paintDd();
}
function paintDd() {
  const dd = $("#dd"), have = new Set(products().map((p) => p.map?.[S.ex]).filter(Boolean));
  if (!ddList.length) { dd.innerHTML = `<div class="ft">Không thấy hợp đồng vĩnh cửu nào khớp trên ${EX[S.ex].name}.</div>`; return; }
  dd.innerHTML = ddList.map((x, i) => `<div class="r ${i === ddIdx ? "act" : ""}" data-i="${i}"><div><b>${esc(x.sym)}</b></div><small>${esc(x.base)} · ${esc(x.kind)} · ${esc(x.quote)}</small>
    <button class="add ${have.has(x.sym) ? "have" : ""}" data-i="${i}">${have.has(x.sym) ? "Đã có" : "+ Thêm"}</button></div>`).join("") +
    `<div class="ft">Chỉ hiện hợp đồng vĩnh cửu đang giao dịch trên ${EX[S.ex].name}. Bấm dòng để xem, bấm + Thêm để lưu vào danh mục.</div>`;
}
$("#dd").onclick = (e) => { const r = e.target.closest("[data-i]"); if (!r) return; pick(ddList[+r.dataset.i], !!e.target.closest(".add")); };
function pick(x, add) {
  let p = products().find((q) => q.map?.[S.ex] === x.sym);
  if (!p) {
    p = { id: "c:" + S.ex + ":" + x.sym, label: x.base + " · " + x.kind, group: "Tự thêm", base: x.base, custom: 1, map: { [S.ex]: x.sym } };
    for (const e of EX_ORDER) if (e !== S.ex) p.map[e] = undefined;
    if (add) { S.custom.push(p); save(); }
    else p.temp = 1;
  }
  $("#dd").hidden = true; $("#q").value = "";
  if (p.temp) { tempProd = p; }
  selectProduct(p.id);
}
let tempProd = null;
const curProd = () => (tempProd && tempProd.id === S.sel ? tempProd : prodOf(S.sel));

function selectProduct(id) {
  S.sel = id; save();
  if (!tempProd || tempProd.id !== id) tempProd = null;
  renderWl(); loadChart(); runEngine(true);
}

// ---------------- Biểu đồ ----------------
const TFS = [[1, "1m"], [5, "5m"], [15, "15m"], [30, "30m"], [60, "1h"], [240, "4h"], [1440, "D"], [10080, "W"]];
$("#tfBar").innerHTML = TFS.map(([m, l]) => `<button data-tf="${m}">${l}</button>`).join("");
$("#tfBar").onclick = (e) => { const b = e.target.closest("[data-tf]"); if (!b) return; S.tf = +b.dataset.tf; save(); loadChart(); };
let chart = null, cS, vS, wS, bars = [], cSrc = null, priceLines = [], failN = 0, chartReq = 0;
const tsec = (ms) => Math.floor((ms + VN) / 1000);
function initChart() {
  chart = LightweightCharts.createChart($("#chart"), { autoSize: true, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6 }, crosshair: { mode: 0 } });
  cS = chart.addCandlestickSeries({ priceLineVisible: true });
  vS = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  cS.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
  wS = chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  chart.subscribeCrosshairMove((p) => {
    const d = p && p.seriesData && p.seriesData.get(cS);
    const b = d || (bars.length ? { open: bars[bars.length - 1].o, high: bars[bars.length - 1].h, low: bars[bars.length - 1].l, close: bars[bars.length - 1].c } : null);
    if (!b) { $("#ohlc").textContent = ""; return; }
    const ch = b.close - b.open;
    $("#ohlc").innerHTML = `O <b>${px(b.open)}</b> H <b>${px(b.high)}</b> L <b>${px(b.low)}</b> C <b class="${ch >= 0 ? "up" : "down"}">${px(b.close)}</b>`;
  });
  styleChart();
}
function styleChart() {
  const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim(), c = S.colors[S.theme];
  chart.applyOptions({
    layout: { background: { type: "solid", color: v("--panel") }, textColor: v("--fg"), fontFamily: "IBM Plex Mono, monospace", fontSize: Math.max(10, S.fs - 1) },
    grid: { vertLines: { color: v("--grid") }, horzLines: { color: v("--grid") } },
    rightPriceScale: { borderColor: v("--line") }, timeScale: { borderColor: v("--line") },
  });
  cS.applyOptions({ upColor: c.hollow ? v("--panel") : c.up, downColor: c.dn, borderUpColor: c.up, borderDownColor: c.dn, wickUpColor: c.up, wickDownColor: c.dn });
  wS.applyOptions({ color: c.vwap });
  if (bars.length) vS.setData(volData());
  drawTrades();
}
const volData = () => bars.map((b) => ({ time: tsec(b.t), value: b.v, color: S.colors[S.theme].vol + "b0" }));
// VWAP reset mỗi phiên lúc 00:00 UTC (07:00 giờ Việt Nam). Khung D/W không vẽ.
function vwapData() {
  if (S.tf >= 1440) return [];
  const out = [];
  let day = null, pv = 0, vv = 0;
  for (const b of bars) {
    const k = Math.floor(b.t / DAY);
    if (k !== day) { if (day !== null) out.push({ time: tsec(b.t) }); day = k; pv = 0; vv = 0; }
    const tp = (b.h + b.l + b.c) / 3, v = b.v || 0;
    pv += tp * v; vv += v;
    if (vv > 0) out.push({ time: tsec(b.t), value: pv / vv });
  }
  // điểm ngắt (chỉ có time) phải nằm đúng nến đầu phiên: bỏ điểm trùng time
  const seen = new Set(), res = [];
  for (let i = out.length - 1; i >= 0; i--) { if (seen.has(out[i].time)) continue; seen.add(out[i].time); res.push(out[i]); }
  return res.reverse();
}
async function loadChart() {
  const p = curProd(), src = sourceOf(p), my = ++chartReq;
  $("#chartMsg").hidden = true;
  if (!src) { cSrc = null; $("#symLbl").textContent = p.label; $("#srcLbl").textContent = ""; showMsg("Sản phẩm này không có hợp đồng vĩnh cửu trên các sàn đang dùng được."); cS.setData([]); vS.setData([]); wS.setData([]); return; }
  cSrc = src; bars = [];
  $("#symLbl").textContent = src.sym + ".P";
  $("#srcLbl").textContent = EX[src.ex].name + (src.ex !== S.ex ? " (sàn đang chọn không có mã này)" : "");
  document.querySelectorAll("#tfBar button").forEach((b) => b.classList.toggle("on", +b.dataset.tf === S.tf));
  showMsg("Đang tải nến từ " + EX[src.ex].name + "…");
  try {
    const r = await getBars(src.ex, src.sym, S.tf, 1000);
    if (my !== chartReq) return;
    bars = r; failN = 0;
    $("#chartMsg").hidden = true;
    cS.setData(bars.map((b) => ({ time: tsec(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    vS.setData(volData()); wS.setData(vwapData());
    const dp = decOf(bars.length ? bars[bars.length - 1].c : 1);
    cS.applyOptions({ priceFormat: { type: "price", precision: dp, minMove: Math.pow(10, -dp) } });
    chart.timeScale().scrollToRealTime();
    drawTrades();
    chart.applyOptions({}); $("#ohlc").innerHTML = "";
  } catch (e) {
    if (my !== chartReq) return;
    onDataError(src, e);
    if (failN === 1) setTimeout(() => { if (my === chartReq) loadChart(); }, 1500);
  }
}
function showMsg(t) { const m = $("#chartMsg"); m.textContent = t; m.hidden = false; }
function onDataError(src, e) {
  failN++;
  showMsg(`${EX[src.ex].name} lỗi: ${e.message}`);
  if (failN >= 2 && S.autoFb && src.ex === S.ex) {
    const p = curProd(), next = EX_ORDER.find((x) => x !== src.ex && exOk(x) && symOn(p, x));
    if (next) {
      const from = EX[src.ex].name;
      banner(`${esc(from)} không phản hồi (${esc(e.message)}). Đã tự chuyển sang <b>${esc(EX[next].name)}</b> lúc ${fmtT(Date.now()).slice(6)}. <button class="ib sm" id="backEx">Quay lại ${esc(from)}</button>`);
      $("#backEx").onclick = () => switchEx(src.ex);
      failN = 0;
      switchEx(next, "fallback");
    }
  }
}
// cập nhật nến mới nhất mỗi 5 giây
setInterval(async () => {
  if (!cSrc || !bars.length || document.hidden) return;
  const src = cSrc, tf = S.tf, my = chartReq;
  try {
    const add = await getBars(src.ex, src.sym, tf, 3);
    if (my !== chartReq) return;
    failN = 0;
    for (const b of add) {
      const last = bars[bars.length - 1];
      if (b.t < last.t) continue;
      if (b.t === last.t) bars[bars.length - 1] = b; else bars.push(b);
      cS.update({ time: tsec(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
      vS.update({ time: tsec(b.t), value: b.v, color: S.colors[S.theme].vol + "b0" });
    }
    if (tf < 1440) { const w = vwapData(); if (w.length) wS.update(w[w.length - 1]); }
    const tk = TICK[src.ex] && TICK[src.ex][src.sym]; if (tk) tk.p = bars[bars.length - 1].c;
  } catch (e) { if (my === chartReq) onDataError(src, e); }
}, 5000);
setInterval(() => { if (!document.hidden) refreshTickers(); }, 15000);

// Điểm vào / thoát của chiến lược đang chọn + đường Vào / TP / SL của lệnh đang mở (hoặc lệnh bro bấm trong lịch sử).
let focusTrade = null;
function curRes() { const src = cSrc; return src ? RES[src.ex + "|" + src.sym] || {} : {}; }
function drawTrades() {
  if (!chart) return;
  for (const l of priceLines) cS.removePriceLine(l);
  priceLines = [];
  const r = curRes()[S.strat];
  if (!r || r.error || !bars.length) { cS.setMarkers([]); return; }
  const ms = S.tf * 60000, first = bars[0].t, cs = getComputedStyle(document.documentElement);
  const buy = cs.getPropertyValue("--buy").trim(), sell = cs.getPropertyValue("--sell").trim(), mut = cs.getPropertyValue("--muted").trim();
  const W0 = S.tf === 10080 ? 345600000 : 0; // nến tuần bắt đầu thứ Hai
  const barT = (t) => tsec(Math.floor((t - 1 - W0) / ms) * ms + W0); // nến chứa thời điểm (giờ đóng nến tín hiệu - 1ms)
  const mk = [];
  const all = r.trades.concat(r.open ? [r.open] : []);
  for (const t of all) {
    if (t.ot < first) continue;
    mk.push({ time: barT(t.ot), position: t.d > 0 ? "belowBar" : "aboveBar", color: t.d > 0 ? buy : sell, shape: t.d > 0 ? "arrowUp" : "arrowDown", text: t.d > 0 ? "MUA" : "BÁN" });
    if (t.ct) { const R = rOf(t); mk.push({ time: barT(t.ct), position: t.d > 0 ? "aboveBar" : "belowBar", color: R >= 0 ? buy : sell, shape: "circle", text: sg(R, 1) + "R" }); }
  }
  mk.sort((a, b) => a.time - b.time);
  cS.setMarkers(mk);
  const t = focusTrade || r.open;
  if (t) {
    const L = (price, color, title, style) => priceLines.push(cS.createPriceLine({ price, color, lineWidth: 1.5, lineStyle: style, axisLabelVisible: true, title }));
    L(t.e, mut, "Vào", 2); L(t.tp, buy, "TP", 0); L(t.sl, sell, t.sl !== t.sl0 ? "SL (đã dời)" : "SL", 0);
  }
}
const rOf = (t) => { const risk = Math.abs(t.e - t.sl0); return risk ? ((t.x - t.e) * t.d - S.fee / 100 * (t.e + t.x)) / risk : 0; };

// ---------------- Chạy chiến lược ----------------
const paramsOf = (id) => { const m = META.find((x) => x.id === id), p = {}; for (const d of m.params) { const v = S.params[id]?.[d.k]; p[d.k] = v !== undefined && Number.isFinite(+v) ? +v : d.v; } return p; };
async function runEngine(force) {
  const src = cSrc || sourceOf(curProd());
  if (!META.length || !src) return;
  const key = src.ex + "|" + src.sym;
  if (runBusy) { runAgain = true; return; }
  runBusy = true; runKey = key;
  $("#engState").textContent = "đang tính…";
  const strategies = META.map((m) => ({ id: m.id, p: paramsOf(m.id) }));
  if (force) RES[key] = RES[key] || {};
  const r = await ask({ type: "run", ex: src.ex, sym: src.sym, hist: S.hist, strategies });
  RES[key] = r.results;
  runBusy = false;
  $("#engState").textContent = "cập nhật " + fmtT(Date.now()).slice(6) + " · " + EX[src.ex].name;
  renderBoard(); renderDet(); drawTrades(); if (S.view === "E") renderEval();
  if (runAgain) { runAgain = false; runEngine(); }
}
function onProgress(m) {
  const src = cSrc; if (!src) return;
  const key = src.ex + "|" + src.sym;
  if (key !== runKey) return;
  RES[key] = RES[key] || {};
  RES[key][m.id] = m.result;
  $("#engState").textContent = `đang tính ${m.done}/${m.total}…`;
  renderBoard();
  if (m.id === S.strat) { renderDet(); drawTrades(); }
}
setInterval(() => { if (!document.hidden) runEngine(); }, 60000);

// ---------------- Tính lãi lỗ & đánh giá theo quy tắc quỹ ----------------
const fromMs = () => (S.from ? Date.parse(S.from + "T00:00:00Z") : 0);
function money(t) {
  const riskUSD = S.acct * S.risk / 100, dist = Math.abs(t.e - t.sl0), qty = dist ? riskUSD / dist : 0;
  const fee = S.fee / 100 * (t.e + t.x) * qty, pnl = (t.x - t.e) * t.d * qty - fee;
  return { qty, fee, pnl, R: riskUSD ? pnl / riskUSD : 0, maeR: dist ? t.mae / dist : 0, mfeR: dist ? t.mfe / dist : 0, maeUSD: t.mae * qty };
}
function evaluate(r) {
  const R = S.rules, A = S.acct, f0 = fromMs();
  const trades = (r.trades || []).filter((t) => t.ot >= f0).map((t) => ({ ...t, ...money(t) })).sort((a, b) => a.ct - b.ct);
  const st = { trades, n: trades.length, win: 0, gw: 0, gl: 0, fee: 0, sumR: 0, maeR: 0, mfeR: 0, pnl: 0, maxDayLoss: 0, maxDD: 0, days: 0, eq: [] };
  const days = new Set(), dayPl = new Map();
  let bal = A, peak = A, dayK = null, dayStart = A, dayLow = A;
  const phase = [{ target: R.p1, start: trades.length ? trades[0].ot : null, bal: A, days: new Set(), res: "run" }, { target: R.p2, res: "wait" }];
  let ph = 0;
  for (const t of trades) {
    const dk = Math.floor(t.ct / DAY);
    if (dk !== dayK) { dayK = dk; dayStart = bal; dayLow = bal; }
    days.add(Math.floor(t.ot / DAY));
    const worst = bal - t.maeUSD;
    dayLow = Math.min(dayLow, worst);
    st.maxDayLoss = Math.max(st.maxDayLoss, (dayStart - dayLow) / A * 100);
    st.maxDD = Math.max(st.maxDD, (peak - worst) / A * 100);
    bal += t.pnl; peak = Math.max(peak, bal); dayLow = Math.min(dayLow, bal);
    st.maxDayLoss = Math.max(st.maxDayLoss, (dayStart - dayLow) / A * 100);
    st.maxDD = Math.max(st.maxDD, (peak - bal) / A * 100);
    dayPl.set(dk, (dayPl.get(dk) || 0) + t.pnl);
    st.pnl += t.pnl; st.fee += t.fee; st.sumR += t.R; st.maeR += t.maeR; st.mfeR += t.mfeR;
    if (t.pnl > 0) { st.win++; st.gw += t.pnl; } else st.gl -= t.pnl;
    st.eq.push({ t: t.ct, v: bal });
    // giai đoạn đánh giá
    const P = phase[ph];
    if (P && P.res === "run") {
      P.days.add(Math.floor(t.ot / DAY));
      P.bal += t.pnl;
      const pWorst = P.bal - t.pnl - t.maeUSD;
      if (P.dayK !== dk) { P.dayK = dk; P.dayStart = P.bal - t.pnl; }
      const dLow = Math.min(pWorst, P.bal);
      if (P.dayStart - dLow >= R.dl / 100 * A) { P.res = "fail"; P.why = "Lỗ ngày quá " + R.dl + "%"; P.at = t.ct; }
      else if (dLow <= A * (1 - R.tl / 100)) { P.res = "fail"; P.why = "Lỗ tổng quá " + R.tl + "%"; P.at = t.ct; }
      else if (R.max > 0 && t.ct - P.start > R.max * DAY) { P.res = "fail"; P.why = "Hết hạn " + R.max + " ngày"; P.at = t.ct; }
      else if (P.bal >= A * (1 + P.target / 100) && P.days.size >= R.days) { P.res = "pass"; P.at = t.ct; if (ph === 0) { ph = 1; Object.assign(phase[1], { res: "run", start: t.ct, bal: A, days: new Set() }); } }
    }
  }
  st.days = days.size;
  st.pct = st.pnl / A * 100;
  st.wr = st.n ? st.win / st.n * 100 : null;
  st.pf = st.gl > 0 ? st.gw / st.gl : st.gw > 0 ? Infinity : null;
  st.avgR = st.n ? st.sumR / st.n : null;
  st.avgMae = st.n ? st.maeR / st.n : null; st.avgMfe = st.n ? st.mfeR / st.n : null;
  st.phase = phase; st.dayPl = dayPl;
  const [p1, p2] = phase;
  st.label = p1.res === "fail" ? ["TRƯỢT GĐ1", "no", p1.why] : p1.res === "run" ? ["ĐANG CHẠY GĐ1", "run"] :
    p2.res === "pass" ? ["ĐẠT CẢ 2 GĐ", "ok"] : p2.res === "fail" ? ["ĐẠT GĐ1 · TRƯỢT GĐ2", "no", p2.why] : ["ĐẠT GĐ1 · ĐANG CHẠY GĐ2", "ok"];
  return st;
}

// ---------------- Bảng 14 chiến lược ----------------
function renderBoard() {
  const res = curRes(), src = cSrc;
  $("#boardTitle").textContent = `${META.length} chiến lược chạy song song${src ? " · " + src.sym : ""}`;
  let h = `<thead><tr><th>Chiến lược</th><th>Khung</th><th>Trạng thái</th><th title="Lãi lỗ theo rủi ro ${S.risk}%/lệnh trên ${nf(S.acct, 0)} USD">Lãi/lỗ %</th><th>Thắng</th><th>Lệnh</th><th>R TB</th></tr></thead><tbody>`;
  for (const m of META) {
    const r = res[m.id], p = paramsOf(m.id);
    let stt = '<span class="st n">…</span>', pl = "", wr = "", n = "", ar = "";
    if (r && r.error) stt = `<span class="st e" title="${esc(r.error)}">LỖI</span>`;
    else if (r && r.trades) {
      const e = evaluate(r);
      stt = r.open ? `<span class="st ${r.open.d > 0 ? "b" : "s"}">${r.open.d > 0 ? "MUA" : "BÁN"}</span>` : '<span class="st n">CHỜ</span>';
      pl = `<span class="${e.pct >= 0 ? "up" : "down"}">${sg(e.pct)}%</span>`; wr = e.wr == null ? "—" : nf(e.wr, 0) + "%"; n = e.n; ar = sg(e.avgR);
    }
    h += `<tr data-id="${m.id}" class="${m.id === S.strat ? "on" : ""}"><td>${esc(m.name)}</td><td class="muted">${tfName(p.tf)}</td><td>${stt}</td><td class="num">${pl}</td><td class="num">${wr}</td><td class="num">${n}</td><td class="num">${ar}</td></tr>`;
  }
  $("#tb").innerHTML = h + "</tbody>";
}
const tfName = (m) => (m >= 1440 ? "D" : m >= 60 ? m / 60 + "h" : m + "m");
$("#tb").onclick = (e) => { const r = e.target.closest("tr[data-id]"); if (!r) return; S.strat = r.dataset.id; focusTrade = null; save(); renderBoard(); renderDet(); drawTrades(); };

// ---------------- Chi tiết chiến lược ----------------
let descReq = 0;
async function renderDet() {
  const m = META.find((x) => x.id === S.strat), det = $("#det");
  if (!m) { det.hidden = true; return; }
  det.hidden = false;
  const r = curRes()[m.id], p = paramsOf(m.id), tab = S.detTab;
  const tabs = [["sig", "Tín hiệu"], ["logic", "Logic · Thông số"], ["hist", "Lịch sử lệnh"], ["eval", "Đánh giá"]];
  let body = "";
  if (tab === "sig") body = sigTab(r);
  else if (tab === "hist") body = histTab(r);
  else if (tab === "eval") body = evalMini(r);
  else body = `<div class="split"><div class="logic"><span class="lbl">Logic</span><div id="logicBody" class="muted">…</div></div><div><span class="lbl">Thông số</span><div class="prm">${m.params.map((d) => prmInput(d, p[d.k])).join("")}</div>
    <div class="btns"><button class="ib p sm" id="pApply">Áp dụng</button><button class="ib sm" id="pDef">Mặc định</button></div><p class="note">Thông số chỉ lưu trên trình duyệt này.</p></div></div>`;
  det.innerHTML = `<div class="dethd"><b>${esc(m.name)}</b><span class="muted sm">${r && r.n ? `${r.n} nến ${tfName(p.tf)} · ${fmtD(r.from)} → ${fmtT(r.to)}` : ""}</span></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>${body}`;
  if (tab === "logic") {
    const my = ++descReq, d = (await ask({ type: "describe", id: m.id, p })).d;
    if (my !== descReq || !$("#logicBody")) return;
    $("#logicBody").classList.remove("muted");
    $("#logicBody").innerHTML = Object.entries(d).map(([k, L]) => `<h5>${esc(k)}</h5><ul>${(L || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`).join("");
    $("#pApply").onclick = () => applyParams(m);
    $("#pDef").onclick = () => { delete S.params[m.id]; save(); renderDet(); runEngine(true); };
    det.querySelectorAll(".prm [data-k]").forEach((i) => (i.oninput = () => i.classList.add("chg")));
  }
  if (tab === "eval") drawEq($("#eqMini"), evaluate(r || {}));
}
function prmInput(d, v) {
  const lab = esc(d.label);
  if (d.options) return `<span>${lab}</span><select data-k="${d.k}">${d.options.map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  if (d.min === 0 && d.max === 1 && d.step === 1) return `<span>${lab.replace(/ \(1 = có(, 0 = không)?\)/, "")}</span><select data-k="${d.k}"><option value="1" ${v ? "selected" : ""}>Có</option><option value="0" ${v ? "" : "selected"}>Không</option></select>`;
  return `<span>${lab}</span><input type="number" data-k="${d.k}" value="${v}" min="${d.min ?? ""}" max="${d.max ?? ""}" step="${d.step ?? "any"}">`;
}
function applyParams(m) {
  const o = {};
  $("#det").querySelectorAll(".prm [data-k]").forEach((i) => {
    const d = m.params.find((x) => x.k === i.dataset.k);
    let v = +i.value;
    if (!Number.isFinite(v)) v = d.v;
    if (d.min != null && d.min > -1e9) v = Math.max(d.min, v);
    if (d.max != null && d.max < 1e9) v = Math.min(d.max, v);
    if (v !== d.v) o[d.k] = v;
  });
  if (Object.keys(o).length) S.params[m.id] = o; else delete S.params[m.id];
  save(); renderDet(); runEngine(true);
  banner("Đã áp dụng thông số mới cho " + esc(m.name) + ", đang tính lại…", 3000);
}
function sigTab(r) {
  if (!r) return '<p class="muted">Đang tính…</p>';
  if (r.error) return `<p class="down">Lỗi: ${esc(r.error)}</p>`;
  const last = cSrc && TICK[cSrc.ex]?.[cSrc.sym]?.p;
  let h = "";
  if (r.open) {
    const t = r.open, cur = last ?? t.e, risk = Math.abs(t.e - t.sl0), uR = risk ? (cur - t.e) * t.d / risk : 0;
    h += `<div class="card ${t.d > 0 ? "b" : "s"}"><div class="row"><b class="${t.d > 0 ? "up" : "down"}">● ${t.d > 0 ? "MUA" : "BÁN"} đang mở${t.v ? " · " + esc(t.v) : ""}</b><span class="muted">${fmtT(t.ot)}</span></div>
      <div class="row"><span class="muted">Giá vào</span><span class="num">${px(t.e)}</span></div>
      <div class="row"><span class="muted">SL / TP</span><span class="num"><span class="down">${px(t.sl, t.e)}</span> / <span class="up">${px(t.tp, t.e)}</span></span></div>
      <div class="row"><span class="muted">Đang lãi/lỗ</span><span class="num ${uR >= 0 ? "up" : "down"}">${sg(uR)}R</span></div>
      ${t.be ? `<div class="row"><span class="muted">Dời SL về hòa vốn</span><span>${t.sl !== t.sl0 ? "Đã dời" : "Chưa"}</span></div>` : ""}</div>`;
  } else h += '<div class="card"><b class="muted">Không có lệnh đang mở</b><div class="row"><span class="muted">Chờ tín hiệu ở nến ' + tfName(r.tf) + " tiếp theo</span></div></div>";
  const L = r.trades.slice(-5).reverse();
  if (L.length) h += `<span class="lbl">5 lệnh gần nhất</span>` + histTable(L);
  return h;
}
function histTab(r) {
  if (!r) return '<p class="muted">Đang tính…</p>';
  if (r.error) return `<p class="down">Lỗi: ${esc(r.error)}</p>`;
  if (!r.trades.length) return '<p class="muted">Chưa có lệnh nào đã đóng trong khoảng dữ liệu.</p>';
  return '<p class="note" style="margin:0 0 6px">Bấm 1 lệnh để hiện đường Vào / TP / SL của lệnh đó trên chart.</p>' + histTable(r.trades.slice().reverse());
}
const RES_TXT = { tp: "TP", sl: "SL", be: "Hòa vốn", exit: "Thoát" };
function histTable(L) {
  return `<div class="tblwrap"><table class="tb hist"><thead><tr><th>Vào lúc</th><th>Hướng</th><th>Vào</th><th>SL</th><th>TP</th><th>Ra</th><th>KQ</th><th>R</th><th>MAE</th><th>MFE</th><th>Phí $</th><th>Lãi/lỗ $</th></tr></thead><tbody>` +
    L.map((t) => { const m = money(t); return `<tr data-ot="${t.ot}"><td>${fmtT(t.ot)}</td><td class="${t.d > 0 ? "up" : "down"}">${t.d > 0 ? "MUA" : "BÁN"}</td><td class="num">${px(t.e)}</td><td class="num">${px(t.sl0, t.e)}</td><td class="num">${px(t.tp, t.e)}</td><td class="num">${px(t.x, t.e)}</td><td>${RES_TXT[t.res] || t.res}</td><td class="num ${m.R >= 0 ? "up" : "down"}">${sg(m.R)}</td><td class="num">${nf(m.maeR)}</td><td class="num">${nf(m.mfeR)}</td><td class="num">${nf(m.fee, 0)}</td><td class="num ${m.pnl >= 0 ? "up" : "down"}">${sg(m.pnl, 0)}</td></tr>`; }).join("") + "</tbody></table></div>";
}
$("#det").addEventListener("click", (e) => {
  const tb = e.target.closest("[data-tab]");
  if (tb) { S.detTab = tb.dataset.tab; save(); renderDet(); return; }
  const tr = e.target.closest("tr[data-ot]");
  if (tr) {
    const r = curRes()[S.strat], t = r && r.trades.find((x) => String(x.ot) === tr.dataset.ot);
    if (!t) return;
    focusTrade = t; drawTrades();
    const ms = S.tf * 60000, a = tsec(Math.floor(t.ot / ms) * ms), b = tsec(t.ct), span = Math.max(b - a, ms / 1000 * 20);
    chart.timeScale().setVisibleRange({ from: a - span, to: b + span });
  }
});
function evalMini(r) {
  if (!r || !r.trades) return '<p class="muted">Đang tính…</p>';
  const e = evaluate(r);
  return `<div class="card"><div class="row"><span>Kết quả</span><span class="pill ${e.label[1]}">${e.label[0]}</span></div>${e.label[2] ? `<div class="row"><span class="muted">Lý do</span><span>${esc(e.label[2])}</span></div>` : ""}
    <div class="row"><span class="muted">Lợi nhuận</span><span class="num ${e.pct >= 0 ? "up" : "down"}">${sg(e.pct)}%</span></div>
    <div class="row"><span class="muted">Lỗ ngày lớn nhất</span><span class="num">${neg(e.maxDayLoss)}%</span></div>
    <div class="row"><span class="muted">Sụt giảm tổng lớn nhất</span><span class="num">${neg(e.maxDD)}%</span></div>
    <div class="row"><span class="muted">Ngày giao dịch · Lệnh · Thắng</span><span class="num">${e.days} · ${e.n} · ${e.wr == null ? "—" : nf(e.wr, 0) + "%"}</span></div>
    <div class="row"><span class="muted">R TB · MAE TB · MFE TB</span><span class="num">${sg(e.avgR)} · ${nf(e.avgMae)} · ${nf(e.avgMfe)}</span></div></div>
    <canvas class="eq" id="eqMini"></canvas>`;
}
function drawEq(cv, e) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const cs = getComputedStyle(document.documentElement), col = (k) => cs.getPropertyValue(k).trim();
  const pts = [{ v: S.acct }].concat(e.eq || []);
  const R = S.rules, lines = [[S.acct * (1 + R.p1 / 100), col("--buy"), "+" + R.p1 + "%"], [S.acct, col("--muted"), "Vốn"], [S.acct * (1 - R.tl / 100), col("--sell"), "−" + R.tl + "%"]];
  const vals = pts.map((p) => p.v).concat(lines.map((l) => l[0]));
  const lo = Math.min(...vals), hi = Math.max(...vals), Y = (v) => 8 + (hi - v) / (hi - lo || 1) * (H - 16), X = (i) => 40 + i / Math.max(1, pts.length - 1) * (W - 48);
  g.font = "10px IBM Plex Mono"; g.lineWidth = 1;
  for (const [v, c, t] of lines) { g.strokeStyle = c; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(40, Y(v)); g.lineTo(W - 8, Y(v)); g.stroke(); g.fillStyle = c; g.fillText(t, 2, Y(v) + 3); }
  g.setLineDash([]); g.strokeStyle = col("--c-acc"); g.lineWidth = 2; g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(X(i), Y(p.v)) : g.moveTo(X(i), Y(p.v)))); g.stroke();
}

// ---------------- Tab Đánh giá ----------------
const bindNum = (id, get, set) => { const el = $(id); el.value = get(); el.onchange = () => { const v = +el.value; if (Number.isFinite(v)) { set(v); save(); renderBoard(); renderDet(); renderEval(); } }; };
bindNum("#acct", () => S.acct, (v) => (S.acct = Math.max(1000, v)));
bindNum("#risk", () => S.risk, (v) => (S.risk = Math.min(10, Math.max(0.05, v))));
bindNum("#fee", () => S.fee, (v) => (S.fee = Math.min(1, Math.max(0, v))));
for (const [id, k] of [["#rP1", "p1"], ["#rP2", "p2"], ["#rDL", "dl"], ["#rTL", "tl"], ["#rDays", "days"], ["#rMax", "max"]]) bindNum(id, () => S.rules[k], (v) => (S.rules[k] = Math.max(0, v)));
$("#from").value = S.from; $("#from").onchange = (e) => { S.from = e.target.value; save(); renderBoard(); renderDet(); renderEval(); };
let evSel = null;
function renderEval() {
  const res = curRes();
  $("#evSym").textContent = cSrc ? cSrc.sym + " · " + EX[cSrc.ex].name : "";
  const R = S.rules;
  let h = `<thead><tr><th>Chiến lược</th><th>Kết quả</th><th>Lợi nhuận / mục tiêu ${R.p1}%</th><th>Lỗ ngày lớn nhất / ${R.dl}%</th><th>Sụt giảm tổng / ${R.tl}%</th><th>Ngày GD</th><th>Lệnh</th><th>Thắng</th><th>Hệ số LN</th><th>R TB</th><th>MAE TB</th><th>MFE TB</th><th>Phí $</th></tr></thead><tbody>`;
  for (const m of META) {
    const r = res[m.id];
    if (!r || !r.trades) { h += `<tr data-id="${m.id}"><td>${esc(m.name)}</td><td colspan="12" class="muted" style="text-align:left">${r && r.error ? "Lỗi: " + esc(r.error) : "Đang tính…"}</td></tr>`; continue; }
    const e = evaluate(r), pr = Math.max(0, Math.min(100, e.pct / R.p1 * 100)), dl = e.maxDayLoss / R.dl * 100, tl = e.maxDD / R.tl * 100;
    h += `<tr data-id="${m.id}" class="${m.id === evSel ? "on" : ""}"><td>${esc(m.name)}</td><td><span class="pill ${e.label[1]}" title="${esc(e.label[2] || "")}">${e.label[0]}</span></td>
      <td><div class="cellbar"><span class="num ${e.pct >= 0 ? "up" : "down"}">${sg(e.pct)}%</span><div class="bar"><i style="width:${pr}%;background:var(--buy)"></i></div></div></td>
      <td><div class="cellbar"><span class="num">${neg(e.maxDayLoss)}%</span><div class="bar"><i style="width:${Math.min(100, dl)}%;background:${dl >= 80 ? "var(--sell)" : "var(--muted)"}"></i></div></div></td>
      <td><div class="cellbar"><span class="num">${neg(e.maxDD)}%</span><div class="bar"><i style="width:${Math.min(100, tl)}%;background:${tl >= 80 ? "var(--sell)" : "var(--muted)"}"></i></div></div></td>
      <td class="num">${e.days} ${e.days >= R.days ? "✓" : "✗"}</td><td class="num">${e.n}</td><td class="num">${e.wr == null ? "—" : nf(e.wr, 0) + "%"}</td><td class="num">${e.pf == null ? "—" : e.pf === Infinity ? "∞" : nf(e.pf)}</td><td class="num">${sg(e.avgR)}</td><td class="num">${nf(e.avgMae)}</td><td class="num">${nf(e.avgMfe)}</td><td class="num">${nf(e.fee, 0)}</td></tr>`;
  }
  $("#evTb").innerHTML = h + "</tbody>";
  renderEvDet();
}
$("#evTb").onclick = (e) => { const r = e.target.closest("tr[data-id]"); if (!r) return; evSel = evSel === r.dataset.id ? null : r.dataset.id; renderEval(); };
function renderEvDet() {
  const box = $("#evDet"), m = META.find((x) => x.id === evSel), r = m && curRes()[m.id];
  if (!m || !r || !r.trades) { box.hidden = true; return; }
  box.hidden = false;
  const e = evaluate(r), [p1, p2] = e.phase;
  const ph = (P, n) => P.res === "wait" ? `<div class="row"><span>Giai đoạn ${n}</span><span class="muted">Chưa bắt đầu</span></div>` :
    `<div class="row"><span>Giai đoạn ${n} (mục tiêu +${P.target}%)</span><span class="pill ${P.res === "pass" ? "ok" : P.res === "fail" ? "no" : "run"}">${P.res === "pass" ? "ĐẠT" : P.res === "fail" ? "TRƯỢT" : "ĐANG CHẠY"}</span></div>
     <div class="row"><span class="muted">Số dư · ngày GD</span><span class="num">${nf(P.bal, 0)} USD · ${P.days.size}</span></div>${P.at ? `<div class="row"><span class="muted">${P.res === "pass" ? "Đạt lúc" : "Trượt lúc"}</span><span>${fmtT(P.at)}${P.why ? " · " + esc(P.why) : ""}</span></div>` : ""}`;
  const days = [...e.dayPl.entries()].sort((a, b) => b[0] - a[0]).slice(0, 30);
  box.innerHTML = `<div class="dethd"><b>${esc(m.name)}</b><button class="x" id="evClose">✕</button></div>
    <div class="evgrid"><div><span class="lbl">Đường vốn</span><canvas class="eq" id="eqBig" style="height:220px"></canvas></div>
    <div><div class="card">${ph(p1, 1)}</div><div class="card">${ph(p2, 2)}</div>
    <span class="lbl">Lãi lỗ theo ngày (30 ngày gần nhất)</span><div class="tblwrap" style="max-height:200px"><table class="tb hist"><thead><tr><th>Ngày</th><th>Lãi/lỗ $</th><th>%</th></tr></thead><tbody>
    ${days.map(([k, v]) => `<tr><td>${fmtD(k * DAY)}</td><td class="num ${v >= 0 ? "up" : "down"}">${sg(v, 0)}</td><td class="num">${sg(v / S.acct * 100)}%</td></tr>`).join("")}</tbody></table></div></div></div>
    <span class="lbl">Lịch sử lệnh</span>${histTable(e.trades.slice().reverse())}`;
  $("#evClose").onclick = () => { evSel = null; renderEval(); };
  drawEq($("#eqBig"), e);
}

// ---------------- Khởi động ----------------
applyTheme(); fillEx(); initChart(); renderWl(); setView(S.view === "E" ? "E" : "T");
(async () => {
  META = (await ask({ type: "meta" })).list;
  if (!META.find((m) => m.id === S.strat)) S.strat = META[0].id;
  renderBoard();
  await resolveCustom(S.ex);
  await loadChart();
  renderDet();
  runEngine(true);
  refreshTickers();
})();
