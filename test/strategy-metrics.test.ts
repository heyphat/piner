import { describe, it, expect } from 'bun:test';
import {
  compile,
  Engine,
  ArrayFeed,
  computeStrategyMetrics,
  type StrategyReport,
  type Bar,
} from '../src/index.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** A minimal broker-verbatim report with overridable fields. */
const mkReport = (over: Partial<StrategyReport>): StrategyReport => ({
  initialCapital: 100,
  netProfit: 0,
  grossProfit: 0,
  grossLoss: 0,
  wins: 0,
  losses: 0,
  evens: 0,
  maxDrawdown: 0,
  maxDrawdownPercent: 0,
  maxRunup: 0,
  maxRunupPercent: 0,
  totalCommission: 0,
  closedTrades: [],
  equityCurve: [],
  barsProcessed: 0,
  barsInMarket: 0,
  ...over,
});

const trade = (profit: number, barsHeld = 1) => ({
  entryId: 'L',
  dir: 1,
  qty: 1,
  entryPrice: 100,
  exitPrice: 100 + profit,
  entryBar: 0,
  exitBar: barsHeld,
  entryTime: 0,
  exitTime: barsHeld * 60000,
  profit,
  cumProfit: 0,
  commission: 0,
  maxRunup: Math.max(profit, 0),
  maxDrawdown: Math.max(-profit, 0),
});

