/**
 * Gate V3 of the portfolio plan: PortfolioEngine in ISOLATED mode must reproduce
 * the post-hoc per-sleeve arithmetic exactly —
 *   equal funding    ≡ forward-fill-and-sum of solo runs      (Model A)
 *   weighted funding ≡ solo runs re-funded at wᵢ·P, summed    (Model B)
 * bit-for-bit: the same trades, the same curve doubles, the same report sums.
 * This proves the union clock, the stepper, and the funding override introduce
 * zero drift before shared mode adds new semantics (gate V4).
 */
import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, PortfolioEngine, type Bar, type StrategyReport } from '../src/index.js';

/** Deterministic per-symbol walk: distinct phase/amplitude per seed. */
const mkBars = (n: number, seed: number, t0 = 0, dtMin = 1): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const px = 100 + 10 * seed + 8 * Math.sin((i + seed) / 3) + i * 0.3;
    return {
      time: (t0 + i * dtMin) * 60000,
      open: px,
      high: px + 2,
      low: px - 2,
      close: px + Math.sin(i + seed),
      volume: 1,
    };
  });

const SRC =
  '//@version=6\nstrategy("s", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=20, commission_type=strategy.commission.percent, commission_value=0.05)\n' +
  'fast = ta.sma(close, 3)\nslow = ta.sma(close, 6)\n' +
  'if ta.crossover(fast, slow)\n    strategy.entry("L", strategy.long)\n' +
  'if ta.crossunder(fast, slow)\n    strategy.close("L")\n';

interface Sleeve {
  symbol: string;
  bars: Bar[];
}

/** The post-hoc oracle: run each sleeve solo (optionally re-funded), then
 *  forward-fill each equity curve onto the union clock (pre-activation = its
 *  funding) and sum in basket order — plan §6 verbatim. */
async function oracle(script: ReturnType<typeof compile>, sleeves: Sleeve[], fundings: number[]) {
  const solos: StrategyReport[] = [];
  for (let i = 0; i < sleeves.length; i++) {
    const eng = new Engine(script, new ArrayFeed(sleeves[i].bars), {
      strategy: { initialCapital: fundings[i] },
    });
    await eng.run({ symbol: sleeves[i].symbol, timeframe: '1' });
    solos.push(eng.strategy);
  }
  const times = Array.from(new Set(sleeves.flatMap((s) => s.bars.map((b) => b.time)))).sort(
    (a, b) => a - b,
  );
  const equity = times.map((t, _k) => {
    let sum = 0;
    for (let i = 0; i < sleeves.length; i++) {
      const barTimes = sleeves[i].bars.map((b) => b.time);
      // latest sleeve bar at-or-before t; before the first bar → funding (cash)
      let j = -1;
      while (j + 1 < barTimes.length && barTimes[j + 1] <= t) j++;
      sum += j < 0 ? fundings[i] : solos[i].equityCurve[j];
    }
    return sum;
  });
  return { solos, times, equity };
}

const script = compile(SRC);

