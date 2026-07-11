/**
 * TradingView parity for the RSI-DCA strategy across chart timeframes, all sourcing a 4h RSI via
 * `request.security(syminfo.tickerid, "240", ta.rsi(close,14))`.
 *
 * On a 1D chart "240" is FINER than the chart; on 2H/1H it is HIGHER. Neither can be produced by
 * resampling the chart's own bars faithfully — a finer tf has no data, and a resampled higher tf
 * surfaces a just-closed HTF bar one chart-bar too late. So the host injects the ACTUAL 4h series
 * (`ctx.securityBars["XAUUSDT@240"]`) and the engine aligns it by bar CLOSE time
 * (ExecutionContext.computeInjectedSameSymbol) — matching TradingView bar-for-bar on every tf.
 *
 * Fixtures are real Binance USDⓈ-M futures klines for XAUUSDT (listed 2025-12-11):
 *   rsi-dca-xau-{1d,2h,1h}.json — the chart bars per timeframe
 *   rsi-dca-xau-4h.json         — the 4h series feeding the RSI request (injected)
 *   rsi-dca-{1d,2h,1h}.csv      — TradingView's own trade lists (the oracle)
 *
 * We pin the ENTRY sequence (id + timestamp) and count against TV. Fill PRICES aren't pinned to the
 * cent: TV's XAUUSDT feed differs slightly from the Binance REST klines.
 */
import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const asset = (f: string) => join(HERE, 'pinescripts/strategies', f);
const loadBars = (f: string): Bar[] =>
  (JSON.parse(readFileSync(asset(f), 'utf8')) as number[][]).map(
    ([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }),
  );

const h4 = loadBars('rsi-dca-xau-4h.json');
const src = readFileSync(asset('rsi-dca.pine'), 'utf8');

/** TV's export dates are "YYYY-MM-DD" on 1D and "YYYY-MM-DD HH:MM" intraday — format to match. */
const fmt = (t: number, intraday: boolean) =>
  intraday
    ? new Date(t).toISOString().slice(0, 16).replace('T', ' ')
    : new Date(t).toISOString().slice(0, 10);

/** Parse TV's trade list into the entry-ordered [id, dateString] list (as written in the CSV). */
function tvEntries(csv: string): [string, string][] {
  return readFileSync(asset(csv), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
    .filter((c) => c[1] === 'Entry long')
    .map((c) => [c[3], c[2]] as [string, string]);
}

/** Run both backends with the 4h series injected; return the entry-ordered [id, dateString] list. */
async function pinerEntries(
  barsFile: string,
  chartTf: string,
  intraday: boolean,
): Promise<[string, string][]> {
  const bars = loadBars(barsFile);
  const engines = (['js', 'interp'] as const).map((backend) => {
    const e = new Engine(compile(src), new ArrayFeed(bars), {
      backend,
      inputs: { 'RSI Timeframe': '240', 'Limit Backtest Period': false },
    });
    e.ctx.securityBars.set('XAUUSDT@240', h4); // inject the actual 4h series
    return e;
  });
  await Promise.all(
    engines.map((e) => e.run({ symbol: 'XAUUSDT', timeframe: chartTf, mintick: 0.01 })),
  );
  const [js, ip] = engines;
  expect(JSON.stringify(js.strategy)).toBe(JSON.stringify(ip.strategy)); // two-backend invariant

  const st = js.ctx.strategy;
  return [
    ...js.strategy.closedTrades.map((t) => ({ id: t.entryId, bar: t.entryBar })),
    ...Array.from({ length: st.opentrades }, (_, i) => ({
      id: st.tradeField('opentrades', 'entry_id', i) as string,
      bar: st.tradeField('opentrades', 'entry_bar_index', i) as number,
    })),
  ]
    .sort((a, b) => a.bar - b.bar)
    .map((t) => [t.id, fmt(bars[t.bar].time, intraday)] as [string, string]);
}

describe('RSI-DCA — TradingView parity on real XAUUSDT data (injected 4h RSI)', () => {
  const cases = [
    {
      name: '1D chart (4h RSI is FINER than the chart)',
      bars: 'rsi-dca-xau-1d.json',
      tf: '1D',
      csv: 'rsi-dca-1d.csv',
      intraday: false,
    },
    {
      name: '2H chart (4h RSI is HIGHER — real fetch, not resample)',
      bars: 'rsi-dca-xau-2h.json',
      tf: '120',
      csv: 'rsi-dca-2h.csv',
      intraday: true,
    },
    {
      name: '1H chart (4h RSI is HIGHER — real fetch, not resample)',
      bars: 'rsi-dca-xau-1h.json',
      tf: '60',
      csv: 'rsi-dca-1h.csv',
      intraday: true,
    },
  ];

  for (const c of cases) {
    it(`reproduces TV's entry sequence on the ${c.name}`, async () => {
      const piner = await pinerEntries(c.bars, c.tf, c.intraday);
      const tv = tvEntries(c.csv);
      expect(piner.length).toBe(tv.length);
      expect(piner).toEqual(tv); // id + timestamp, in order — bar-for-bar
    });
  }

  it('WITHOUT the injected 4h series, a 1D chart degrades to the daily RSI (far fewer entries)', async () => {
    const bars = loadBars('rsi-dca-xau-1d.json');
    const e = new Engine(compile(src), new ArrayFeed(bars), {
      backend: 'js',
      inputs: { 'RSI Timeframe': '240', 'Limit Backtest Period': false },
    });
    await e.run({ symbol: 'XAUUSDT', timeframe: '1D', mintick: 0.01 });
    const total = e.strategy.closedTrades.length + e.ctx.strategy.opentrades;
    expect(total).toBeLessThan(tvEntries('rsi-dca-1d.csv').length); // 3 vs 11 — the bug this fix addresses
  });
});
