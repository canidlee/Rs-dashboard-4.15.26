#!/usr/bin/env python3
"""
Fetches 2 years of daily OHLC data for the dashboard's fixed universes
(Russell 1000 sample, sector ETFs, SPY, QQQ) directly from Yahoo Finance's
chart API -- server-side, so no CORS proxy is involved -- and writes a single
JSON file the dashboard reads as a static, same-origin data source.

This does NOT cover a user's custom watchlist or pasted IBD-250 list --
those are per-browser (localStorage) and unknown to this script, so the
dashboard still live-fetches those through the existing browser-side path.
"""
import json
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

R1000 = [
    "AAPL","MSFT","NVDA","GOOGL","META","AVGO","ORCL","AMD","CRM","ADBE",
    "INTC","QCOM","TXN","MU","AMAT","KLAC","LRCX","SNPS","CDNS","MRVL",
    "NOW","PANW","CRWD","FTNT","WDAY","TEAM","ZS","OKTA","DDOG","MDB",
    "BRK-B","JPM","V","MA","BAC","WFC","GS","MS","BLK","SPGI",
    "MCO","ICE","CME","CB","AXP","COF","USB","PNC","TFC","MTB",
    "LLY","UNH","JNJ","ABBV","MRK","TMO","ABT","DHR","BSX","SYK",
    "ISRG","EW","REGN","VRTX","MRNA","BIIB","GILD","AMGN","BMY","CI",
    "AMZN","TSLA","HD","MCD","NKE","SBUX","TJX","BKNG","ABNB","LULU",
    "CMG","YUM","DRI","ROST","ORLY","AZO","LVS","MGM","HLT","MAR",
    "CAT","DE","HON","UNP","UPS","FDX","RTX","LMT","GE","BA",
    "ETN","EMR","PH","ROK","ITW","MMM","SWK","IR","XYL","CARR",
    "XOM","CVX","COP","EOG","SLB","MPC","PSX","VLO","OXY","PXD",
    "LIN","APD","ECL","SHW","NEM","FCX","NUE","CF","MOS","ALB",
    "PG","KO","PEP","WMT","COST","TGT","PM","MO","CL","KMB",
    "NEE","DUK","SO","D","AEP","AMT","PLD","SPG","O","WELL",
]
SECTOR_ETFS = ["XLK","XLF","XLV","XLE","XLI","XLY","XLP","XLU","XLRE","XLB","XLC"]
EXTRA = ["SPY", "QQQ"]

TICKERS = sorted(set(R1000 + SECTOR_ETFS + EXTRA))
OUTPUT_PATH = "data/prices.json"
MIN_SUCCESS_RATIO = 0.5  # abort without writing if more than half of tickers fail


def fetch_one(ticker, retries=2, timeout=10):
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?interval=1d&range=2y"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_err = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode())
            result = (payload.get("chart") or {}).get("result")
            if not result:
                return None, "empty chart response"
            res = result[0]
            quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
            closes_raw = quote.get("close") or []
            highs_raw = quote.get("high") or []
            lows_raw = quote.get("low") or []
            closes, highs, lows = [], [], []
            for c, h, l in zip(closes_raw, highs_raw, lows_raw):
                if c is not None and h is not None and l is not None:
                    closes.append(c)
                    highs.append(h)
                    lows.append(l)
            meta = res.get("meta") or {}
            return {
                "closes": closes,
                "highs": highs,
                "lows": lows,
                "name": meta.get("shortName", ticker),
                "price": meta.get("regularMarketPrice", 0),
            }, None
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
        except Exception as e:
            last_err = str(e)
        if attempt < retries:
            time.sleep(2)
    return None, last_err


def main():
    out = {}
    failures = {}
    for i, ticker in enumerate(TICKERS):
        data, err = fetch_one(ticker)
        if data:
            out[ticker] = data
        else:
            failures[ticker] = err
        if (i + 1) % 20 == 0:
            print(f"...{i + 1}/{len(TICKERS)} processed")
        time.sleep(0.3)  # be polite -- avoid hammering Yahoo in a tight loop

    print(f"Fetched {len(out)}/{len(TICKERS)} tickers successfully.")
    if failures:
        print(f"Failed ({len(failures)}): {failures}")

    if len(out) < len(TICKERS) * MIN_SUCCESS_RATIO:
        raise SystemExit(
            f"Only {len(out)}/{len(TICKERS)} tickers succeeded -- "
            f"aborting without writing (likely Yahoo blocking/rate-limiting "
            f"this runner). Leaving the previous data/prices.json in place."
        )

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tickers": out,
    }
    with open(OUTPUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {OUTPUT_PATH} ({len(out)} tickers).")


if __name__ == "__main__":
    main()
