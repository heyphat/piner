/**
 * request.security() support (Phase 7) — higher-timeframe data on the same symbol.
 *
 * The base (chart) bars are resampled into higher-timeframe (HTF) bars by
 * time-bucketing, the requested expression is evaluated once per HTF bar in a
 * sub-context, and the result is mapped back onto each chart bar with the
 * confirmed-vs-unconfirmed (lookahead) semantics (docs/pine-semantics.md §8):
 *
 *   - lookahead_off (default): a chart bar in HTF bucket b sees bucket b-1's
 *     value (the last *confirmed* HTF bar) — no future leak.
 *   - lookahead_on: it sees bucket b's final value (future leak on history).
 *
 * Calendar bucketing (D/W/M) is UTC-approximate; intraday is exact. Cross-symbol
 * requests need an external feed and are rejected in this build.
 */

export interface HtfBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface BaseBar {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

const DAY = 86400000;

/** Bucket key for a timestamp (ms, UTC) at the given timeframe string. */
export function bucketKey(time: number, tf: string): number {
  const m = /^(\d*)([a-zA-Z]?)$/.exec(tf) ?? [];
  const mult = m[1] ? Number(m[1]) : 1;
  const unit = (m[2] || '').toUpperCase(); // '' ⇒ minutes
  const d = new Date(time);
  switch (unit) {
    case 'S': return Math.floor(time / (mult * 1000));
    case 'D': return Math.floor(time / (mult * DAY));
    // Weeks start MONDAY (ISO 8601 / TradingView crypto-forex). Epoch day 0 = Thu; a Monday is
    // epoch day ≡ 4 (mod 7), so the +3 offset makes floor((day+3)/7) increment on Mondays. (+4
    // would increment on Sundays, splitting Sun off into a new week — wrong vs TradingView.)
    case 'W': return Math.floor((Math.floor(time / DAY) + 3) / (7 * mult));
    case 'M': return d.getUTCFullYear() * 12 + Math.floor(d.getUTCMonth() / mult);
    default: return Math.floor(time / (mult * 60000)); // minutes
  }
}

/**
 * Resample base bars into HTF bars. Returns the HTF OHLCV bars (ascending) and,
 * per base-bar index, the index of the HTF bucket it belongs to.
 */
export function resampleToTimeframe(bars: BaseBar[], tf: string): { htf: HtfBar[]; bucketOf: number[] } {
  const htf: HtfBar[] = [];
  const bucketOf: number[] = new Array(bars.length);
  let curKey: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const k = bucketKey(b.time, tf);
    if (k !== curKey) {
      htf.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
      curKey = k;
    } else {
      const h = htf[htf.length - 1];
      h.high = Math.max(h.high, b.high);
      h.low = Math.min(h.low, b.low);
      h.close = b.close;
      h.volume += b.volume ?? 0;
    }
    bucketOf[i] = htf.length - 1;
  }
  return { htf, bucketOf };
}
