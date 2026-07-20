import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

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
