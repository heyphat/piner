import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// Completely flat bars (o=h=l=c) — margin events are then driven ONLY by the
// explicitly engineered bars appended per case.
const flat = (px: number, i: number): Bar => ({
  time: i * 60000,
  open: px,
  high: px,
  low: px,
  close: px,
  volume: 1,
});
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({
  time: i * 60000,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});

/** Run both backends, assert plots + report agree, return the JS engine. */
async function bothBackends(src: string, bars: Bar[]) {
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
  expect(ip.strategy.marginCalls).toBe(js.strategy.marginCalls);
  expect(ip.strategy.closedTrades.length).toBe(js.strategy.closedTrades.length);
  return js;
}

describe('strategy margin — header parsing', () => {
  it('margin_long / margin_short land in compile metadata', () => {
    const c = compile(
      '//@version=6\nstrategy("s", margin_long = 25, margin_short = 30)\nplot(close)\n',
    );
    expect(c.metadata.strategy?.marginLong).toBe(25);
    expect(c.metadata.strategy?.marginShort).toBe(30);
  });

  it('omitted margins stay unset in metadata (broker defaults to the v6 100/100)', () => {
    const c = compile('//@version=6\nstrategy("s")\nplot(close)\n');
    expect(c.metadata.strategy?.marginLong).toBeUndefined();
    expect(c.metadata.strategy?.marginShort).toBeUndefined();
  });

  it('an explicit 0 is extracted (the v5-compat escape hatch)', () => {
    const c = compile(
      '//@version=6\nstrategy("s", margin_long = 0, margin_short = 0)\nplot(close)\n',
    );
    expect(c.metadata.strategy?.marginLong).toBe(0);
    expect(c.metadata.strategy?.marginShort).toBe(0);
  });
});

describe('strategy margin — order gating (blocked fills)', () => {
  const flat20 = Array.from({ length: 6 }, (_, i) => flat(20, i));

  it('rejects an entry whose position value exceeds equity at margin 100 (v6 default)', async () => {
    // 100 contracts @ 20 needs $2000; only $1000 available → never opens.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      flat20,
    );
    for (const v of eng.outputs.plots.get(0)!.data) expect(v).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(0);
    expect(eng.strategy.marginCalls).toBe(0);
  });

  it('allows the same entry at margin 50 (exactly affordable, boundary case)', async () => {
    // required = 20·100·0.5 = 1000 = equity → opens.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100, margin_long = 50)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      flat20,
    );
    expect(eng.outputs.plots.get(0)!.data[1]).toBe(100);
  });

  it('margin 0 restores the v5 no-funds-check behavior', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100, margin_long = 0)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      flat20,
    );
    expect(eng.outputs.plots.get(0)!.data[1]).toBe(100); // $2000 position on $1000 equity
    expect(eng.strategy.marginCalls).toBe(0);
  });

  it('percent_of_equity at 200% is blocked at margin 100, allowed at 50', async () => {
    const mk = (margin: number) =>
      `//@version=6\nstrategy("s", initial_capital = 1000, default_qty_type = strategy.percent_of_equity, default_qty_value = 200, margin_long = ${margin})\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n`;
    const blocked = await bothBackends(mk(100), flat20);
    expect(blocked.outputs.plots.get(0)!.data[1]).toBe(0);
    const allowed = await bothBackends(mk(50), flat20);
    expect(allowed.outputs.plots.get(0)!.data[1]).toBe(100); // 2·1000/20
  });

  it('gates a pyramiding add on the COMBINED position size', async () => {
    // 30 @ 20 = $600 ok; the add would make 60 @ 20 = $1200 > $1000 → dropped.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 30, pyramiding = 2)\nif bar_index <= 1\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      flat20,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(30);
    expect(sz[5]).toBe(30); // add rejected, first lot untouched
  });

  it('closing fills are never gated', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 50)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 2\n    strategy.close("L")\nplot(strategy.position_size)\n',
      flat20,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(50);
    expect(sz[3]).toBe(0);
  });
});

