import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// 10 bars; open == close == 100 + i, range ±2. Predictable next-bar-open fills.
const bars: Bar[] = Array.from({ length: 10 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
});

/** Run both backends, assert plot outputs agree, return the JS-backend engine. */
async function bothBackends(src: string, mintick?: number) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '1', mintick });
  await ip.run({ symbol: 'BTCUSD', timeframe: '1', mintick });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i], b = ipp.data[i];
      const same = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
      if (!same) throw new Error(`diverge plot ${id} bar ${i}: js=${a} ip=${b}`);
    }
  }
  // strategy reports must match too
  expect(ip.strategy.netProfit).toBeCloseTo(js.strategy.netProfit, 9);
  expect(ip.strategy.closedTrades.length).toBe(js.strategy.closedTrades.length);
  return js;
}

describe('strategy — broker simulator', () => {
  it('market entry fills at the next bar open; position_size reads back', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[0]).toBe(0); // entry queued on bar 0, not yet filled
    expect(sz[1]).toBe(1); // filled at bar 1 open
    expect(sz[9]).toBe(1); // still open
    expect(eng.strategy.closedTrades.length).toBe(0);
  });

  it('close realizes PnL = (exit-entry)*qty', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(strategy.position_size)\n',
    );
    // entry @ bar1 open=101, close queued bar5 → filled bar6 open=106 → profit 5
    expect(eng.strategy.netProfit).toBeCloseTo(5, 9);
    expect(eng.strategy.closedTrades.length).toBe(1);
    const t = eng.strategy.closedTrades[0];
    expect(t.entryPrice).toBe(101);
    expect(t.exitPrice).toBe(106);
    expect(t.profit).toBeCloseTo(5, 9);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(0); // flat after close
  });

  it('short entry yields negative position and PnL on a rising market', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("S", strategy.short)\nif bar_index == 4\n    strategy.close("S")\nplot(strategy.position_size)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[1]).toBe(-1);
    // short @101, cover @105 → profit -4 on a rising market
    expect(eng.strategy.netProfit).toBeCloseTo(-4, 9);
  });

  it('opposite entry reverses the position (close + open)', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.entry("S", strategy.short)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1);  // long after bar1 fill
    expect(sz[6]).toBe(-1); // reversed to short after bar6 fill
    // long @101 closed @106 → +5 realized; short opened @106
    expect(eng.strategy.netProfit).toBeCloseTo(5, 9);
    expect(eng.strategy.closedTrades.length).toBe(1);
  });

  it('pyramiding caps same-direction entries at N (was unbounded for N >= 2)', async () => {
    const src = (pyr: number) =>
      `//@version=6\nstrategy("s", pyramiding = ${pyr}, default_qty_value = 1)\nif bar_index <= 4\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n`;

    // pyramiding=2: entries fill bars 1..5, but only the first TWO add (size caps at 2).
    const two = await bothBackends(src(2));
    const szTwo = two.outputs.plots.get(0)!.data;
    expect(szTwo[1]).toBe(1); // first add
    expect(szTwo[2]).toBe(2); // second add
    expect(szTwo[9]).toBe(2); // 3rd/4th/5th entry signals are capped — NOT unbounded

    // pyramiding=1 (the default behavior): only the first entry takes; the rest are blocked.
    const one = await bothBackends(src(1));
    const szOne = one.outputs.plots.get(0)!.data;
    expect(szOne[1]).toBe(1);
    expect(szOne[9]).toBe(1);

    // pyramiding=3: exactly three adds.
    const three = await bothBackends(src(3));
    expect(three.outputs.plots.get(0)!.data[9]).toBe(3);
  });

  it('configurable mintick scales tick-denominated exits (was hard-coded 0.01)', async () => {
    // Long fills bar1 @101; lows are 98+i, so the lowest low from bar1 on is 99.
    // exit loss=50 ticks → stop = 101 - 50*mintick. mintick=0.01 → 100.5 (>= 99 → stopped
    // out); mintick=0.05 → 98.5 (< 99 → never breached → stays open). Same script, the only
    // difference is the tick size.
    const src = '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", loss = 50)\nplot(strategy.position_size)\n';

    const tight = await bothBackends(src, 0.01);
    expect(tight.outputs.plots.get(0)!.data[9]).toBe(0); // stopped out
    expect(tight.strategy.closedTrades.length).toBe(1);

    const wide = await bothBackends(src, 0.05);
    expect(wide.outputs.plots.get(0)!.data[9]).toBe(1); // stop too far → still long
    expect(wide.strategy.closedTrades.length).toBe(0);
  });

  it('process_orders_on_close fills market orders at the SAME bar close (not the next open)', async () => {
    const src = (poc: boolean) =>
      `//@version=6\nstrategy("s"${poc ? ', process_orders_on_close = true' : ''})\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(strategy.position_size)\n`;

    // default: market orders fill at the NEXT bar's open
    const def = await bothBackends(src(false));
    const dt = def.strategy.closedTrades[0];
    expect(dt.entryBar).toBe(1);
    expect(dt.entryPrice).toBe(101); // bar1 open
    expect(dt.exitBar).toBe(6);
    expect(dt.exitPrice).toBe(106); // bar6 open

    // process_orders_on_close: market orders fill at the SAME bar's close
    const poc = await bothBackends(src(true));
    const pt = poc.strategy.closedTrades[0];
    expect(pt.entryBar).toBe(0);
    expect(pt.entryPrice).toBe(100); // bar0 close
    expect(pt.exitBar).toBe(5);
    expect(pt.exitPrice).toBe(105); // bar5 close
  });

  it('stop-limit entry: the stop arms a resting limit, filled at the LIMIT price (not collapsed to a stop)', async () => {
    // bars px=100+i: bar i has high=102+i, low=98+i. Buy stop-limit: arm when high>=104.5
    // (first at bar3, high=105), then buy only at <=103 (limit). Old code discarded the
    // limit and filled at the stop (104.5); now it fills at the limit (103).
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long, stop = 104.5, limit = 103)\nif bar_index == 6\n    strategy.close("L")\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[2]).toBe(0); // stop not armed yet (bar2 high=104 < 104.5)
    expect(sz[3]).toBe(1); // bar3 arms the stop (high=105) and the limit (low=101<=103) fills same bar
    const t = eng.strategy.closedTrades[0];
    expect(t.entryPrice).toBe(103); // the LIMIT price, not the stop 104.5

    // and a stop-limit whose limit is never reached after arming does NOT fill
    const noFill = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long, stop = 104.5, limit = 90)\nplot(strategy.position_size)\n',
    );
    expect(noFill.outputs.plots.get(0)!.data[9]).toBe(0); // armed but limit 90 never hit
  });

  it('exit take-profit (limit) closes when price reaches the target', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", limit = 105, stop = 98)\nplot(strategy.position_size)\n',
    );
    // entry @101 (bar1). high = px+2, reaches 105 at bar3 (px=103) → TP fill @105 → +4
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(105);
    expect(eng.strategy.netProfit).toBeCloseTo(4, 9);
  });

  it('exit stop-loss closes when price breaches the stop', async () => {
    // falling market so the long stop triggers
    const falling: Bar[] = Array.from({ length: 10 }, (_, i) => {
      const px = 110 - i;
      return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
    });
    const c = compile(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", stop = 104)\nplot(strategy.position_size)\n',
    );
    const eng = new Engine(c, new ArrayFeed(falling), { backend: 'js' });
    await eng.run({ symbol: 'BTCUSD', timeframe: '1' });
    // entry @109 (bar1). low = px-2 ≤ 104 once px ≤ 106 → bar4 (px=106, low=104) stop @104 → -5
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(104);
    expect(eng.strategy.netProfit).toBeCloseTo(-5, 9);
  });

  it('initial_capital / default_qty_value flow through from the declaration', async () => {
    const c = compile(
      '//@version=6\nstrategy("s", initial_capital = 5000, default_qty_value = 3)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(strategy.position_size)\n',
    );
    const eng = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    await eng.run({ symbol: 'BTCUSD', timeframe: '1' });
    expect(eng.strategy.initialCapital).toBe(5000);
    expect(eng.outputs.plots.get(0)!.data[1]).toBe(3); // qty 3
    expect(eng.strategy.netProfit).toBeCloseTo(15, 9); // (106-101)*3
  });

  it('when-gating suppresses orders', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nstrategy.entry("L", strategy.long, when = false)\nplot(strategy.position_size)\n',
    );
    expect(eng.strategy.closedTrades.length).toBe(0);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(0);
  });

  it('a non-strategy script leaves the broker inactive (orders are no-ops)', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("i")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(0);
  });

  it('per-trade introspection: strategy.closedtrades.profit/entry_price(i)', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(strategy.closedtrades > 0 ? strategy.closedtrades.profit(0) : na)\nplot(strategy.closedtrades > 0 ? strategy.closedtrades.entry_price(0) : na)\n',
    );
    // entry @ bar1 open=101, close queued bar5 → filled bar6 open=106 → profit 5
    expect(eng.outputs.plots.get(0)!.data[9]).toBeCloseTo(5, 9);
    expect(eng.outputs.plots.get(1)!.data[9]).toBe(101);
  });

  it('trailing stop (trail_points/trail_offset) ratchets then closes on a reversal', async () => {
    // entry @100; rise to peak high 116; trail (offset 3.0) ratchets to 113; the
    // pullback's low pierces it → exit @113 (below the peak, above entry).
    const tb: Bar[] = [100, 100, 110, 115, 112, 105].map((px, i) => ({ time: i * 60000, open: px, high: px + 1, low: px - 1, close: px, volume: 1 }));
    const src = '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", trail_points = 200, trail_offset = 300)\nplot(strategy.position_size)\n';
    const c = compile(src);
    const js = new Engine(c, new ArrayFeed(tb), { backend: 'js' });
    const ip = new Engine(c, new ArrayFeed(tb), { backend: 'interp' });
    await js.run({ symbol: 'T', timeframe: '1' });
    await ip.run({ symbol: 'T', timeframe: '1' });
    expect(ip.strategy.closedTrades.length).toBe(js.strategy.closedTrades.length);
    expect(js.strategy.closedTrades.length).toBe(1);     // the trail closed the position
    expect(js.strategy.closedTrades[0].exitPrice).toBeCloseTo(113, 9); // ratcheted level
  });
});
