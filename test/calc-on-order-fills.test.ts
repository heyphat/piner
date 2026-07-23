import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, PortfolioEngine, type Bar } from '../src/index.js';

// The strategy.test.ts feed: open == close == 100 + i, range ±2. With h−o == o−l
// the emulator path tie-breaks to open → low → high → close (h−o < o−l is false).
const bars: Bar[] = Array.from({ length: 10 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
});

/** Run both backends, assert plots + the full strategy report agree, return the JS engine. */
async function bothBackends(src: string, data: Bar[] = bars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '1' });
  await ip.run({ symbol: 'BTCUSD', timeframe: '1' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i],
        b = ipp.data[i];
      const same = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
      if (!same) throw new Error(`diverge plot ${id} bar ${i}: js=${a} ip=${b}`);
    }
  }
  expect(JSON.stringify(ip.strategy)).toBe(JSON.stringify(js.strategy));
  return js;
}

// The Pine docs' own demo (execution-model, "Executions on historical bars"): a
// strategy that flips direction on every execution. With calc_on_order_fills the
// emulator's four ticks each fill the market order from the previous execution,
// so the script runs four times per bar and `varip executionNum` reads 4×bar_index.
const FLIP = (flag: boolean) => `//@version=6
strategy("flip", calc_on_order_fills = ${flag})
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
else
    strategy.entry("Short", strategy.short)
varip int executionNum = -1
executionNum += 1
plot(executionNum)
plot(bar_index)
`;

