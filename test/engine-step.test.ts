/**
 * Phase 0 of the portfolio plan (pinestack portfolio-aggregation-plan §4):
 *
 *  G1 — Engine.prepare()/step(): the external-clock historical stepper. Gate V1:
 *       a prepare+step-driven run must equal a run()-driven run bit-for-bit —
 *       including barstate.islast / ishistory / last_bar_index, which the
 *       realtime tick() path cannot reproduce.
 *  G2 — EngineOptions.strategy: host override of strategy() header settings
 *       (the funding primitive for weighted/portfolio runs; also the
 *       commission/slippage sensitivity hook).
 */
import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

const mkBars = (n: number, start = 100): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const px = start + i;
    return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
  });

const bars = mkBars(12);

/** Run the same compiled script twice — via run() and via prepare()+step() — and
 *  assert every observable output is identical. */
async function assertStepParity(src: string, data: Bar[] = bars, backend: 'js' | 'interp' = 'js') {
  const c = compile(src);
  const viaRun = new Engine(c, new ArrayFeed(data), { backend });
  await viaRun.run({ symbol: 'BTCUSD', timeframe: '1' });

  const viaStep = new Engine(c, new ArrayFeed(data), { backend });
  viaStep.prepare({ symbol: 'BTCUSD', timeframe: '1' }, data);
  let steps = 0;
  while (viaStep.step()) steps++;
  expect(steps).toBe(data.length);
  expect(viaStep.step()).toBe(false); // exhausted stays exhausted

  // plots: bit-for-bit (toEqual treats NaN === NaN)
  expect(viaStep.outputs.plots.size).toBe(viaRun.outputs.plots.size);
  for (const [id, p] of viaRun.outputs.plots) {
    expect(viaStep.outputs.plots.get(id)!.data).toEqual(p.data);
  }
  // strategy report: whole object, trades and equity curve included
  expect(viaStep.strategy).toEqual(viaRun.strategy);
  // drawings: full CONTENT, not just count — a barstate-sensitive drawing (e.g.
  // a label gated on barstate.islast) is exactly where a stepper bug would show.
  expect(JSON.stringify(viaStep.drawings)).toBe(JSON.stringify(viaRun.drawings));
  return { viaRun, viaStep };
}

describe('G1 — prepare()/step() historical stepper (gate V1)', () => {
  it('barstate.ishistory / islast / last_bar_index match run() (the tick() divergence)', async () => {
    const src =
      '//@version=6\nindicator("b")\nplot(barstate.ishistory ? 1 : 0)\nplot(barstate.islast ? 1 : 0)\nplot(last_bar_index)\n';
    const { viaStep } = await assertStepParity(src);
    const islast = viaStep.outputs.plots.get(1)!.data;
    const lbi = viaStep.outputs.plots.get(2)!.data;
    // Historical semantics: only the final bar is "last"; last_bar_index known up front.
    expect(islast.slice(0, -1).every((v) => v === 0)).toBe(true);
    expect(islast[islast.length - 1]).toBe(1);
    expect(lbi.every((v) => v === bars.length - 1)).toBe(true);
  });

  it('indicator with stateful ta.* built-ins', async () => {
    await assertStepParity(
      '//@version=6\nindicator("t")\nplot(ta.sma(close, 3))\nplot(ta.rsi(close, 4))\nplot(ta.crossover(close, ta.sma(close, 5)) ? 1 : 0)\n',
    );
  });

  it('strategy with brackets, percent commission, percent-of-equity sizing', async () => {
    const src =
      '//@version=6\nstrategy("s", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.1)\n' +
      'if bar_index % 4 == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", profit=300, loss=300)\nplot(strategy.equity)\n';
    const { viaRun, viaStep } = await assertStepParity(src);
    expect(viaRun.strategy.closedTrades.length).toBeGreaterThan(0); // the fixture actually trades
    expect(viaStep.strategy.equityCurve).toEqual(viaRun.strategy.equityCurve);
  });

  it('strategy with margin + risk rules (0.7.0 paths), interp backend', async () => {
    const src =
      '//@version=6\nstrategy("m", initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=150, margin_long=25)\n' +
      'strategy.risk.max_intraday_loss(90, strategy.percent_of_equity)\n' +
      'if bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n';
    await assertStepParity(src, mkBars(12, 200), 'interp');
  });

  it('two engines stepped interleaved equal two engines run alone (contexts stay independent)', async () => {
    const src =
      '//@version=6\nstrategy("s", initial_capital=10000)\nif bar_index % 3 == 0\n    strategy.entry("L", strategy.long)\nif bar_index % 3 == 2\n    strategy.close("L")\nplot(strategy.equity)\n';
    const c = compile(src);
    const dataA = mkBars(12, 100);
    const dataB = mkBars(9, 500);

    const soloA = new Engine(c, new ArrayFeed(dataA), {});
    const soloB = new Engine(c, new ArrayFeed(dataB), {});
    await soloA.run({ symbol: 'AAA', timeframe: '1' });
    await soloB.run({ symbol: 'BBB', timeframe: '1' });

    const a = new Engine(c, new ArrayFeed(dataA), {});
    const b = new Engine(c, new ArrayFeed(dataB), {});
    a.prepare({ symbol: 'AAA', timeframe: '1' }, dataA);
    b.prepare({ symbol: 'BBB', timeframe: '1' }, dataB);
    // union-clock style: alternate until both exhaust
    let live = true;
    while (live) live = a.step() || b.step();

    expect(a.strategy).toEqual(soloA.strategy);
    expect(b.strategy).toEqual(soloB.strategy);
  });

  it('drawings match by content — including a barstate.islast-gated label', async () => {
    // Lines drawn on a bar-index cadence + one label drawn ONLY on the last bar:
    // if the stepper mis-handled islast/last_bar_index (the tick() divergence),
    // the label would appear on every bar and the content compare would fail.
    const src =
      '//@version=6\nindicator("d", overlay=true)\n' +
      'if bar_index % 4 == 0\n    line.new(bar_index - 1, close - 1, bar_index, close + 1)\n' +
      'if barstate.islast\n    label.new(bar_index, high, text="last")\n' +
      'plot(close)\n';
    const { viaRun } = await assertStepParity(src);
    expect(viaRun.drawings.length).toBeGreaterThan(0); // non-vacuous: it actually draws
    await assertStepParity(src, bars, 'interp');
  });

  it('empty dataset: step() is false immediately; realtime ticks still work after', async () => {
    const c = compile('//@version=6\nindicator("e")\nplot(close)\n');
    const eng = new Engine(c, new ArrayFeed([]), {});
    eng.prepare({ symbol: 'X', timeframe: '1' }, []);
    expect(eng.step()).toBe(false);
    eng.tick({ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }, true);
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(1);
  });
});

