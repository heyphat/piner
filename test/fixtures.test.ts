import { test, expect } from 'bun:test';
import { compile, Engine, PortfolioEngine } from '../src/index.js';
import {
  FIXTURE_BARS,
  FIXTURE_SYMBOLS,
  FIXTURE_T0_MS,
  FIXTURE_STEP_MS,
  FIXTURE_BAR_COUNT,
  FIXTURE_SPECS,
  FIXTURE_TF,
  genBars,
  fixtureFeed,
  fixtureSleeves,
  raggedSleeves,
} from './fixtures.js';

/** Guards the shared piner fixture (invariants + freeze check) and demonstrates
 *  it driving both a single Engine and the PortfolioEngine. Prices match
 *  pinerun's fixture bit-for-bit (same generator/seeds); only the time axis (ms)
 *  and timeframe code ('60') differ. */

test('every fixture series is ascending, unique, positive, OHLC-valid', () => {
  for (const sym of FIXTURE_SYMBOLS) {
    const bars = FIXTURE_BARS[sym]!;
    expect(bars.length).toBe(FIXTURE_BAR_COUNT);
    let prev = -Infinity;
    for (const b of bars) {
      expect(b.time).toBeGreaterThan(prev);
      prev = b.time;
      expect(b.low).toBeGreaterThan(0);
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.volume).toBeGreaterThan(0);
    }
  }
});

test('full-length symbols share one 1h (ms) clock from FIXTURE_T0_MS', () => {
  const grid = Array.from(
    { length: FIXTURE_BAR_COUNT },
    (_, i) => FIXTURE_T0_MS + i * FIXTURE_STEP_MS,
  );
  for (const sym of FIXTURE_SYMBOLS) {
    expect(FIXTURE_BARS[sym]!.map((b) => b.time)).toEqual(grid);
  }
});

test('genBars is deterministic; FIXTURE_BARS matches a fresh generation', () => {
  for (const [sym, spec] of Object.entries(FIXTURE_SPECS)) {
    expect(genBars(spec)).toEqual(FIXTURE_BARS[sym]!);
    expect(genBars(spec)).toEqual(genBars(spec));
  }
});

test('freeze guard: pinned closes match pinerun bit-for-bit (prices are shared)', () => {
  // Same numbers as pinerun/test/fixtures.test.ts — the price math is identical.
  const pinned: Record<string, [first: number, last: number]> = {
    UPTREND: [100.254148, 150.019036],
    DOWNTREND: [241.349285, 201.759361],
    CHOP: [50.33034, 48.995863],
    VOLATILE: [307.625452, 348.266061],
    MEANREV: [20.15182, 19.582358],
  };
  for (const sym of FIXTURE_SYMBOLS) {
    const bars = FIXTURE_BARS[sym]!;
    const [first, last] = pinned[sym]!;
    expect(bars[0]!.close).toBeCloseTo(first, 4);
    expect(bars.at(-1)!.close).toBeCloseTo(last, 4);
  }
});

// ── usage: drive a single Engine ─────────────────────────────────────────────
const SMA_CROSS = `//@version=6
strategy("sma", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=95)
fast = ta.sma(close, 10)
slow = ta.sma(close, 30)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")`;

test('fixtureFeed drives a single Engine and produces trades', async () => {
  const c = compile(SMA_CROSS);
  const eng = new Engine(c, fixtureFeed('UPTREND'), {});
  await eng.run({ symbol: 'UPTREND', timeframe: FIXTURE_TF });
  expect(eng.strategy.closedTrades.length).toBeGreaterThan(0);
  expect(Number.isFinite(eng.strategy.netProfit)).toBe(true);
});

// ── usage: drive the PortfolioEngine ─────────────────────────────────────────
test('fixtureSleeves drive PortfolioEngine (isolated) into a coherent report', () => {
  const c = compile(SMA_CROSS);
  const syms = ['UPTREND', 'CHOP', 'VOLATILE'];
  const res = new PortfolioEngine(c, { mode: 'isolated' }).run(fixtureSleeves(syms));

  expect(res.symbols).toEqual(syms);
  expect(res.times.length).toBe(FIXTURE_BAR_COUNT); // shared clock ⇒ union = 600
  expect(res.report.equityCurve.length).toBe(res.times.length);
  expect(res.report.equityCurve[0]).toBeCloseTo(30000, 6); // Σ Cᵢ = 3 × 10000
  expect(res.report.netProfit).toBeCloseTo(
    res.sleeves.reduce((a, s) => a + s.report.netProfit, 0),
    6,
  );
  expect(Number.isFinite(res.report.netProfit)).toBe(true);
});

test('raggedSleeves give disjoint clocks; PortfolioEngine spans the union', () => {
  const c = compile(SMA_CROSS);
  const sleeves = raggedSleeves(['UPTREND', 'DOWNTREND', 'MEANREV']);
  expect(sleeves.map((s) => s.bars.length)).toEqual([600, 500, 500]); // full / late / early-delist
  const res = new PortfolioEngine(c, { mode: 'shared', capital: 30000 }).run(sleeves);
  expect(res.times.length).toBe(FIXTURE_BAR_COUNT); // union spans the longest sleeve
  expect(res.report.equityCurve.every((v) => Number.isFinite(v))).toBe(true);
});