describe('strategy — calc_on_order_fills (historical path-point model)', () => {
  it('docs demo: the script executes four times per bar (executionNum == 4 × bar_index)', async () => {
    const eng = await bothBackends(FLIP(true));
    const execNum = eng.outputs.plots.get(0)!.data;
    const barIdx = eng.outputs.plots.get(1)!.data;
    // bar 0 has no pending orders yet (single execution); every later bar fills
    // at all four ticks: fill@open → exec → new order → fill@extreme → … → the
    // close-tick fill is seen by the standard once-per-bar execution.
    for (let i = 0; i < bars.length; i++) {
      expect(execNum[i]).toBe(4 * barIdx[i]);
    }
  });

  it('flag off, the same script executes once per bar (regression guard)', async () => {
    const eng = await bothBackends(FLIP(false));
    const execNum = eng.outputs.plots.get(0)!.data;
    for (let i = 0; i < bars.length; i++) expect(execNum[i]).toBe(i);
  });

  it('intrabar exit: the bracket placed by the post-fill execution exits the SAME bar', async () => {
    const src = (flag: boolean) => `//@version=6
strategy("sb", calc_on_order_fills = ${flag})
if strategy.position_size == 0 and bar_index == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0
    strategy.exit("X", "L", profit = 10)
`;
    // Flag ON — bar 1 (o=101, path 101→99→103→101):
    //   open tick: entry fills @101 → re-execution places the bracket
    //   (limit = 101 + 10 ticks × 0.01 = 101.1);
    //   high tick's segment [99,103] crosses 101.1 → same-bar exit at the limit.
    const on = await bothBackends(src(true));
    expect(on.strategy.closedTrades.length).toBe(1);
    const t = on.strategy.closedTrades[0];
    expect(t.entryBar).toBe(1);
    expect(t.exitBar).toBe(1); // same-bar round trip — impossible without the flag
    expect(t.entryPrice).toBe(101);
    expect(t.exitPrice).toBeCloseTo(101.1, 9);
    expect(on.strategy.netProfit).toBeCloseTo(0.1, 9);

    // Flag OFF — the script only runs at the close, so the bracket appears on
    // bar 1's execution and fills on bar 2: gap through 101.1 → fills at the
    // (better) open 102.
    const off = await bothBackends(src(false));
    expect(off.strategy.closedTrades.length).toBe(1);
    const u = off.strategy.closedTrades[0];
    expect(u.entryBar).toBe(1);
    expect(u.exitBar).toBe(2);
    expect(u.exitPrice).toBe(102);
    expect(off.strategy.netProfit).toBeCloseTo(1, 9);

    // Audit 2026-07 §4: the same-bar trade's excursions see the E1 traversal
    // (long from 101 exposed to 99 → MAE 2) and its own exit price (MFE 0.1),
    // and the strategy drawdown reflects the intrabar dip. Marking model pinned
    // by the TV export's excursion columns (calc-parity-findings.md).
    const t2 = on.strategy.closedTrades[0];
    expect(t2.maxRunup).toBeCloseTo(0.1, 9);
    expect(t2.maxDrawdown).toBeCloseTo(2, 9);
    expect(on.strategy.maxDrawdown).toBeCloseTo(2, 9);
  });

  it('risk.max_intraday_filled_orders halts the cascade at the cap (audit §2)', async () => {
    const eng = await bothBackends(`//@version=6
strategy("rc", calc_on_order_fills = true)
strategy.risk.max_intraday_filled_orders(1)
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
else
    strategy.entry("Short", strategy.short)
`);
    // Bar 1: the carried entry fills at A (fill #1 = cap reached) → the trip
    // cancels pending orders, force-closes at the very next path point (W, the
    // open price), and halts the rest of the (single-day) feed. Without the
    // per-pass check the flip cascade ran 4 fills on the bar.
    expect(eng.strategy.closedTrades.length).toBe(1);
    const t = eng.strategy.closedTrades[0];
    expect(t.entryBar).toBe(1);
    expect(t.exitBar).toBe(1);
    expect(t.entryPrice).toBe(101);
    expect(t.exitPrice).toBe(101);
    expect(eng.ctx.strategy.position_size).toBe(0);
    expect(eng.strategy.netProfit).toBeCloseTo(0, 9);
  });

  it('stop-limit triggered mid-segment cannot fill at a pre-activation price (audit §5)', async () => {
    // Ascending E1→E2 segment 99→110: buy stop 105 arms the limit 103, but 103
    // was visited BEFORE activation and the segment never retraces — the order
    // must stay armed and fill on a later bar's crossing at its own level.
    const feed: Bar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 60000, open: 100, high: 110, low: 99, close: 105, volume: 1 }, // path A,W,E1=99,E2=110
      { time: 120000, open: 104, high: 104.5, low: 95, close: 96, volume: 1 }, // retraces through 103
    ];
    const eng = await bothBackends(
      `//@version=6
strategy("sl", calc_on_order_fills = true)
if bar_index == 0
    strategy.order("SL", strategy.long, stop = 105, limit = 103)
plot(strategy.position_size)
plot(strategy.position_avg_price)
`,
      feed,
    );
    const size = eng.outputs.plots.get(0)!.data;
    expect(size[1]).toBe(0); // no fill on the ascending bar (was 1 @103 pre-fix)
    expect(size[2]).toBe(1); // fills on the retrace bar
    expect(eng.outputs.plots.get(1)!.data[2]).toBeCloseTo(103, 9); // at its own level
  });

  it('process_orders_on_close fill triggers the post-fill execution (audit §3)', async () => {
    const eng = await bothBackends(`//@version=6
strategy("pc", calc_on_order_fills = true, process_orders_on_close = true)
if bar_index == 0 and strategy.position_size == 0
    strategy.entry("L", strategy.long)
if strategy.position_size > 0
    strategy.exit("X", "L", profit = 10)
varip int execs = -1
execs += 1
plot(execs)
`);
    // Bar 0: close execution places the entry; POC fills it AT THE CLOSE (100);
    // the post-fill execution (A6) arms the bracket the SAME bar, so bar 1's
    // arrival gaps through 100.1 and exits at the (better) open 101. Pre-fix
    // the bracket appeared a bar late and exited at 102.
    expect(eng.strategy.closedTrades.length).toBe(1);
    const t = eng.strategy.closedTrades[0];
    expect(t.entryBar).toBe(0);
    expect(t.entryPrice).toBe(100);
    expect(t.exitBar).toBe(1);
    expect(t.exitPrice).toBe(101);
    expect(eng.strategy.netProfit).toBeCloseTo(1, 9);
    // Execution counts: bar 0 ran the standard close execution PLUS the
    // post-POC-fill execution (varip survives the rollback in between).
    const execs = eng.outputs.plots.get(0)!.data;
    expect(execs[0]).toBe(1);
    expect(execs[1]).toBe(2); // the arrival-fill execution
    for (let i = 2; i < bars.length; i++) expect(execs[i]).toBe(i + 1);
  });

  it('var rolls back across intrabar executions; varip persists (docs :550 / :393)', async () => {
    const eng = await bothBackends(`//@version=6
strategy("v", calc_on_order_fills = true)
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
else
    strategy.entry("Short", strategy.short)
var int a = 0
varip int b = 0
a += 1
b += 1
plot(a)
plot(b)
`);
    const a = eng.outputs.plots.get(0)!.data;
    const b = eng.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) {
      expect(a[i]).toBe(i + 1); // var: one committed increment per bar
      expect(b[i]).toBe(4 * i + 1); // varip: every execution counts (4/bar after bar 0)
    }
  });

  it('barstate: every execution is confirmed-historical, isnew only on the first', async () => {
    // Full-bar views + confirmed state on every execution: pending-logs
    // assumption A2/A3 in dev-docs/calc-parity-findings.md. isnew stays
    // realtime-like (only the bar's first execution).
    const eng = await bothBackends(`//@version=6
strategy("bs", calc_on_order_fills = true)
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
else
    strategy.entry("Short", strategy.short)
varip int confirmed = 0
varip int news = 0
if barstate.isconfirmed
    confirmed += 1
if barstate.isnew
    news += 1
plot(confirmed)
plot(news)
`);
    const confirmed = eng.outputs.plots.get(0)!.data;
    const news = eng.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) {
      expect(confirmed[i]).toBe(4 * i + 1); // every execution (4/bar once cascading)
      expect(news[i]).toBe(i + 1); // exactly one first-execution per bar
    }
  });

  it('plots commit the FINAL execution: plotted close is the bar close, not a tick price', async () => {
    const eng = await bothBackends(`//@version=6
strategy("pc", calc_on_order_fills = true)
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
else
    strategy.entry("Short", strategy.short)
plot(close)
plot(high - low)
`);
    const c = eng.outputs.plots.get(0)!.data;
    const range = eng.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) {
      expect(c[i]).toBe(bars[i].close);
      expect(range[i]).toBe(4); // full-bar high − low, not a developing view
    }
  });

  it('entry cascade under pyramiding: four adds per bar (the fixture-39 shape, hand-sized)', async () => {
    const eng = await bothBackends(`//@version=6
strategy("cascade", calc_on_order_fills = true, pyramiding = 100)
if last_bar_index - bar_index <= 3
    strategy.entry("Buy", strategy.long)
`);
    // Window = bars 6..9. Bar 6's close execution places the first order; bars
    // 7-9 then fill at all four ticks (fill → exec → new order → next tick).
    expect(eng.ctx.strategy.position_size).toBe(12); // 3 bars × 4 fills
    expect(eng.strategy.closedTrades.length).toBe(0);
  });

  it('calc_on_every_tick parses but is a no-op on historical bars (TV-identical)', async () => {
    const src = (decl: string) => `//@version=6
strategy(${decl})
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 5
    strategy.close("L")
`;
    const c = compile(src('"t", calc_on_every_tick = true, calc_on_order_fills = true'));
    expect(c.metadata.strategy?.calcOnEveryTick).toBe(true);
    expect(c.metadata.strategy?.calcOnOrderFills).toBe(true);
    const plain = await bothBackends(src('"t"'));
    const every = await bothBackends(src('"t", calc_on_every_tick = true'));
    expect(JSON.stringify(every.strategy)).toBe(JSON.stringify(plain.strategy));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Follow-up audit 2026-07-21 regressions: account-level marks must be
// CHRONOLOGICAL (no end-of-bar full-range replay — §2), and coof mode must
// not leak into realtime processing (§3).
//
// Shared scenario: bar 1 walks 100 → 90 → 110 → 105 (tie-break: low first).
// A seed long from 100 rides the dip to 90 (true account DD = 10), exits at
// its 105 limit on the rising segment (equity peak 10005, run-up 15), and a
// LATE long/short entered at the 110 extreme exists only for the 110 → 105
// tail. Any metric that shows the late position the 90 low is time travel.
// ═══════════════════════════════════════════════════════════════════════════
describe('calc_on_order_fills — chronological account marks (follow-up §2/§3)', () => {
  const wideBars: Bar[] = [
    { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 60000, open: 100, high: 110, low: 90, close: 105, volume: 1 },
    { time: 120000, open: 105, high: 105, low: 105, close: 105, volume: 1 },
  ];
  const scenario = (lateDir: string, header = 'initial_capital = 10000') => `//@version=6
strategy("fu", calc_on_order_fills = true, ${header})
if bar_index == 0
    strategy.entry("seed", strategy.long)
if strategy.position_size > 0 and strategy.position_avg_price == 100
    strategy.exit("x", "seed", limit = 105)
if strategy.position_size == 0 and bar_index == 1
    strategy.entry("late", ${lateDir})
plot(strategy.position_size)
`;

  it('late entry left open: extremes are lifetime-aware and risk.max_drawdown must not trip', async () => {
    const eng = await bothBackends(
      scenario('strategy.long').replace(
        'strategy.entry("seed", strategy.long)',
        'strategy.risk.max_drawdown(15, strategy.cash)\n    strategy.entry("seed", strategy.long)',
      ),
      wideBars,
    );
    // Chronology: DD 10 (seed long at the 90 dip), run-up 15 (peak 10005 at the
    // 105 exit − valley 9990). The buggy replay reported DD 20 (late long @110
    // marked at the pre-entry 90) and tripped the 15-cash rule.
    expect(eng.strategy.maxDrawdown).toBeCloseTo(10, 9);
    expect(eng.strategy.maxRunup).toBeCloseTo(15, 9);
    expect(eng.strategy.closedTrades.length).toBe(1); // seed only — no forced close
    const sizes = eng.outputs.plots.get(0)!.data;
    expect(sizes[1]).toBe(1);
    expect(sizes[2]).toBe(1); // survives bar 2: the risk rule did NOT trip
  });

  it('intrabar reversal: run-up follows the chronological marks (late short)', async () => {
    const eng = await bothBackends(scenario('strategy.short'), wideBars);
    // Late short born at 110 gains 5 into the 105 close: peak 10010 − valley
    // 9990 = run-up 20 (the replay claimed 35 by marking the short at 90).
    expect(eng.strategy.maxDrawdown).toBeCloseTo(10, 9);
    expect(eng.strategy.maxRunup).toBeCloseTo(20, 9);
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(-1);
  });

  it('margin: a late entry cannot be liquidated at a pre-entry price', async () => {
    const eng = await bothBackends(
      scenario('strategy.long', 'initial_capital = 1000, margin_long = 10')
        .replace(
          /strategy\.entry\("seed", strategy\.long\)/,
          'strategy.entry("seed", strategy.long, qty = 50)',
        )
        .replace(
          'strategy.entry("late", strategy.long)',
          'strategy.entry("late", strategy.long, qty = 50)',
        ),
      wideBars,
    );
    // Late 50-lot long @110 vs its own traversal window [105, 110]: at the 105
    // worst price equity = 1000 + 250 − 250 = 1000 ≥ required 525 → no call.
    // The buggy replay liquidated at the pre-entry 90 (netProfit −750).
    expect(eng.strategy.marginCalls).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.netProfit).toBeCloseTo(250, 9);
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(50); // still open
  });

  it('shared account: other sleeves fold chronological pot marks, not the replay (both backends)', () => {
    // margin_long=10: sleeve AAA's exposure changes intrabar (exit + late
    // entry) under an active margin model drawing on the shared pot — its
    // exposure intervals are all safe against pot equity, so any margin call
    // would be interval bleed-through (re-audit margin regression 6).
    const src = `//@version=6
strategy("p", calc_on_order_fills = true, initial_capital = 10000, margin_long = 10, margin_short = 10)
if bar_index == 0 and syminfo.ticker == "AAA"
    strategy.entry("seed", strategy.long)
if syminfo.ticker == "AAA" and strategy.position_size > 0 and strategy.position_avg_price == 100
    strategy.exit("x", "seed", limit = 105)
if syminfo.ticker == "AAA" and strategy.position_size == 0 and bar_index == 1
    strategy.entry("late", strategy.long)
`;
    for (const backend of ['js', 'interp'] as const) {
      const res = new PortfolioEngine(compile(src), { mode: 'shared', backend }).run([
        { symbol: 'AAA', timeframe: '1', bars: wideBars },
        { symbol: 'BBB', timeframe: '1', bars: wideBars },
      ]);
      // The inert BBB sleeve observes AAA's pot marks via foldEquityMarks (spec
      // S7): chronological pot DD is 10; the replay broadcast 20.
      expect(res.sleeves[0].report.maxDrawdown).toBeCloseTo(10, 9);
      expect(res.sleeves[1].report.maxDrawdown).toBeCloseTo(10, 9);
      expect(res.sleeves[0].report.marginCalls).toBe(0);
      expect(res.sleeves[1].report.marginCalls).toBe(0);
    }
  });

  it('history → realtime: coof mode does not leak into tick processing (follow-up §3)', async () => {
    const hist: Bar[] = [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
    const src = (flag: boolean) => `//@version=6
strategy("rt", calc_on_order_fills = ${flag})
if bar_index == 0
    strategy.entry("L", strategy.long)
plot(strategy.opentrades.max_runup(0))
plot(strategy.opentrades.max_drawdown(0))
`;
    const run = async (flag: boolean, backend: 'js' | 'interp') => {
      const eng = new Engine(compile(src(flag)), new ArrayFeed(hist), { backend });
      await eng.run({ symbol: 'T', timeframe: '1' });
      // one closing realtime update spanning 90..110 — the entry fills at its open
      eng.tick({ time: 60000, open: 100, high: 110, low: 90, close: 100, volume: 1 }, true);
      return [eng.outputs.plots.get(0)!.data[1], eng.outputs.plots.get(1)!.data[1]];
    };
    for (const backend of ['js', 'interp'] as const) {
      const coof = await run(true, backend);
      const plain = await run(false, backend);
      // The leaked flag reported 0/0 (close-only marking of the realtime lot).
      expect(coof).toEqual([10, 10]);
      expect(coof).toEqual(plain); // ordinary realtime lifecycle, flag on or off
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Second re-audit (2026-07-22) regressions: margin follows CHRONOLOGICAL
// EXPOSURE INTERVALS — one ending-position window cannot represent adds,
// reductions, reversals, or positions closed before bar end — and equity-risk
// rules act per pass, not only at bar finalization.
// ═══════════════════════════════════════════════════════════════════════════
describe('calc_on_order_fills — exposure-interval margin & risk timing (re-audit 2026-07-22)', () => {
  const wideBars: Bar[] = [
    { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 60000, open: 100, high: 110, low: 90, close: 105, volume: 1 }, // A=W=100, E1=90, E2=110
    { time: 120000, open: 105, high: 105, low: 105, close: 105, volume: 1 },
  ];

  it('same-direction late add cannot be liquidated at a pre-add price (repro A)', async () => {
    // Seed 1@100 rides the 90 dip (990 vs required 9 — safe); a stop-entry adds
    // 50@110 AFTER the low; the 51-lot interval spans only [105, 110] (safe:
    // 755 vs 535.5 at the close). The single-window model liquidated all 51 at
    // 90 (marginCalls 1, netProfit −1010).
    const eng = await bothBackends(
      `//@version=6
strategy("a", calc_on_order_fills = true, initial_capital = 1000, margin_long = 10, pyramiding = 2)
if bar_index == 0
    strategy.entry("seed", strategy.long, qty = 1)
    strategy.order("add", strategy.long, qty = 50, stop = 110)
plot(strategy.position_size)
`,
      wideBars,
    );
    expect(eng.strategy.marginCalls).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(0);
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(51); // both lots survive
  });

  it('a deficiency is margin-called BEFORE a same-bar exit erases it (repro B)', async () => {
    // 20@100 at margin 50%: deficient at the 90 low (equity 800 < required
    // 900, deficit 100) — the E1 pass liquidates 4×trunc(100/0.5/90) = 8.888
    // at 90 (TV's step-8/9 model); the surviving 11.112 exits at its 110 limit
    // later in the bar. The end-of-bar-only model saw a flat account and
    // reported 0 calls, +200.
    const eng = await bothBackends(
      `//@version=6
strategy("b", calc_on_order_fills = true, initial_capital = 1000, margin_long = 50)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 20)
if strategy.position_size > 0
    strategy.exit("x", "L", limit = 110)
`,
      wideBars,
    );
    expect(eng.strategy.marginCalls).toBe(1);
    expect(eng.strategy.closedTrades.length).toBe(2);
    const [liq, rest] = eng.strategy.closedTrades;
    expect(liq.qty).toBeCloseTo(8.888, 9);
    expect(liq.exitPrice).toBe(90);
    expect(liq.exitBar).toBe(1);
    expect(rest.qty).toBeCloseTo(11.112, 9);
    expect(rest.exitPrice).toBe(110);
    expect(rest.exitBar).toBe(1);
    expect(eng.strategy.netProfit).toBeCloseTo(22.24, 6);
  });

  it("reversal under margin: neither side inherits the other side's prices", async () => {
    // Long 1@100 reverses to short 50@110 mid-bar. The short's interval is
    // [105, 110] — the 90 low belongs to the long's interval (which was safe)
    // and must never margin-mark the short.
    const eng = await bothBackends(
      `//@version=6
strategy("r", calc_on_order_fills = true, initial_capital = 1000, margin_long = 10, margin_short = 10)
if bar_index == 0
    strategy.entry("seed", strategy.long, qty = 1)
    strategy.entry("rev", strategy.short, qty = 50, limit = 110)
plot(strategy.position_size)
`,
      wideBars,
    );
    expect(eng.strategy.marginCalls).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(1); // the reversed seed, +10
    expect(eng.strategy.netProfit).toBeCloseTo(10, 9);
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(-50);
  });

  it('equity-risk breach halts within the bar: force-close at the NEXT point, later entries blocked', async () => {
    // max_drawdown(5, cash) breaches at the E1 mark (DD 10 ≥ 5): the halt
    // queues the emergency close at E1 (fills at E2 = 110, same bar) and the
    // post-fill execution's entry is rejected by the halt. The deferred model
    // tripped only at coofEnd and closed at the NEXT bar's open (105).
    const eng = await bothBackends(
      `//@version=6
strategy("h", calc_on_order_fills = true, initial_capital = 10000)
strategy.risk.max_drawdown(5, strategy.cash)
if bar_index == 0
    strategy.entry("seed", strategy.long)
if strategy.position_size == 0 and bar_index == 1
    strategy.entry("late", strategy.long)
plot(strategy.position_size)
`,
      wideBars,
    );
    expect(eng.strategy.closedTrades.length).toBe(1);
    const t = eng.strategy.closedTrades[0];
    expect(t.exitPrice).toBe(110); // the very next path point after the breach
    expect(t.exitBar).toBe(1); // same bar — not the deferred next-bar 105
    expect(eng.strategy.maxDrawdown).toBeCloseTo(10, 9);
    const sizes = eng.outputs.plots.get(0)!.data;
    expect(sizes[1]).toBe(0); // flat after the forced close
    expect(sizes[2]).toBe(0); // the late entry stayed blocked by the halt
  });

  it('PINNED: the filled-order cap is per PASS — simultaneous fills at one point both land', async () => {
    // Two entries eligible at the same arrival point with a cap of 1: both
    // fill, then the pass-end check trips and force-closes at the next point.
    // This is the flag-off engine's after-the-pass granularity, documented as
    // findings A8 (TV's exact halt timing unverified).
    const eng = await bothBackends(`//@version=6
strategy("c", calc_on_order_fills = true, pyramiding = 2)
strategy.risk.max_intraday_filled_orders(1)
if bar_index == 0
    strategy.entry("L1", strategy.long, qty = 1)
    strategy.entry("L2", strategy.long, qty = 1)
plot(strategy.position_size)
`);
    expect(eng.strategy.closedTrades.length).toBe(2); // both admitted at A…
    for (const t of eng.strategy.closedTrades) {
      expect(t.entryPrice).toBe(101); // …at bar 1's arrival
      expect(t.exitPrice).toBe(101); // …and force-closed at the walk point
      expect(t.exitBar).toBe(1);
    }
    expect(eng.strategy.netProfit).toBeCloseTo(0, 9);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(0); // halted for the (single-day) feed
  });
});
