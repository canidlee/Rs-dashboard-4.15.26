#!/usr/bin/env node
/*
 * Historical backtest of the dashboard's signals against data/prices.json.
 * Reuses the EXACT signal math from index.html so results match the live tool.
 *
 * Signals tested:
 *   TTM_FIRE  -> TTM squeeze fired that day (calcTTM state === 'fire')
 *   RS>=3     -> RS Score (5-factor) is >= 3 that day
 *   RS>=4     -> RS Score is >= 4 that day
 * Baseline:
 *   ALL       -> every evaluable stock-day (what "just holding the universe" earns)
 *
 * For each signal it reports forward return at +5/+10/+20/+40 trading days,
 * both raw and EXCESS vs SPY over the same window, plus a win rate (% beating SPY).
 *
 * READ BEFORE TRUSTING THE NUMBERS:
 *  - Survivorship bias: the universe is TODAY's tickers only. Companies that were
 *    delisted / went to zero are absent, so results skew OPTIMISTIC. This is the
 *    single biggest caveat and cannot be fixed with the data on hand.
 *  - Short sample: ~2y of daily data -> limited events per name.
 *  - Series are aligned by bars-from-end (all share the current end date / NYSE
 *    calendar); a mid-history missing bar in one name can drift alignment by a day.
 *  - The sector-peer leg of RS Score includes the stock itself (same as the live tool).
 *
 * Usage:  node scripts/backtest.js
 * Output: console summary + scripts/backtest_events.csv (every TTM_FIRE / RS>=3 event)
 */
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 *  Signal math copied verbatim from index.html (keep in sync).        *
 * ------------------------------------------------------------------ */
function calcTTM(closes, highs, lows) {
  const N = 20;
  if (!closes || closes.length < N + 5) return { state: 'unknown', momDir: 'flat' };
  const n = closes.length;
  const sma = (arr, i, p) => { let s = 0; for (let j = i - p + 1; j <= i; j++) s += arr[j]; return s / p; };
  const std = (arr, i, p) => { const m = sma(arr, i, p); let v = 0; for (let j = i - p + 1; j <= i; j++) v += (arr[j] - m) ** 2; return Math.sqrt(v / p); };
  const atr = (i, p) => { let s = 0; for (let j = i - p + 1; j <= i; j++) { const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - (closes[j - 1] ?? closes[j])), Math.abs(lows[j] - (closes[j - 1] ?? closes[j]))); s += tr; } return s / p; };
  const hist = [];
  for (let i = N + 4; i < n; i++) {
    const mid = sma(closes, i, N), sd = std(closes, i, N), av = atr(i, N);
    const bbU = mid + 2 * sd, bbL = mid - 2 * sd, kcU = mid + 1.5 * av, kcL = mid - 1.5 * av;
    const sqOn = bbU < kcU && bbL > kcL;
    const delta = closes[i] - ((sma(highs, i, N) + sma(lows, i, N)) / 2);
    hist.push({ sqOn, delta });
  }
  if (hist.length < 2) return { state: 'off', momDir: 'flat' };
  const last = hist[hist.length - 1], prev = hist[hist.length - 2];
  const momDir = last.delta > prev.delta ? 'up' : last.delta < prev.delta ? 'down' : 'flat';
  const justFired = prev.sqOn && !last.sqOn;
  const state = justFired && last.delta > 0 && momDir === 'up' ? 'fire' : last.sqOn ? 'on' : 'off';
  return { state, momDir };
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
  const sLen = closes.length, bLen = benchCloses.length;
  const useLen = Math.min(sLen, bLen);
  const sBase = closes[sLen - useLen], bBase = benchCloses[bLen - useLen];
  return closes.slice(sLen - useLen).map((c, i) => {
    const bVal = benchCloses[bLen - useLen + i];
    return bVal ? (c / sBase) / (bVal / bBase) : 1;
  });
}
function calcRSScore(closes, spyCloses, sectorIdx) {
  const isBuy = sig => sig === 'BUY' || sig === 'DBL TOP BUY';
  const pfOwn = calcPF(closes);
  const spyRatio = ratioAgainst(closes, spyCloses);
  const pfMkt = spyRatio ? calcPF(spyRatio) : { trend: 'unknown', signal: '—' };
  const peerRatio = sectorIdx ? ratioAgainst(closes, sectorIdx) : null;
  const pfPeer = peerRatio ? calcPF(peerRatio) : { trend: 'unknown', signal: '—' };
  const hasPeer = !!peerRatio;
  const score =
    (pfOwn.trend === 'up' ? 1 : 0) +
    (pfMkt.trend === 'up' ? 1 : 0) +
    (isBuy(pfMkt.signal) ? 1 : 0) +
    (hasPeer && pfPeer.trend === 'up' ? 1 : 0) +
    (hasPeer && isBuy(pfPeer.signal) ? 1 : 0);
  return score;
}
/* -------------------------- end copied math ----------------------- */

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