describe('computeStrategyMetrics — pure reductions', () => {
  it('Sharpe / Sortino / volatility from per-bar returns (hand-computed)', () => {
    // equity 100 → 110 → 99 → 108.9: returns +10%, −10%, +10%.
    // mean = 1/30; population variance = 0.008888…; std = 0.0942809.
    const m = computeStrategyMetrics(
      mkReport({ equityCurve: [100, 110, 99, 108.9] }),
      { periodsPerYear: 1 }, // annualization factor 1 → raw per-period ratios
    );
    expect(m.periodsPerYear).toBe(1);
    expect(m.sharpe).toBeCloseTo(0.1 / 3 / 0.09428090415820634, 9);
    // downside deviation over the one negative return = 0.1
    expect(m.sortino).toBeCloseTo(0.1 / 3 / 0.1, 9);
    expect(m.volatilityPercent).toBeCloseTo(9.428090415820634, 9);
  });

  it('riskFreeRate subtracts from the mean return', () => {
    const curve = [100, 110, 99, 108.9];
    const rf = computeStrategyMetrics(mkReport({ equityCurve: curve }), {
      periodsPerYear: 1,
      riskFreeRate: 0.1 / 3, // exactly the mean → zero excess return
    });
    expect(rf.sharpe).toBeCloseTo(0, 12);
    expect(rf.sortino).toBeCloseTo(0, 12);
  });

  it('CAGR uses the real bar-time span; Calmar divides by max drawdown %', () => {
    // 100 → 108.9 over exactly 2 years → CAGR = sqrt(1.089) − 1.
    const barTimes = [0, MS_PER_YEAR, 1.5 * MS_PER_YEAR, 2 * MS_PER_YEAR];
    const m = computeStrategyMetrics(
      mkReport({ equityCurve: [100, 110, 99, 108.9], maxDrawdownPercent: 10 }),
      { barTimes, periodsPerYear: 1 },
    );
    const cagr = (Math.sqrt(1.089) - 1) * 100;
    expect(m.cagrPercent).toBeCloseTo(cagr, 9);
    expect(m.calmar).toBeCloseTo(cagr / 10, 9);
  });

  it('empirical annualization: bars-per-year from real timestamps', () => {
    // 3 return periods over 2 years → 1.5 periods/year.
    const barTimes = [0, MS_PER_YEAR, 1.5 * MS_PER_YEAR, 2 * MS_PER_YEAR];
    const m = computeStrategyMetrics(mkReport({ equityCurve: [100, 110, 99, 108.9] }), {
      barTimes,
    });
    expect(m.periodsPerYear).toBeCloseTo(1.5, 9);
  });

  it('timeframe fallback treats the market as 24/7', () => {
    const m = computeStrategyMetrics(mkReport({ equityCurve: [100, 101] }), {
      timeframeSeconds: 86400,
    });
    expect(m.periodsPerYear).toBeCloseTo(365.25, 9);
  });

  it('exposure, expectancy, and win/loss streaks (even trades break both)', () => {
    const profits = [5, 3, -2, -1, -1, 0, 4];
    const m = computeStrategyMetrics(
      mkReport({
        closedTrades: profits.map(trade),
        netProfit: 8,
        barsProcessed: 4,
        barsInMarket: 3,
      }),
      { periodsPerYear: 1 },
    );
    expect(m.exposurePercent).toBeCloseTo(75, 9);
    expect(m.expectancy).toBeCloseTo(8 / 7, 9);
    expect(m.maxConsecutiveWins).toBe(2);
    expect(m.maxConsecutiveLosses).toBe(3);
  });

  it('largest win/loss and average bars held per trade', () => {
    const m = computeStrategyMetrics(
      mkReport({
        closedTrades: [trade(5, 2), trade(-8, 4), trade(3, 6)],
        netProfit: 0,
      }),
      { periodsPerYear: 1 },
    );
    expect(m.largestWin).toBe(5);
    expect(m.largestLoss).toBe(-8);
    expect(m.avgBarsInTrade).toBeCloseTo(4, 9); // (2+4+6)/3
  });

  it('buy & hold falls back to the second bar open when there are no closed trades', () => {
    const bars = [
      { open: 100, close: 100 },
      { open: 101, close: 102 },
      { open: 102, close: 110 },
    ];
    const m = computeStrategyMetrics(mkReport({ netProfit: 4, initialCapital: 100 }), {
      periodsPerYear: 1,
      bars,
    });
    const ret = 110 / 101 - 1;
    expect(m.buyHoldReturnPercent).toBeCloseTo(ret * 100, 9);
    expect(m.outperformance).toBeCloseTo(4 - 100 * ret, 9);
  });

  it('winner/loser splits: avg bars, avg win/loss ratio, largest-vs-gross percents', () => {
    // winners: +6 (2 bars), +2 (4 bars); losers: −4 (1 bar), −1 (3 bars); even: 0.
    const m = computeStrategyMetrics(
      mkReport({
        closedTrades: [trade(6, 2), trade(-4, 1), trade(2, 4), trade(0, 9), trade(-1, 3)],
        netProfit: 3,
        grossProfit: 8,
        grossLoss: 5, // stored positive, like the broker
      }),
      { periodsPerYear: 1 },
    );
    expect(m.avgBarsInWinners).toBeCloseTo(3, 9); // (2+4)/2
    expect(m.avgBarsInLosers).toBeCloseTo(2, 9); // (1+3)/2
    expect(m.avgWinLossRatio).toBeCloseTo(4 / 2.5, 9); // (8/2) / (5/2)
    expect(m.largestWinPercentOfGrossProfit).toBeCloseTo(75, 9); // 6/8
    expect(m.largestLossPercentOfGrossLoss).toBeCloseTo(80, 9); // 4/5
    expect(m.netProfitPercentOfLargestLoss).toBeCloseTo(75, 9); // 3/4
  });

  it('return on initial capital and intrabar extremes rebased to initial capital', () => {
    const m = computeStrategyMetrics(
      mkReport({ netProfit: 25, initialCapital: 200, maxRunup: 30, maxDrawdown: 12 }),
      { periodsPerYear: 1 },
    );
    expect(m.returnOnInitialCapitalPercent).toBeCloseTo(12.5, 9);
    expect(m.maxRunupPercentOfInitialCapital).toBeCloseTo(15, 9);
    expect(m.maxDrawdownPercentOfInitialCapital).toBeCloseTo(6, 9);
  });

  it('buy & hold bases on the first trade entry fill when trades exist', () => {
    const bars = [
      { open: 100, close: 100 },
      { open: 101, close: 102 },
      { open: 105, close: 106 },
      { open: 107, close: 110 },
    ];
    const t = { ...trade(5), entryPrice: 105, entryBar: 2, exitBar: 3 };
    const m = computeStrategyMetrics(
      mkReport({ closedTrades: [t], netProfit: 5, initialCapital: 100 }),
      { periodsPerYear: 1, bars },
    );
    const ret = 110 / 105 - 1;
    expect(m.buyHoldReturnPercent).toBeCloseTo(ret * 100, 9);
    expect(m.buyHoldPnL).toBeCloseTo(100 * ret, 9);
    expect(m.outperformance).toBeCloseTo(5 - 100 * ret, 9);
  });

  it('close-to-close phases: max/avg run-up & drawdown, calendar-day durations', () => {
    // equity zigzag: 100 →110 (peak) →105 →108 →112 (recovery+new peak) →104 →106.
    // run-ups: 100→110 (10, 1d) and 105→112 (7, 2d); completed drawdown: 110→105
    // recovered at 112 (5, 3d). Trailing 112→104 drawdown never recovers →
    // excluded from averages but still the c2c max drawdown (8).
    const day = 24 * 60 * 60 * 1000;
    const m = computeStrategyMetrics(
      mkReport({ equityCurve: [100, 110, 105, 108, 112, 104, 106] }),
      { periodsPerYear: 1, barTimes: [0, 1, 2, 3, 4, 5, 6].map((d) => d * day) },
    );
    expect(m.maxRunupCloseToClose).toBeCloseTo(12, 9); // 112 − 100
    expect(m.maxDrawdownCloseToClose).toBeCloseTo(8, 9); // 112 − 104
    expect(m.avgRunupCloseToClose).toBeCloseTo(8.5, 9); // (10 + 7) / 2
    expect(m.avgDrawdownCloseToClose).toBeCloseTo(5, 9);
    expect(m.avgRunupDurationDays).toBeCloseTo(1.5, 9); // (1 + 2) / 2
    expect(m.avgDrawdownDurationDays).toBeCloseTo(3, 9); // peak d1 → recovery d4
  });

  it('close-to-close: monotonic rise is one run-up and no completed drawdown', () => {
    const m = computeStrategyMetrics(mkReport({ equityCurve: [100, 104, 109, 120] }), {
      periodsPerYear: 1,
    });
    expect(m.maxRunupCloseToClose).toBe(20);
    expect(m.avgRunupCloseToClose).toBe(20);
    expect(m.maxDrawdownCloseToClose).toBe(0);
    expect(m.avgDrawdownCloseToClose).toBe(0);
    expect(m.avgRunupDurationDays).toBe(0); // no barTimes → durations unavailable
  });

  it('degenerate inputs: empty/flat runs produce zeros, never NaN', () => {
    const empty = computeStrategyMetrics(mkReport({}));
    expect(empty.sharpe).toBe(0);
    expect(empty.sortino).toBe(0);
    expect(empty.cagrPercent).toBe(0);
    expect(empty.calmar).toBe(0);
    expect(empty.exposurePercent).toBe(0);
    expect(empty.periodsPerYear).toBe(252);

    const flat = computeStrategyMetrics(mkReport({ equityCurve: [100, 100, 100] }));
    expect(flat.sharpe).toBe(0);
    expect(flat.volatilityPercent).toBe(0);

    // all-positive returns: no downside → Sortino is +Infinity, per convention
    const up = computeStrategyMetrics(mkReport({ equityCurve: [100, 101, 102] }), {
      periodsPerYear: 1,
    });
    expect(up.sortino).toBe(Infinity);
  });
});