describe('strategy margin — margin calls (forced liquidation)', () => {
  it('full liquidation: 4× the deficit exceeds the position (plan §6, case 1)', async () => {
    // IC 1000, margin 25%, long 100 @ 20 (liq price 13.33). Dump bar low 12:
    // equity 200 < required 300, deficit 100, 4×qToCover = 133.3 → capped at 100.
    const bars = [flat(20, 0), flat(20, 1), bar(2, 20, 20, 12, 12), flat(12, 3)];
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100, margin_long = 25)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      bars,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(100);
    expect(sz[2]).toBe(0); // liquidated intrabar, before bar 2's script body
    expect(eng.strategy.marginCalls).toBe(1);
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0]!.exitPrice).toBe(12);
    expect(eng.strategy.netProfit).toBeCloseTo(-800, 9);
  });

  it('partial liquidation: exactly 4× the amount needed (plan §6, case 2)', async () => {
    // IC 1000, margin 10%, long 300 @ 20 (liq price 18.52). Bar low 18.40:
    // equity 520 < required 552, deficit 32 → liquidate 4·32/1.84 = 69.5652…
    const bars = [flat(20, 0), flat(20, 1), bar(2, 20, 20, 18.4, 18.4), flat(18.4, 3)];
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 300, margin_long = 10)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
      bars,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(300);
    expect(sz[2]).toBeCloseTo(230.4348, 3); // 300 − 69.5652
    expect(eng.strategy.marginCalls).toBe(1);
    const t = eng.strategy.closedTrades[0]!;
    expect(t.qty).toBeCloseTo(69.5652, 3);
    expect(t.exitPrice).toBe(18.4);
    expect(eng.strategy.netProfit).toBeCloseTo(-111.3043, 3);
    // cushion restored: required 424 < equity 520 at the same price
  });

  it('a short at the v6 default margin 100 gets margin called (migration-guide headline)', async () => {
    // Short 40 @ 25 (required 1000 = equity, boundary-opens; liq price 25).
    // Bar high 26: equity 960 < required 1040, deficit 80 → liquidate 4·80/26 = 12.3077.
    const bars = [flat(25, 0), flat(25, 1), bar(2, 25, 26, 25, 25), flat(25, 3)];
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 40)\nif bar_index == 0\n    strategy.entry("S", strategy.short)\nplot(strategy.position_size)\nplot(strategy.margin_liquidation_price)\n',
      bars,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(-40);
    expect(sz[2]).toBeCloseTo(-27.6923, 3);
    expect(eng.strategy.marginCalls).toBe(1);
    expect(eng.strategy.netProfit).toBeCloseTo(-12.3077, 3);
    // liq price while short 40 @ 25: (1000/40 + 25)/(1+1) = 25
    expect(eng.outputs.plots.get(1)!.data[1]).toBeCloseTo(25, 9);
  });

  it('exit brackets survive a margin call and keep covering the reduced position', async () => {
    // Partial call on bar 2 (as above), then bar 3 hits the bracket stop at 16.
    const bars = [flat(20, 0), flat(20, 1), bar(2, 20, 20, 18.4, 18.4), bar(3, 18.4, 18.4, 15, 15)];
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 300, margin_long = 10)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\n    strategy.exit("X", "L", stop = 16)\nplot(strategy.position_size)\n',
      bars,
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[2]).toBeCloseTo(230.4348, 3); // margin call did NOT cancel the bracket…
    expect(sz[3]).toBe(0); // …which stops out the remainder at 16
    expect(eng.strategy.marginCalls).toBe(1); // position gone before bar 3's mark
    expect(eng.strategy.closedTrades.length).toBe(2);
    expect(eng.strategy.closedTrades[1]!.exitPrice).toBe(16);
  });

  it('no margin call without a real deficit (flat bars at the entry price)', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 40)\nif bar_index == 0\n    strategy.entry("S", strategy.short)\nplot(strategy.position_size)\n',
      Array.from({ length: 5 }, (_, i) => flat(25, i)),
    );
    expect(eng.strategy.marginCalls).toBe(0); // equity == required is not a loss
    expect(eng.outputs.plots.get(0)!.data[4]).toBe(-40);
  });
});

describe('strategy.margin_liquidation_price', () => {
  const flat20 = Array.from({ length: 4 }, (_, i) => flat(20, i));

  it('reports the hand-computed level for a levered long, na while flat', async () => {
    // ((1000/100) − 20)/(0.25 − 1) = 13.3333 → 13.33 at mintick 0.01.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100, margin_long = 25)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.margin_liquidation_price)\n',
      flat20,
    );
    const lp = eng.outputs.plots.get(0)!.data;
    expect(Number.isNaN(lp[0])).toBe(true); // flat
    expect(lp[1]).toBeCloseTo(13.33, 9); // tick-rounded
  });

  it('is na for a fully-funded long (margin 100) and when margin is 0', async () => {
    for (const margin of [100, 0]) {
      const eng = await bothBackends(
        `//@version=6\nstrategy("s", initial_capital = 10000, default_qty_value = 10, margin_long = ${margin})\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.margin_liquidation_price)\n`,
        flat20,
      );
      for (const v of eng.outputs.plots.get(0)!.data) expect(Number.isNaN(v)).toBe(true);
    }
  });
});

describe('strategy margin — realtime rollback', () => {
  it('a margin call on an open tick rolls back cleanly when the bar is replayed', async () => {
    const c = compile(
      '//@version=6\nstrategy("s", initial_capital = 1000, default_qty_value = 100, margin_long = 25)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
    );
    const eng = new Engine(c, new ArrayFeed([flat(20, 0), flat(20, 1)]), { backend: 'js' });
    await eng.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(eng.strategy.marginCalls).toBe(0);

    // Open tick dips through the liquidation price → the call fires…
    eng.tick(bar(2, 20, 20, 12, 12), false);
    expect(eng.strategy.marginCalls).toBe(1);
    expect(eng.strategy.closedTrades.length).toBe(1);

    // …but the bar closes benign: rollback + replay must restore everything
    // (guards the marginCallCount SNAP_SCALARS entry).
    eng.tick(bar(2, 20, 20, 19, 19), true);
    expect(eng.strategy.marginCalls).toBe(0);
    expect(eng.strategy.closedTrades.length).toBe(0);
  });
});
