/**
 * Shared, deterministic OHLCV fixtures for piner engine tests.
 *
 * The piner-native twin of pinerun's `test/fixtures.ts`: the SAME seeded regime
 * dataset (identical prices — same generator, same seeds) so a strategy behaves
 * the same whether driven here through a raw `Engine`/`PortfolioEngine` or there
 * through pinerun. Differences are piner conventions only:
 *   - bar times are UNIX MILLISECONDS (piner's clock), not seconds;
 *   - the timeframe code is `'60'` (TV's 1-hour code — piner's `tfSeconds` has no
 *     'h' unit, so `'1h'` would be misread as one MINUTE);
 *   - helpers hand back an `ArrayFeed` / `PortfolioEngine` sleeves, not a provider.
 *
 * Each series (UPTREND/DOWNTREND/CHOP/VOLATILE/MEANREV) is a distinct price
 * regime so trend, mean-reversion, and breakout logic each find trades. All bars
 * are ascending, unique, strictly positive, and OHLC-valid. `raggedSleeves()`
 * breaks the shared clock (late listing, gaps, early delisting) for
 * PortfolioEngine union-clock / disjoint-clock (spec S7) tests.
 *
 * "Fixed" without a giant data file: a seeded PRNG makes every run identical;
 * `fixtures.test.ts` pins spot values so an accidental generator edit can't drift
 * the dataset silently.
 */
import { ArrayFeed, type Bar } from '../src/index.js';

export const FIXTURE_T0_MS = 1_700_000_000_000; // unix ms (= pinerun's FIXTURE_T0 × 1000)
export const FIXTURE_STEP_MS = 3_600_000; // 1h in ms
export const FIXTURE_TF = '60'; // TV 1-hour code; tfSeconds('60') = 3600s. NB: '1h' ⇒ 1 minute in piner.
export const FIXTURE_BAR_COUNT = 600;

/** Seeded PRNG (mulberry32) — reproducible "noise", never `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BarSpec {
  base: number; // starting price level
  drift: number; // per-bar linear trend (absolute, added each bar)
  cycleAmp: number; // sine amplitude (absolute price units)
  cyclePeriod: number; // sine period in bars
  noise: number; // fractional close jitter (± this fraction of the level)
  wick: number; // fractional high/low wick beyond the body
  vol: number; // base volume
  seed: number; // PRNG seed (per symbol → independent but reproducible noise)
  count?: number; // bars (default FIXTURE_BAR_COUNT)
  t0?: number; // first bar time, unix ms (default FIXTURE_T0_MS)
  step?: number; // ms per bar (default FIXTURE_STEP_MS)
}

/**
 * Deterministic OHLCV — identical price math to pinerun's fixture (only the time
 * axis is ms here):
 *   level(i) = base + drift·i + cycleAmp·sin(2π·i / cyclePeriod)
 *   close(i) = level·(1 ± noise),  open(i) = close(i−1),  wicks bracket the body.
 * Ascending-unique times, positive prices, valid OHLC guaranteed.
 */
export function genBars(spec: BarSpec): Bar[] {
  const count = spec.count ?? FIXTURE_BAR_COUNT;
  const t0 = spec.t0 ?? FIXTURE_T0_MS;
  const step = spec.step ?? FIXTURE_STEP_MS;
  const rnd = mulberry32(spec.seed);
  const bars: Bar[] = [];
  let prevClose = spec.base;
  for (let i = 0; i < count; i++) {
    const level =
      spec.base + spec.drift * i + spec.cycleAmp * Math.sin((2 * Math.PI * i) / spec.cyclePeriod);
    const close = Math.max(1e-6, level * (1 + spec.noise * (rnd() * 2 - 1)));
    const open = i === 0 ? level : prevClose;
    const high = Math.max(open, close) * (1 + spec.wick * rnd());
    const low = Math.max(1e-6, Math.min(open, close) * (1 - spec.wick * rnd()));
    bars.push({
      time: t0 + i * step,
      open,
      high,
      low,
      close,
      volume: Math.round(spec.vol * (0.5 + rnd())),
    });
    prevClose = close;
  }
  return bars;
}