describe('Engine.strategyMetrics — end-to-end over the broker report', () => {
  const bars: Bar[] = Array.from({ length: 10 }, (_, i) => {
    const px = 100 + i;
    return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
  });
  const src =
    '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(strategy.position_size)\n';

  it('exposure counts bars with an open position; both backends agree', async () => {
    const c = compile(src);
    const run = async (backend: 'js' | 'interp') => {
      const e = new Engine(c, new ArrayFeed(bars), { backend });
      await e.run({ symbol: 'T', timeframe: '1' });
      return e;
    };
    const js = await run('js');
    const ip = await run('interp');

    // Long fills bar1 open, close fills bar6 open → in market on bars 1..5.
    expect(js.strategy.barsProcessed).toBe(10);
    expect(js.strategy.barsInMarket).toBe(5);

    const jm = js.strategyMetrics({ periodsPerYear: 252 });
    const im = ip.strategyMetrics({ periodsPerYear: 252 });
    expect(jm).toEqual(im); // two-backend invariant extends to derived metrics
    expect(jm.exposurePercent).toBeCloseTo(50, 9);
    expect(jm.expectancy).toBeCloseTo(5, 9); // one trade: 106 − 101
    expect(jm.maxConsecutiveWins).toBe(1);
    expect(jm.maxConsecutiveLosses).toBe(0);
    expect(Number.isFinite(jm.sharpe)).toBe(true);
    expect(jm.sharpe).toBeGreaterThan(0); // rising market, long strategy
  });

  it('report stays backward compatible (all pre-existing fields intact)', async () => {
    const e = new Engine(compile(src), new ArrayFeed(bars), { backend: 'js' });
    await e.run({ symbol: 'T', timeframe: '1' });
    const r = e.strategy;
    expect(r.initialCapital).toBe(1_000_000);
    expect(r.netProfit).toBeCloseTo(5, 9);
    expect(r.grossProfit).toBeCloseTo(5, 9);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(0);
    expect(r.closedTrades.length).toBe(1);
    expect(r.equityCurve.length).toBe(10);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});
