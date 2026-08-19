#!/usr/bin/env node
/*
 * Historical backtest of the dashboard's signals against data/prices.json.
 * Reuses the EXACT signal math from index.html so results match the live tool.
 *
 * Signals:
 *   ALL            -> every evaluable stock-day (universe baseline)
 *   TTM_FIRE       -> TTM squeeze fired that day
 *   RS>=3 / RS>=4  -> RS Score (5-factor) at/above threshold that day
 *   FIRE&RS>=4     -> both, same day
 *   RS4_CROSS      -> the day RS Score CROSSES up to >=4 (was <4 the prior bar)
 *   FIRE&RS4_CROSS -> fired the same day RS crossed to >=4
 *   RS4_secLDIM    -> RS>=4 while its SECTOR RRG quadrant is Leading/Improving
 *   RS4_secWKLG    -> RS>=4 while its SECTOR RRG quadrant is Weakening/Lagging
 *     (LDIM vs WKLG tests whether the sector RRG adds anything on top of RS>=4)
 *
 * Forward return at +5/+10/+20/+30/+40/+50/+60 trading days, raw and EXCESS vs SPY.
 *
 * CAVEATS: survivorship bias (today's tickers only) inflates results; ~2y sample;
 * overlapping forward windows are autocorrelated (effective N << reported N);
 * series aligned by bars-from-end. Treat as directional, not proof.
 *
 * Usage:  node scripts/backtest.js
 */
const fs = require('fs');
const path = require('path');