describe('V3 — PortfolioEngine isolated ≡ post-hoc oracle', () => {
  it('equal funding, aligned clocks (Model A)', async () => {
    const sleeves = [
      { symbol: 'AAA', bars: mkBars(40, 1) },
      { symbol: 'BBB', bars: mkBars(40, 5) },
      { symbol: 'CCC', bars: mkBars(40, 9) },
    ];
    const pe = new PortfolioEngine(script, { mode: 'isolated' });
    const res = pe.run(sleeves.map((s) => ({ ...s, timeframe: '1' })));
    const ref = await oracle(script, sleeves, [10000, 10000, 10000]);

    expect(res.report.initialCapital).toBe(30000);
    expect(res.times).toEqual(ref.times);
    expect(res.report.equityCurve).toEqual(ref.equity); // bit-for-bit
    for (let i = 0; i < sleeves.length; i++) expect(res.sleeves[i].report).toEqual(ref.solos[i]);
    expect(res.report.netProfit).toBe(ref.solos.reduce((a, r) => a + r.netProfit, 0));
    expect(res.report.closedTrades.length).toBe(
      ref.solos.reduce((a, r) => a + r.closedTrades.length, 0),
    );
  });

  it('weighted funding (Model B) with ragged, gappy clocks', async () => {
    // BBB starts 15 bars late; CCC ends 12 bars early; AAA has a mid-series gap.
    const aaa = mkBars(50, 2).filter((_, i) => i < 20 || i > 26);
    const sleeves = [
      { symbol: 'AAA', bars: aaa },
      { symbol: 'BBB', bars: mkBars(35, 6, 15) },
      { symbol: 'CCC', bars: mkBars(38, 11) },
    ];
    const P = 50000;
    const weights = [0.5, 0.3, 0.2];
    const pe = new PortfolioEngine(script, { mode: 'isolated', capital: P, weights });
    const res = pe.run(sleeves.map((s) => ({ ...s, timeframe: '1' })));
    const ref = await oracle(script, sleeves, weights.map((w) => w * P));

    expect(res.report.initialCapital).toBe(P);
    expect(res.times).toEqual(ref.times);
    expect(res.report.equityCurve).toEqual(ref.equity); // bit-for-bit, ragged and all
    for (let i = 0; i < sleeves.length; i++) expect(res.sleeves[i].report).toEqual(ref.solos[i]);
    // curve seeds at the full pot: every sleeve holds cash before activation
    expect(res.report.equityCurve[0]).toBeCloseTo(P, 9);
  });

  it('merged ledger is exit-time sorted, symbol-tagged, cumProfit re-accumulated', async () => {
    const sleeves = [
      { symbol: 'AAA', bars: mkBars(40, 1) },
      { symbol: 'BBB', bars: mkBars(40, 5) },
    ];
    const res = new PortfolioEngine(script, {}).run(sleeves.map((s) => ({ ...s, timeframe: '1' })));
    const t = res.report.closedTrades;
    expect(t.length).toBeGreaterThan(0);
    let cum = 0;
    for (let i = 0; i < t.length; i++) {
      if (i > 0) expect(t[i].exitTime).toBeGreaterThanOrEqual(t[i - 1].exitTime);
      expect(['AAA', 'BBB']).toContain(t[i].symbol!);
      cum += t[i].profit;
      expect(t[i].cumProfit).toBeCloseTo(cum, 9);
    }
    // per-sleeve reports keep their own untagged ledgers
    expect(res.sleeves[0].report.closedTrades.every((x) => x.symbol === undefined)).toBe(true);
  });

  it('exposure counts master bars where ANY sleeve holds a position', async () => {
    const sleeves = [
      { symbol: 'AAA', bars: mkBars(40, 1) },
      { symbol: 'BBB', bars: mkBars(40, 5) },
    ];
    const res = new PortfolioEngine(script, {}).run(sleeves.map((s) => ({ ...s, timeframe: '1' })));
    expect(res.report.barsProcessed).toBe(res.times.length);
    expect(res.report.barsInMarket).toBeGreaterThan(0);
    expect(res.report.barsInMarket).toBeLessThanOrEqual(res.report.barsProcessed);
  });

  it('portfolio metrics come from computeStrategyMetrics on the master clock', async () => {
    const sleeves = [
      { symbol: 'AAA', bars: mkBars(60, 1) },
      { symbol: 'BBB', bars: mkBars(60, 5) },
    ];
    const pe = new PortfolioEngine(script, {});
    pe.run(sleeves.map((s) => ({ ...s, timeframe: '1' })));
    const m = pe.metrics({ periodsPerYear: 525600 });
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(Number.isFinite(m.maxDrawdownCloseToClose)).toBe(true);
  });

  it('rejects indicators, empty baskets, and bad weights', () => {
    const ind = compile('//@version=6\nindicator("i")\nplot(close)\n');
    expect(() => new PortfolioEngine(ind)).toThrow(/strategy/);
    expect(() => new PortfolioEngine(script).run([])).toThrow(/empty/);
    expect(() =>
      new PortfolioEngine(script, { weights: [1] }).run([
        { symbol: 'A', timeframe: '1', bars: mkBars(5, 1) },
        { symbol: 'B', timeframe: '1', bars: mkBars(5, 2) },
      ]),
    ).toThrow(/weights/);
  });

  it('interp backend agrees with js backend at the portfolio level', async () => {
    const sleeves = [
      { symbol: 'AAA', bars: mkBars(30, 1) },
      { symbol: 'BBB', bars: mkBars(30, 5) },
    ];
    const js = new PortfolioEngine(script, { backend: 'js' }).run(
      sleeves.map((s) => ({ ...s, timeframe: '1' })),
    );
    const ip = new PortfolioEngine(script, { backend: 'interp' }).run(
      sleeves.map((s) => ({ ...s, timeframe: '1' })),
    );
    expect(ip.report.equityCurve).toEqual(js.report.equityCurve);
    expect(ip.report.netProfit).toBe(js.report.netProfit);
  });
});
