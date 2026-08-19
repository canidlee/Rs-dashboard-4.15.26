#!/usr/bin/env node
/*
 * Scores your accumulated EXPORT SIGNALS csv files against realized prices.
 *
 * Workflow:
 *   1. Click "EXPORT SIGNALS" on the dashboard regularly -> rs-signals_YYYY-MM-DD.csv
 *   2. Drop those files into a folder (default: scripts/signals/)
 *   3. Run:  node scripts/score_signals.js [folder]
 *
 * It reads the STOCK rows (FIRING / COILED), looks each ticker up in the CURRENT
 * data/prices.json, and measures how the signal actually played out.
 *
 * Two modes, chosen automatically:
 *   - DATE-ALIGNED (preferred): if prices.json has a "dates" array (produced by the
 *     updated fetch_prices.py), it finds each signal's bar and reports forward returns
 *     at +5/+10/+20 trading days, raw and excess vs SPY.  ** Requires a fresh
 *     prices.json generated AFTER the fetch_prices.py dates change. **
 *   - ENTRY->NOW (fallback): if there are no dates, it just measures entry-price ->
 *     latest-close for each signal (horizon uncontrolled). Rough, but works today.
 *
 * This is OUT-OF-SAMPLE (signals were logged live, then graded later), so unlike the
 * historical backtest it is free of survivorship/look-ahead bias -- but it only has
 * as much data as you have accumulated.
 */
const fs = require('fs');
const path = require('path');

const folder = process.argv[2] || path.join(__dirname, 'signals');
const HORIZONS = [5, 10, 20];

if (!fs.existsSync(folder)) {
  console.error(`No folder "${folder}". Create it and drop your rs-signals_*.csv exports in, then re-run.`);
  process.exit(1);
}
const files = fs.readdirSync(folder).filter(f => /rs-signals.*\.csv$/i.test(f));
if (!files.length) { console.error(`No rs-signals_*.csv files in ${folder}.`); process.exit(1); }

// crude CSV line splitter (handles quoted fields)
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur); return out;
}

const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(folder, f), 'utf8').split(/\r?\n/).filter(Boolean);
  if (!lines.length) continue;
  const head = splitCsv(lines[0]);
  const ci = name => head.indexOf(name);
  for (let i = 1; i < lines.length; i++) {
    const r = splitCsv(lines[i]);
    if (r[ci('Type')] !== 'STOCK') continue;
    rows.push({ snapshot: r[ci('Snapshot')], ticker: r[ci('Symbol')], signal: r[ci('Signal')], entry: parseFloat(r[ci('Price')]) });
  }
}
console.log(`Loaded ${rows.length} STOCK signal rows from ${files.length} file(s).`);

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prices.json'))).tickers;
const SPY = data['SPY'];
const hasDates = !!(SPY && SPY.dates && SPY.dates.length);
console.log(hasDates ? 'Mode: DATE-ALIGNED forward returns.\n' : 'Mode: ENTRY->NOW (prices.json has no dates yet; regenerate with the updated fetch_prices.py for fixed horizons).\n');

const agg = {}; // signal -> stats
const bump = (sig, key, val, winRef) => {
  agg[sig] = agg[sig] || { n: 0 };
  if (key === 'n') { agg[sig].n++; return; }
  const b = (agg[sig][key] = agg[sig][key] || { sum: 0, exc: 0, win: 0, cnt: 0 });
  b.sum += val.raw; b.exc += val.exc; if (val.exc > 0) b.win++; b.cnt++;
};

for (const row of rows) {
  const tk = data[row.ticker];
  if (!tk || !tk.closes || !tk.closes.length) continue;
  bump(row.signal, 'n');
  if (hasDates) {
    const di = tk.dates.indexOf(row.snapshot);
    const si = SPY.dates.indexOf(row.snapshot);
    if (di < 0 || si < 0) continue;
    for (const h of HORIZONS) {
      if (di + h >= tk.closes.length || si + h >= SPY.closes.length) continue;
      const raw = tk.closes[di + h] / tk.closes[di] - 1;
      const spy = SPY.closes[si + h] / SPY.closes[si] - 1;
      bump(row.signal, 'h' + h, { raw, exc: raw - spy });
    }
  } else {
    // entry price (as logged) -> latest close
    const now = tk.closes[tk.closes.length - 1];
    const raw = now / row.entry - 1;
    const spyNow = SPY.closes[SPY.closes.length - 1] / SPY.closes[0] - 1; // rough, whole-window SPY drift
    bump(row.signal, 'now', { raw, exc: raw }); // exc omitted meaningfully in fallback
  }
}

const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const pad = (s, n) => String(s).padEnd(n), padL = (s, n) => String(s).padStart(n);
console.log('=== SIGNAL SCORECARD (out-of-sample) ===');
for (const [sig, st] of Object.entries(agg)) {
  console.log(`\n${sig}  (n=${st.n})`);
  if (hasDates) {
    console.log('  ' + pad('Horizon', 10) + padL('AvgRaw', 10) + padL('AvgExcess', 12) + padL('Win%vsSPY', 11));
    for (const h of HORIZONS) {
      const b = st['h' + h]; if (!b || !b.cnt) continue;
      console.log('  ' + pad('+' + h + 'd', 10) + padL(pct(b.sum / b.cnt), 10) + padL(pct(b.exc / b.cnt), 12) + padL((b.win / b.cnt * 100).toFixed(1) + '%', 11));
    }
  } else {
    const b = st['now']; if (b && b.cnt) console.log('  entry->now  AvgRaw ' + pct(b.sum / b.cnt) + `  (over ${b.cnt} signals; horizon uncontrolled)`);
  }
}
console.log('\nGrade AvgExcess vs SPY as the edge. Accumulate more daily exports to tighten these.\n');