/* ----- signal math copied verbatim from index.html (keep in sync) ----- */
function calcTTM(closes, highs, lows) {
  const N = 20;
  if (!closes || closes.length < N + 5) return { state: 'unknown' };
  const n = closes.length;
  const sma = (a, i, p) => { let s = 0; for (let j = i - p + 1; j <= i; j++) s += a[j]; return s / p; };
  const std = (a, i, p) => { const m = sma(a, i, p); let v = 0; for (let j = i - p + 1; j <= i; j++) v += (a[j] - m) ** 2; return Math.sqrt(v / p); };
  const atr = (i, p) => { let s = 0; for (let j = i - p + 1; j <= i; j++) { const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - (closes[j - 1] ?? closes[j])), Math.abs(lows[j] - (closes[j - 1] ?? closes[j]))); s += tr; } return s / p; };
  const hist = [];
  for (let i = N + 4; i < n; i++) {
    const mid = sma(closes, i, N), sd = std(closes, i, N), av = atr(i, N);
    const sqOn = (mid + 2 * sd) < (mid + 1.5 * av) && (mid - 2 * sd) > (mid - 1.5 * av);
    const delta = closes[i] - ((sma(highs, i, N) + sma(lows, i, N)) / 2);
    hist.push({ sqOn, delta });
  }
  if (hist.length < 2) return { state: 'off' };
  const last = hist[hist.length - 1], prev = hist[hist.length - 2];
  const momDir = last.delta > prev.delta ? 'up' : last.delta < prev.delta ? 'down' : 'flat';
  const justFired = prev.sqOn && !last.sqOn;
  return { state: justFired && last.delta > 0 && momDir === 'up' ? 'fire' : last.sqOn ? 'on' : 'off' };
}
function calcPF(closes) {
  if (!closes || closes.length < 10) return { trend: 'unknown', signal: '—' };
  const LS = 0.01, REV = 3;
  const box = p => Math.round(Math.log(p) / LS) * LS;
  let cols = [], dir = 'X', cs = box(closes[0]), ce = box(closes[0]);
  for (let i = 1; i < closes.length; i++) {
    const c = box(closes[i]);
    if (dir === 'X') { if (c >= ce + LS) ce = c; else if (c <= ce - REV * LS) { cols.push({ dir: 'X', top: ce, bot: cs }); dir = 'O'; cs = ce - LS; ce = c; } }
    else { if (c <= ce - LS) ce = c; else if (c >= ce + REV * LS) { cols.push({ dir: 'O', top: cs, bot: ce }); dir = 'X'; cs = ce + LS; ce = c; } }
  }
  cols.push({ dir, top: dir === 'X' ? ce : cs, bot: dir === 'X' ? cs : ce });
  if (cols.length < 2) return { trend: 'up', signal: 'BUY' };
  const last = cols[cols.length - 1], p3 = cols.length >= 3 ? cols[cols.length - 3] : null;
  if (last.dir === 'X' && p3 && last.top > p3.top) return { trend: 'up', signal: 'DBL TOP BUY' };
  if (last.dir === 'O' && p3 && last.bot < p3.bot) return { trend: 'down', signal: 'DBL BOT SELL' };
  return { trend: last.dir === 'X' ? 'up' : 'down', signal: last.dir === 'X' ? 'X COL' : 'O COL' };
}
function ratioAgainst(closes, benchCloses) {
  if (!benchCloses || benchCloses.length < 10) return null;
  const sLen = closes.length, bLen = benchCloses.length, useLen = Math.min(sLen, bLen);
  const sBase = closes[sLen - useLen], bBase = benchCloses[bLen - useLen];
  return closes.slice(sLen - useLen).map((c, i) => { const b = benchCloses[bLen - useLen + i]; return b ? (c / sBase) / (b / bBase) : 1; });
}
function calcRSScore(closes, spyCloses, sectorIdx) {
  const isBuy = s => s === 'BUY' || s === 'DBL TOP BUY';
  const pfOwn = calcPF(closes);
  const spyRatio = ratioAgainst(closes, spyCloses);
  const pfMkt = spyRatio ? calcPF(spyRatio) : { trend: 'x', signal: 'x' };
  const peerRatio = sectorIdx ? ratioAgainst(closes, sectorIdx) : null;
  const pfPeer = peerRatio ? calcPF(peerRatio) : { trend: 'x', signal: 'x' };
  const hp = !!peerRatio;
  return (pfOwn.trend === 'up' ? 1 : 0) + (pfMkt.trend === 'up' ? 1 : 0) + (isBuy(pfMkt.signal) ? 1 : 0) +
    (hp && pfPeer.trend === 'up' ? 1 : 0) + (hp && isBuy(pfPeer.signal) ? 1 : 0);
}
const ema = (arr, p) => { const k = 2 / (p + 1); let e = arr[0]; return arr.map(v => (e = v * k + e * (1 - k), e)); };
const toWeekly = arr => { const out = []; for (let i = arr.length - 1; i >= 0; i -= 5) out.unshift(arr[i]); return out; };
const quad = (r, m) => r >= 100 && m >= 100 ? 'Leading' : r >= 100 ? 'Weakening' : m < 100 ? 'Lagging' : 'Improving';
function calcJdKRRG(closes, benchCloses) {
  const wC = toWeekly(closes), wB = toWeekly(benchCloses);
  if (wC.length < 52 || wB.length < 52) return null;
  const len = Math.min(wC.length, wB.length);
  const s = wC.slice(wC.length - len), b = wB.slice(wB.length - len);
  const smoothRS = ema(s.map((v, i) => b[i] ? (v / b[i]) * 100 : 100), 10);
  const mean = smoothRS.slice(-52).reduce((a, c) => a + c, 0) / 52;
  const sd = Math.sqrt(smoothRS.slice(-52).reduce((a, c) => a + (c - mean) ** 2, 0) / 52) || 1;
  const ratioSeries = smoothRS.map(v => ((v - mean) / sd) * 10 + 100);
  const rsRatio = ratioSeries[ratioSeries.length - 1];
  const roc = ratioSeries.slice(1).map((v, i) => v - ratioSeries[i]);
  const sRoc = ema(roc, 10);
  const rm = sRoc.slice(-52).reduce((a, c) => a + c, 0) / 52;
  const rsd = Math.sqrt(sRoc.slice(-52).reduce((a, c) => a + (c - rm) ** 2, 0) / 52) || 1;
  return { ratio: rsRatio, momentum: ((sRoc[sRoc.length - 1] - rm) / rsd) * 10 + 100 };
}
function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return [];
  const rsi = []; let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  rsi.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }
  return rsi;
}
/* ------------------------- end copied math ---------------------------- */