describe('G2 — EngineOptions.strategy header override (the funding primitive)', () => {
  const pctSrc =
    '//@version=6\nstrategy("p", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10)\n' +
    'if bar_index % 4 == 0\n    strategy.entry("L", strategy.long)\nif bar_index % 4 == 2\n    strategy.close("L")\n';

  async function runWith(src: string, strategy?: Record<string, unknown>) {
    const eng = new Engine(compile(src), new ArrayFeed(bars), { strategy });
    await eng.run({ symbol: 'BTCUSD', timeframe: '1' });
    return eng.strategy;
  }

  it('re-funding a percent_of_equity strategy scales PnL exactly linearly', async () => {
    const base = await runWith(pctSrc);
    const doubled = await runWith(pctSrc, { initialCapital: 20000 });
    expect(base.initialCapital).toBe(10000);
    expect(doubled.initialCapital).toBe(20000);
    expect(base.closedTrades.length).toBeGreaterThan(0);
    expect(doubled.closedTrades.length).toBe(base.closedTrades.length);
    expect(doubled.netProfit).toBeCloseTo(2 * base.netProfit, 9);
    // equity curve scales bar-by-bar: E'(t) − 2C == 2·(E(t) − C)
    for (let i = 0; i < base.equityCurve.length; i++) {
      const e = base.equityCurve[i];
      const d = doubled.equityCurve[i];
      if (Number.isNaN(e)) expect(Number.isNaN(d)).toBe(true);
      else expect(d - 20000).toBeCloseTo(2 * (e - 10000), 6);
    }
  });

  it('re-funding a fixed-qty strategy changes the account, not the trades', async () => {
    const src =
      '//@version=6\nstrategy("f", initial_capital=10000)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\n';
    const base = await runWith(src);
    const funded = await runWith(src, { initialCapital: 50000 });
    expect(funded.initialCapital).toBe(50000);
    expect(funded.netProfit).toBeCloseTo(base.netProfit, 9);
    expect(funded.closedTrades).toEqual(base.closedTrades);
  });

  it('commission override books fees without editing the source (sensitivity hook)', async () => {
    const src =
      '//@version=6\nstrategy("c", initial_capital=10000)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\n';
    const base = await runWith(src);
    const withFees = await runWith(src, { commissionType: 'percent', commissionValue: 1 });
    expect(base.totalCommission).toBe(0);
    expect(withFees.totalCommission).toBeGreaterThan(0);
    expect(withFees.netProfit).toBeLessThan(base.netProfit);
  });

  it('a compiled indicator ignores the override (broker stays inactive)', async () => {
    const eng = new Engine(
      compile('//@version=6\nindicator("i")\nplot(close)\n'),
      new ArrayFeed(bars),
      {
        strategy: { initialCapital: 12345 },
      },
    );
    await eng.run({ symbol: 'BTCUSD', timeframe: '1' });
    expect(eng.strategy.closedTrades.length).toBe(0);
    expect(eng.strategy.equityCurve.length).toBe(0);
  });

  it('override works identically through prepare()/step()', async () => {
    const c = compile(pctSrc);
    const viaRun = new Engine(c, new ArrayFeed(bars), { strategy: { initialCapital: 20000 } });
    await viaRun.run({ symbol: 'BTCUSD', timeframe: '1' });
    const viaStep = new Engine(c, new ArrayFeed(bars), { strategy: { initialCapital: 20000 } });
    viaStep.prepare({ symbol: 'BTCUSD', timeframe: '1' }, bars);
    while (viaStep.step()) {}
    expect(viaStep.strategy).toEqual(viaRun.strategy);
  });
});