/** Per-symbol regimes — same specs (hence same prices) as pinerun's fixture. */
export const FIXTURE_SPECS: Record<string, BarSpec> = {
  UPTREND: {
    base: 100,
    drift: +0.08,
    cycleAmp: 6,
    cyclePeriod: 48,
    noise: 0.01,
    wick: 0.004,
    vol: 1000,
    seed: 1,
  },
  DOWNTREND: {
    base: 240,
    drift: -0.06,
    cycleAmp: 7,
    cyclePeriod: 60,
    noise: 0.012,
    wick: 0.005,
    vol: 1200,
    seed: 2,
  },
  CHOP: {
    base: 50,
    drift: 0,
    cycleAmp: 8,
    cyclePeriod: 40,
    noise: 0.015,
    wick: 0.006,
    vol: 800,
    seed: 3,
  },
  VOLATILE: {
    base: 300,
    drift: +0.02,
    cycleAmp: 45,
    cyclePeriod: 72,
    noise: 0.03,
    wick: 0.01,
    vol: 1500,
    seed: 4,
  },
  MEANREV: {
    base: 20,
    drift: 0,
    cycleAmp: 3,
    cyclePeriod: 24,
    noise: 0.02,
    wick: 0.006,
    vol: 600,
    seed: 5,
  },
};

/** Basket symbols, stable order (the basket order for PortfolioEngine tests). */
export const FIXTURE_SYMBOLS: string[] = Object.keys(FIXTURE_SPECS);

/** The frozen dataset: symbol → bars (ms times). Deterministic across runs. */
export const FIXTURE_BARS: Record<string, Bar[]> = Object.fromEntries(
  Object.entries(FIXTURE_SPECS).map(([sym, spec]) => [sym, genBars(spec)]),
);

/** An `ArrayFeed` over one symbol — for `new Engine(script, fixtureFeed('UPTREND'))`. */
export function fixtureFeed(symbol: string): ArrayFeed {
  const bars = FIXTURE_BARS[symbol];
  if (!bars) throw new Error(`fixtureFeed: unknown symbol "${symbol}"`);
  return new ArrayFeed(bars);
}

/** A PortfolioEngine sleeve spec ({ symbol, timeframe, bars }). */
export interface FixtureSleeve {
  symbol: string;
  timeframe: string;
  bars: Bar[];
}

/** Sleeves for `new PortfolioEngine(script).run(fixtureSleeves())` — full shared clock. */
export function fixtureSleeves(symbols: string[] = FIXTURE_SYMBOLS): FixtureSleeve[] {
  return symbols.map((symbol) => {
    const bars = FIXTURE_BARS[symbol];
    if (!bars) throw new Error(`fixtureSleeves: unknown symbol "${symbol}"`);
    return { symbol, timeframe: FIXTURE_TF, bars };
  });
}

/** Per-symbol clock mutilations for `raggedSleeves` (see below). */
const RAGGED: Record<string, (b: Bar[]) => Bar[]> = {
  UPTREND: (b) => b, // full clock
  DOWNTREND: (b) => b.slice(100), // lists 100 bars late
  CHOP: (b) => b.filter((_, i) => i % 7 !== 0), // periodic "holiday" gaps
  VOLATILE: (b) => b, // full clock
  MEANREV: (b) => b.slice(0, 500), // delists early
};

/**
 * Sleeves with DISJOINT per-symbol clocks (late listing, gaps, early delisting)
 * while every remaining bar still lands on the shared 1h grid — for the
 * PortfolioEngine union clock and the shared-mode disjoint-clock risk case
 * (spec S7). Each series stays ascending and unique.
 */
export function raggedSleeves(symbols: string[] = FIXTURE_SYMBOLS): FixtureSleeve[] {
  return symbols.map((symbol) => {
    const bars = FIXTURE_BARS[symbol];
    if (!bars) throw new Error(`raggedSleeves: unknown symbol "${symbol}"`);
    return { symbol, timeframe: FIXTURE_TF, bars: (RAGGED[symbol] ?? ((b) => b))(bars) };
  });
}