const SECTORS = {
  "Tech":        ["AAPL","MSFT","NVDA","GOOGL","META","AVGO","ORCL","AMD","CRM","ADBE","INTC","QCOM","TXN","MU","AMAT","KLAC","LRCX","SNPS","CDNS","MRVL","NOW","PANW","CRWD","FTNT","WDAY","TEAM","ZS","OKTA","DDOG","MDB"],
  "Financials":  ["BRK-B","JPM","V","MA","BAC","WFC","GS","MS","BLK","SPGI","MCO","ICE","CME","CB","AXP","COF","USB","PNC","TFC","MTB"],
  "Healthcare":  ["LLY","UNH","JNJ","ABBV","MRK","TMO","ABT","DHR","BSX","SYK","ISRG","EW","REGN","VRTX","MRNA","BIIB","GILD","AMGN","BMY","CI"],
  "Cons.Disc":   ["AMZN","TSLA","HD","MCD","NKE","SBUX","TJX","BKNG","ABNB","LULU","CMG","YUM","DRI","ROST","ORLY","AZO","LVS","MGM","HLT","MAR"],
  "Industrials": ["CAT","DE","HON","UNP","UPS","FDX","RTX","LMT","GE","BA","ETN","EMR","PH","ROK","ITW","MMM","SWK","IR","XYL","CARR"],
  "Energy":      ["XOM","CVX","COP","EOG","SLB","MPC","PSX","VLO","OXY","PXD"],
  "Materials":   ["LIN","APD","ECL","SHW","NEM","FCX","NUE","CF","MOS","ALB"],
  "Staples":     ["PG","KO","PEP","WMT","COST","TGT","PM","MO","CL","KMB"],
  "Utilities":   ["NEE","DUK","SO","D","AEP"],
  "Real Estate": ["AMT","PLD","SPG","O","WELL"],
};
const SECTOR_ETF = { "Tech":"XLK","Financials":"XLF","Healthcare":"XLV","Cons.Disc":"XLY","Industrials":"XLI","Energy":"XLE","Materials":"XLB","Staples":"XLP","Utilities":"XLU","Real Estate":"XLRE" };
const NON_STOCKS = new Set(["SPY","QQQ","XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLU","XLRE","XLB","XLC"]);
const getSector = t => { for (const [s, ts] of Object.entries(SECTORS)) if (ts.includes(t)) return s; return 'Other'; };
function buildSectorIndices(data) {
  const out = {};
  for (const [sec, ts] of Object.entries(SECTORS)) {
    const members = ts.filter(t => data[t] && data[t].closes.length > 0);
    if (!members.length) continue;
    const allC = members.map(t => data[t].closes);
    const minLen = Math.min(...allC.map(c => c.length));
    const idx = [];
    for (let i = 0; i < minLen; i++) idx.push(allC.reduce((s, c) => s + (c[c.length - minLen + i] / c[c.length - minLen]), 0) / allC.length);
    out[sec] = idx;
  }
  return out;
}

const HORIZONS = [5, 10, 20, 30, 40, 50, 60];
const MAXH = Math.max(...HORIZONS), MINH = Math.min(...HORIZONS), MINPREFIX = 252;

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'))).tickers;
const SPY = data['SPY'] && data['SPY'].closes;
if (!SPY) { console.error('No SPY in prices.json.'); process.exit(1); }
const sectorIdxFull = buildSectorIndices(data);

// Sector RRG quadrant (real SPDR ETF vs SPY, matching the live dashboard), cached by (sector,k).
const sqCache = {};
function sectorQuadAt(sector, k) {
  const etf = SECTOR_ETF[sector];
  if (!etf || !data[etf]) return null;
  const key = sector + '|' + k;
  if (key in sqCache) return sqCache[key];
  const ec = data[etf].closes;
  const es = ec.slice(0, ec.length - k);
  if (es.length < 260) return (sqCache[key] = null); // not enough history for a valid RRG
  const r = calcJdKRRG(es, SPY.slice(0, SPY.length - k));
  return (sqCache[key] = r ? quad(r.ratio, r.momentum) : null);
}

const SIGS = ['ALL', 'TTM_FIRE', 'RS>=4', 'RS4_CROSS', 'RSI7>50', 'RSI20xMA', 'CROSS&RSI7>50', 'CROSS&RSI20xMA', 'RS4_secLDIM', 'RS4_secWKLG'];
const stats = {};
for (const s of SIGS) { stats[s] = { n: 0 }; for (const h of HORIZONS) stats[s]['h' + h] = { sumRaw: 0, sumExc: 0, win: 0, cnt: 0 }; }
function record(sig, fwd) {
  const st = stats[sig]; if (!st) return;
  st.n++;
  for (const h of HORIZONS) { const f = fwd[h]; if (!f) continue; const b = st['h' + h]; b.sumRaw += f.raw; b.sumExc += f.exc; if (f.exc > 0) b.win++; b.cnt++; }
}