const HORIZONS = [5, 10, 20, 40];
const MAXH = Math.max(...HORIZONS);
const MINPREFIX = 252; // calcRS/RSScore need >= 252 bars of history

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'))).tickers;
const SPY = data['SPY'] && data['SPY'].closes;
if (!SPY) { console.error('No SPY in prices.json — cannot benchmark.'); process.exit(1); }
const sectorIdxFull = buildSectorIndices(data);

// running accumulators per signal
const SIGS = ['ALL', 'TTM_FIRE', 'RS>=3', 'RS>=4'];
const stats = {};
for (const s of SIGS) { stats[s] = { n: 0 }; for (const h of HORIZONS) stats[s]['h' + h] = { sumRaw: 0, sumExc: 0, win: 0, cnt: 0 }; }
const eventRows = [['Ticker', 'Sector', 'Signal', 'BarsFromEnd', ...HORIZONS.flatMap(h => [`raw+${h}`, `exc+${h}`])]];

function record(sig, ticker, sector, bfe, fwd) {
  const st = stats[sig]; st.n++;
  for (const h of HORIZONS) { const b = st['h' + h]; b.sumRaw += fwd[h].raw; b.sumExc += fwd[h].exc; if (fwd[h].exc > 0) b.win++; b.cnt++; }
  if (sig === 'TTM_FIRE' || sig === 'RS>=3') {
    eventRows.push([ticker, sector, sig, bfe, ...HORIZONS.flatMap(h => [(fwd[h].raw * 100).toFixed(2), (fwd[h].exc * 100).toFixed(2)])]);
  }
}

const universe = Object.keys(data).filter(t => !NON_STOCKS.has(t));
let evaluated = 0;
for (const t of universe) {
  const { closes, highs, lows } = data[t];
  const L = closes.length;
  if (L < MINPREFIX + MAXH + 2) continue;
  const sector = getSector(t);
  const secFull = sectorIdxFull[sector];
  // bfe = bars from the end; need >= MAXH ahead and >= MINPREFIX behind
  for (let k = MAXH; k <= L - MINPREFIX - 1; k++) {
    const idx = L - 1 - k;
    const cSlice = closes.slice(0, idx + 1), hSlice = highs.slice(0, idx + 1), lSlice = lows.slice(0, idx + 1);
    const spySlice = SPY.slice(0, SPY.length - k);
    const secSlice = secFull ? secFull.slice(0, secFull.length - k) : null;
    // forward returns (raw + excess vs SPY), aligned by bars-from-end
    const spyIdx = SPY.length - 1 - k;
    const fwd = {};
    let ok = true;
    for (const h of HORIZONS) {
      if (idx + h >= L || spyIdx + h >= SPY.length) { ok = false; break; }
      const raw = closes[idx + h] / closes[idx] - 1;
      const spy = SPY[spyIdx + h] / SPY[spyIdx] - 1;
      fwd[h] = { raw, exc: raw - spy };
    }
    if (!ok) continue;
    evaluated++;
    record('ALL', t, sector, k, fwd);
    if (calcTTM(cSlice, hSlice, lSlice).state === 'fire') record('TTM_FIRE', t, sector, k, fwd);
    const score = calcRSScore(cSlice, spySlice, secSlice);
    if (score >= 3) record('RS>=3', t, sector, k, fwd);
    if (score >= 4) record('RS>=4', t, sector, k, fwd);
  }
}

// ---- output ----
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
console.log('\n=== SIGNAL BACKTEST (data/prices.json) ===');
console.log(`Universe: ${universe.length} stocks · evaluable stock-days: ${evaluated}`);
console.log('CAVEAT: survivorship bias (today\'s tickers only) inflates results; ~2y sample is thin.\n');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
for (const h of HORIZONS) {
  console.log(`--- Forward +${h} trading days ---`);
  console.log(pad('Signal', 10) + padL('N', 8) + padL('AvgRaw', 10) + padL('AvgExcess', 12) + padL('Win%vsSPY', 11));
  for (const s of SIGS) {
    const b = stats[s]['h' + h];
    if (!b.cnt) continue;
    console.log(pad(s, 10) + padL(stats[s].n, 8) + padL(pct(b.sumRaw / b.cnt), 10) + padL(pct(b.sumExc / b.cnt), 12) + padL((b.win / b.cnt * 100).toFixed(1) + '%', 11));
  }
  console.log('');
}
const csv = eventRows.map(r => r.join(',')).join('\n');
fs.writeFileSync(path.join(__dirname, 'backtest_events.csv'), csv);
console.log(`Wrote ${eventRows.length - 1} signal events to scripts/backtest_events.csv`);
console.log('Read AvgExcess (return beyond SPY) and Win%vsSPY as the edge; AvgRaw includes the market\'s drift.\n');
