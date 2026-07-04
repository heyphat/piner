import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// Rising minute bars within one UTC day: open == close == 100 + i, range ±2.
const risingBars: Bar[] = Array.from({ length: 10 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
});

/** Bars at `msPerBar` spacing with open == close == px(i), range ±2 — spacing of
 *  6h puts 4 bars into each UTC trading day (the risk rules' day bucket). */
const mkBars = (px: (i: number) => number, n: number, msPerBar = 21_600_000): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * msPerBar,
    open: px(i),
    high: px(i) + 2,
    low: px(i) - 2,
    close: px(i) + 0,
    volume: 1,
  }));

/** Run both backends over `bars`, assert plot outputs + strategy report agree,
 *  return the JS-backend engine. */
async function bothBackends(src: string, bars: Bar[] = risingBars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '60' });
  await ip.run({ symbol: 'BTCUSD', timeframe: '60' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i],
        b = ipp.data[i];
      const same = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
      if (!same) throw new Error(`diverge plot ${id} bar ${i}: js=${a} ip=${b}`);
    }
  }
  expect(ip.strategy.netProfit).toBeCloseTo(js.strategy.netProfit, 9);
  expect(ip.strategy.closedTrades.length).toBe(js.strategy.closedTrades.length);
  return js;
}

describe('strategy.risk — risk-management rules', () => {
  it('max_position_size caps entry quantity to the position limit', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", default_qty_value = 100)\nstrategy.risk.max_position_size(10)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[0]).toBe(0);
    expect(sz[1]).toBe(10); // 100 requested, capped to 10
    expect(sz[9]).toBe(10);
  });

  it('max_position_size reduces pyramided adds and drops entries with no room', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 3, default_qty_value = 6)\nstrategy.risk.max_position_size(10)\nif bar_index <= 2\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(6); // first add in full
    expect(sz[2]).toBe(10); // second add reduced 6 → 4
    expect(sz[9]).toBe(10); // third add dropped (no room)
  });

  it('allow_entry_in(long): a short entry while flat never opens a position', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.allow_entry_in(strategy.direction.long)\nif bar_index == 0\n    strategy.entry("S", strategy.short)\nplot(strategy.position_size)\n',
    );
    for (const v of eng.outputs.plots.get(0)!.data) expect(v).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(0);
  });

  it('allow_entry_in(long): a short entry against an open long closes it without reversing', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.allow_entry_in(strategy.direction.long)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 3\n    strategy.entry("S", strategy.short)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1); // long open
    expect(sz[4]).toBe(0); // short entry filled bar4 → closed the long…
    expect(Math.min(...sz)).toBe(0); // …and never went short
    expect(eng.strategy.netProfit).toBeCloseTo(3, 9); // 104 - 101
    expect(eng.strategy.closedTrades.length).toBe(1);
  });

  it('max_drawdown(cash) halts the strategy for good once the drawdown is reached', async () => {
    // Falling market, long 1 contract from bar1 @109; peak equity is 1e6+2 (bar1 high),
    // the bar2 low (eq 1e6-3) puts the drawdown at 5 → trip: position closed at bar3
    // open, every later entry (submitted on EVERY bar) is blocked.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.max_drawdown(value = 5, type = strategy.cash)\nstrategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      mkBars((i) => 110 - i, 10),
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1);
    expect(sz[2]).toBe(1); // rule trips at bar2's mark-to-market
    expect(sz[3]).toBe(0); // emergency market close fills at bar3 open
    for (let i = 3; i < 10; i++) expect(sz[i]).toBe(0); // permanently halted
    expect(eng.strategy.netProfit).toBeCloseTo(-2, 9); // 107 - 109
    expect(eng.strategy.closedTrades.length).toBe(1);
  });

  it('max_drawdown(percent_of_equity) trips on the percent form', async () => {
    // initial_capital=100 → same price path: dd 5 off a 102 peak = 4.90% ≥ 4.5%.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 100)\nstrategy.risk.max_drawdown(4.5, strategy.percent_of_equity)\nstrategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      mkBars((i) => 110 - i, 10),
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[2]).toBe(1);
    expect(sz[3]).toBe(0);
    for (let i = 3; i < 10; i++) expect(sz[i]).toBe(0);
  });

  it('max_intraday_filled_orders halts until the end of the day, then resumes', async () => {
    // 4 bars per UTC day. Entry/close alternate → 2 fills reach the cap on each
    // day's 3rd bar; the rest of the day is halted, the next day trades again.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.max_intraday_filled_orders(2)\nif bar_index % 2 == 0\n    strategy.entry("L", strategy.long)\nelse\n    strategy.close("L")\nplot(strategy.position_size)\n',
      mkBars((i) => 100 + i, 8),
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1); // fill 1 (entry)
    expect(sz[2]).toBe(0); // fill 2 (close) → cap reached, day halted
    expect(sz[3]).toBe(0); // bar2/bar3 entries blocked
    expect(sz[4]).toBe(0);
    expect(sz[5]).toBe(1); // day 2: trading resumed
    expect(sz[6]).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(2);
    expect(eng.strategy.netProfit).toBeCloseTo(2, 9); // (102-101) + (106-105)
  });

  it('max_intraday_loss(cash) closes and halts for the day, then resumes', async () => {
    // Long 1 from bar1 @109 in a $1/bar fall. Day-start equity 1e6; the bar3 low
    // (105) puts the intraday loss at 4 → trip; the emergency close fills at bar4
    // open (the next day's first bar), and the strategy re-enters on day 2.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.max_intraday_loss(4, strategy.cash)\nstrategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      mkBars((i) => 110 - i, 12),
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[3]).toBe(1); // trip happens at bar3's mark-to-market
    expect(sz[4]).toBe(0); // emergency close filled at bar4 open (106)
    expect(sz[5]).toBe(1); // day 2: re-entered
    expect(sz[7]).toBe(0); // day 2 trips again (loss from its own day-start)
    expect(sz[9]).toBe(1); // day 3: re-entered again
    expect(eng.strategy.closedTrades.length).toBe(2);
    // 106-109 = -3, then 103-105 = -2
    expect(eng.strategy.netProfit).toBeCloseTo(-5, 9);
  });

  it('max_cons_loss_days halts the whole strategy after N losing days', async () => {
    // Hold a long through a steady fall: day 0 and day 1 both close below their
    // opening equity → 2 consecutive loss days → permanent halt at the day-2
    // rollover (position closed at bar8 open @102); a later entry is blocked.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.risk.max_cons_loss_days(2)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 10\n    strategy.entry("L2", strategy.long)\nplot(strategy.position_size)\n',
      mkBars((i) => 110 - i, 16),
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1);
    expect(sz[7]).toBe(1); // still held through day 1
    for (let i = 8; i < 16; i++) expect(sz[i]).toBe(0); // closed + halted for good
    expect(eng.strategy.netProfit).toBeCloseTo(-7, 9); // 102 - 109
    expect(eng.strategy.closedTrades.length).toBe(1);
  });

  it('repeated calls to the same rule keep the most restrictive value', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", default_qty_value = 100)\nstrategy.risk.max_position_size(50)\nstrategy.risk.max_position_size(10)\nstrategy.risk.max_position_size(25)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(10);
  });

  it('a risk halt tripped on a speculative realtime tick rolls back cleanly', async () => {
    // Full batch run vs incremental run whose LAST bar first arrives as a
    // speculative crash tick (deep enough to trip max_drawdown) and is then
    // replaced by the real benign closing tick. The halt (and its emergency
    // close) must roll back with the broker snapshot — committed outputs and
    // the final position must match the full run exactly.
    const src =
      '//@version=6\nstrategy("s")\nstrategy.risk.max_drawdown(5, strategy.cash)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n';
    const c = compile(src);
    const full = new Engine(c, new ArrayFeed(risingBars), { backend: 'js' });
    await full.run({ symbol: 'T', timeframe: '1' });

    const incr = new Engine(c, new ArrayFeed(risingBars.slice(0, -1)), { backend: 'js' });
    await incr.run({ symbol: 'T', timeframe: '1' });
    const last = risingBars[9];
    incr.tick({ ...last, low: 20, close: 30 }, false); // speculative crash: trips the rule
    incr.tick(last, true); // the real closing tick — the halt must have rolled back

    expect(incr.outputs.plots.get(0)!.data).toEqual(full.outputs.plots.get(0)!.data);
    expect(incr.strategy.netProfit).toBeCloseTo(full.strategy.netProfit, 9);
    expect(incr.outputs.plots.get(0)!.data.at(-1)).toBe(1); // still long — no residual halt
  });

  it('risk rules are inert in an indicator-less strategy context (no broker)', async () => {
    // An indicator script: the call parses/compiles and is a runtime no-op.
    const eng = await bothBackends(
      '//@version=6\nindicator("i")\nstrategy.risk.max_position_size(10)\nplot(close)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(109);
  });
});