const universe = Object.keys(data).filter(t => !NON_STOCKS.has(t));
let evaluated = 0;
for (const t of universe) {
  const { closes, highs, lows } = data[t];
  const L = closes.length;
  if (L < MINPREFIX + MINH + 2) continue;
  const sector = getSector(t);
  const secFull = sectorIdxFull[sector];
  let prevScore = null; // score on the older bar (k+1), for cross detection
  // iterate bars-from-end from oldest evaluable to most recent
  for (let k = L - MINPREFIX - 1; k >= MINH; k--) {
    const idx = L - 1 - k, spyIdx = SPY.length - 1 - k;
    const cS = closes.slice(0, idx + 1), hS = highs.slice(0, idx + 1), lS = lows.slice(0, idx + 1);
    const spyS = SPY.slice(0, SPY.length - k);
    const secS = secFull ? secFull.slice(0, secFull.length - k) : null;
    const fwd = {};
    for (const h of HORIZONS) {
      if (idx + h < L && spyIdx + h < SPY.length) {
        const raw = closes[idx + h] / closes[idx] - 1;
        const spy = SPY[spyIdx + h] / SPY[spyIdx] - 1;
        fwd[h] = { raw, exc: raw - spy };
      }
    }
    evaluated++;
    record('ALL', fwd);
    const fired = calcTTM(cS, hS, lS).state === 'fire';
    const score = calcRSScore(cS, spyS, secS);
    const crossed = prevScore !== null && score >= 4 && prevScore < 4;
    if (fired) record('TTM_FIRE', fwd);
    if (score >= 3) record('RS>=3', fwd);
    if (score >= 4) {
      record('RS>=4', fwd);
      if (fired) record('FIRE&RS>=4', fwd);
      const sq = sectorQuadAt(sector, k);
      if (sq === 'Leading' || sq === 'Improving') record('RS4_secLDIM', fwd);
      else if (sq === 'Weakening' || sq === 'Lagging') record('RS4_secWKLG', fwd);
    }
    if (crossed) { record('RS4_CROSS', fwd); if (fired) record('FIRE&RS4_CROSS', fwd); }
    // RSI catalysts: RSI7 > 50 (state) and RSI20 crossing above its 20-period MA (event)
    const r7 = calcRSI(cS, 7); const rsi7 = r7.length ? r7[r7.length - 1] : null;
    const r20 = calcRSI(cS, 20);
    const rsi7gt50 = rsi7 !== null && rsi7 > 50;
    let rsi20xma = false;
    if (r20.length >= 21) {
      const now = r20[r20.length - 1], prev = r20[r20.length - 2];
      const maNow = r20.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const maPrev = r20.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      rsi20xma = now > maNow && prev <= maPrev;
    }
    if (rsi7gt50) record('RSI7>50', fwd);
    if (rsi20xma) record('RSI20xMA', fwd);
    if (crossed && rsi7gt50) record('CROSS&RSI7>50', fwd);
    if (crossed && rsi20xma) record('CROSS&RSI20xMA', fwd);
    prevScore = score;
  }
}

const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const pad = (s, n) => String(s).padEnd(n), padL = (s, n) => String(s).padStart(n);
console.log('\n=== SIGNAL BACKTEST — holding sweep, RS cross, sector-RRG split ===');
console.log(`Universe: ${universe.length} stocks · evaluable stock-days: ${evaluated}`);
console.log('CAVEAT: survivorship bias inflates results; ~2y sample; +40/50/60d windows heavily overlap (effective N << N).\n');
for (const h of HORIZONS) {
  console.log(`--- Forward +${h} trading days ---`);
  console.log(pad('Signal', 16) + padL('N', 8) + padL('AvgRaw', 10) + padL('ExcessVsSPY', 13) + padL('Win%vsSPY', 11));
  for (const s of SIGS) {
    const b = stats[s]['h' + h]; if (!b.cnt) continue;
    console.log(pad(s, 16) + padL(b.cnt, 8) + padL(pct(b.sumRaw / b.cnt), 10) + padL(pct(b.sumExc / b.cnt), 13) + padL((b.win / b.cnt * 100).toFixed(1) + '%', 11));
  }
  console.log('');
}
console.log('ExcessVsSPY and Win%vsSPY are the edge over SPY. Compare RS4_secLDIM vs RS4_secWKLG to judge the sector RRG.\n');
