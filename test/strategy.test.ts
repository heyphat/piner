import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// 10 bars; open == close == 100 + i, range ±2. Predictable next-bar-open fills.
const bars: Bar[] = Array.from({ length: 10 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
});

/** Run both backends, assert plot outputs agree, return the JS-backend engine. */
async function bothBackends(src: string, mintick?: number, data: Bar[] = bars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '1', mintick });
  await ip.run({ symbol: 'BTCUSD', timeframe: '1', mintick });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i],
        b = ipp.data[i];
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
    expect(sz[1]).toBe(1); // long after bar1 fill
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

  it('strategy.close(id) closes a pyramided add by its own id (was a no-op for non-first ids)', async () => {
    // pyramiding=2: entry "A" fills bar1, entry "B" fills bar2 → size 2. close("B") queued
    // bar3 fills bar4 open → closes B's 1 contract, leaving A's 1. Previously close("B") was
    // a silent no-op because only the FIRST entry's id ("A") was tracked.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2, default_qty_value = 1)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 1\n    strategy.entry("B", strategy.long)\nif bar_index == 3\n    strategy.close("B")\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[2]).toBe(2); // both adds on
    expect(sz[9]).toBe(1); // B closed, A remains — not 2 (no-op) and not 0 (over-close)
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].entryId).toBe('B');
    expect(eng.strategy.closedTrades[0].qty).toBe(1);
  });

  it('close_all while flat is a no-op — a same-bar entry cannot instantly round-trip (was profit-0 trades)', async () => {
    // TV's "Order execution demo": close_all() runs on EVERY bar, but it only
    // creates an order when a position is OPEN at call time. Previously the flat
    // bar-0 call queued a closeAll that filled right after the entry in bar 1's
    // pass — an instant zero-profit round trip at the same price.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.close_all()\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1); // entry fills bar1 open — NOT instantly closed
    expect(sz[2]).toBe(0); // close_all called on bar1 (position open) fills bar2 open
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].entryPrice).toBe(101);
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(102);
    expect(eng.strategy.netProfit).toBeCloseTo(1, 9);
  });

  it('close(id) with no open entry under that id is a no-op at call time', async () => {
    // entry("A") + close("A") on the same flat bar: the close must not latch onto
    // the not-yet-filled entry. A later close("A") with the position open works.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("A", strategy.long)\n    strategy.close("A")\nif bar_index == 3\n    strategy.close("A")\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[1]).toBe(1); // opened bar1, same-bar close was gated out
    expect(sz[3]).toBe(1); // still open
    expect(sz[4]).toBe(0); // bar-3 close (position open at call) fills bar4
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(104);
  });

  it('close(id) exits every pyramided lot under the id in one fill (FIFO row per lot)', async () => {
    // TV's "Multiple close demo" behavior: three "buy" lots (pyramiding = 3), one
    // close("buy") → all three close in a single market fill, each booking its own
    // FIFO row at its own entry price.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 3)\nif bar_index <= 2\n    strategy.entry("buy", strategy.long)\nif bar_index == 5\n    strategy.close("buy")\nplot(strategy.position_size)\n',
    );
    const s = eng.strategy;
    expect(s.closedTrades.length).toBe(3);
    s.closedTrades.forEach((t, k) => {
      expect(t.entryBar).toBe(k + 1); // fills at bars 1/2/3 @101/102/103
      expect(t.entryPrice).toBe(101 + k);
      expect(t.exitBar).toBe(6); // one market fill closes all three
      expect(t.exitPrice).toBe(106);
    });
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(0);
  });

  it('pyramiding capacity is freed when an open trade closes (cap counts OPEN entry trades)', async () => {
    // TV: after the pyramiding limit, entries are blocked "until at least one of
    // the existing trades closes". With A + B open (cap 2), closing B must allow
    // C to fill. Previously the gate counted adds-since-flat and never freed.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 1\n    strategy.entry("B", strategy.long)\nif bar_index == 2\n    strategy.close("B")\nif bar_index == 4\n    strategy.entry("C", strategy.long)\nplot(strategy.position_size)\n',
    );
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[2]).toBe(2); // A + B open at the cap
    expect(sz[3]).toBe(1); // B closed → capacity freed
    expect(sz[5]).toBe(2); // C fills — was blocked before the fix
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].entryId).toBe('B');
  });

  it('a canceled resting limit never fills, even when price later reaches its level', async () => {
    // TV's "Cancel demo" behavior: a limit placed at bar 0 (94, below the range)
    // and canceled at bar 2 — before any touch. The bar-5 dip through the level
    // must NOT fill the canceled order.
    const data: Bar[] = Array.from({ length: 10 }, (_, i) => ({
      time: i * 60000,
      open: 100,
      high: 100.5,
      low: i === 5 ? 90 : 99.5,
      close: 100,
      volume: 1,
    }));
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("buy", strategy.long, limit = 94)\nif bar_index == 2\n    strategy.cancel("buy")\nplot(strategy.position_size)\n',
      undefined,
      data,
    );
    expect(eng.strategy.closedTrades.length).toBe(0);
    for (const v of eng.outputs.plots.get(0)!.data) expect(v).toBe(0);
  });

  it('an exit bracket covers only entries created at-or-before its call — not later same-id entries', async () => {
    // Pine's exit-persist rule: exit("X", "A") called on bar 2 scopes to the "A"
    // lot already open; the second "A" entry (bar 4) is NOT covered. The bar-7
    // dip fires the covered lot's stop and leaves the later lot open. Previously
    // the bracket matched future lots too and closed both.
    const data: Bar[] = Array.from({ length: 10 }, (_, i) => ({
      time: i * 60000,
      open: 100,
      high: 100.5,
      low: i === 7 ? 90 : 99.5,
      close: 100,
      volume: 1,
    }));
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 2\n    strategy.exit("X", "A", stop = 95)\nif bar_index == 4\n    strategy.entry("A", strategy.long)\nplot(strategy.position_size)\n',
      undefined,
      data,
    );
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].entryBar).toBe(1); // the covered lot only
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(95);
    const sz = eng.outputs.plots.get(0)!.data;
    expect(sz[6]).toBe(2); // both lots open before the dip
    expect(sz[9]).toBe(1); // the bar-5 lot survives — no exit covers it
  });

  it('exit brackets reserve quantity in call order — a later bracket triggering first takes only its share', async () => {
    // Pine's reserved-exit rule: exit e1 (qty 19, limit) reserves 19 of the 20
    // shares, so e2 (qty 20, stop) covers only 1 — even though its stop triggers
    // FIRST. Previously e2 closed all 20.
    const data: Bar[] = Array.from({ length: 10 }, (_, i) => ({
      time: i * 60000,
      open: 100,
      high: i === 8 ? 115 : 100.5,
      low: i === 5 ? 90 : 99.5,
      close: 100,
      volume: 1,
    }));
    const eng = await bothBackends(
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty = 20)\nif bar_index == 2\n    strategy.exit("e1", limit = 110, qty = 19)\n    strategy.exit("e2", stop = 95, qty = 20)\nplot(strategy.position_size)\n',
      undefined,
      data,
    );
    const s = eng.strategy;
    expect(s.closedTrades.length).toBe(2);
    expect(s.closedTrades[0].qty).toBe(1); // the stop takes ONLY its unreserved share
    expect(s.closedTrades[0].exitPrice).toBe(95);
    expect(s.closedTrades[0].exitBar).toBe(5);
    expect(s.closedTrades[1].qty).toBe(19); // the reservation survives for the limit
    expect(s.closedTrades[1].exitPrice).toBe(110);
    expect(s.closedTrades[1].exitBar).toBe(8);
    expect(eng.outputs.plots.get(0)!.data[6]).toBe(19); // 20 − 1 after the stop
  });

  it('per-trade commission, fill times, percents, and excursions (documented fields, were NaN)', async () => {
    // cash_per_order commission = 1: entry fills bar1 @101 (fee 1), close fills
    // bar6 @106 (fee 1) → trade profit 5-1-1 = 3. While held (bars 1..5): best
    // high 107 (bar5) → run-up 6; worst low 99 (bar1) → drawdown 2.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", commission_type = strategy.commission.cash_per_order, commission_value = 1)\n' +
        'if bar_index == 0\n    strategy.entry("L", strategy.long)\n' +
        'if bar_index == 5\n    strategy.close("L")\n' +
        'plot(strategy.closedtrades.commission(0))\n' +
        'plot(strategy.closedtrades.entry_time(0))\n' +
        'plot(strategy.closedtrades.exit_time(0))\n' +
        'plot(strategy.closedtrades.profit_percent(0))\n' +
        'plot(strategy.closedtrades.max_runup(0))\n' +
        'plot(strategy.closedtrades.max_drawdown(0))\n' +
        'plot(strategy.opentrades.commission(0))\n' +
        'plot(strategy.opentrades.entry_time(0))\n' +
        'plot(strategy.opentrades.max_drawdown(0))\n',
    );
    const at9 = (p: number) => eng.outputs.plots.get(p)!.data[9];
    expect(at9(0)).toBeCloseTo(2, 9); // both sides' commission on the row
    expect(at9(1)).toBe(60000); // entry_time = bar1's time
    expect(at9(2)).toBe(360000); // exit_time = bar6's time
    expect(at9(3)).toBeCloseTo((3 / 101) * 100, 9); // profit_percent (net of fees)
    expect(at9(4)).toBeCloseTo(6, 9); // max_runup
    expect(at9(5)).toBeCloseTo(2, 9); // max_drawdown
    // Open-trade view mid-position (bar 3): entry fee only, live extremes.
    const at3 = (p: number) => eng.outputs.plots.get(p)!.data[3];
    expect(at3(6)).toBeCloseTo(1, 9); // opentrades.commission = entry fee
    expect(at3(7)).toBe(60000); // opentrades.entry_time
    expect(at3(8)).toBeCloseTo(2, 9); // opentrades.max_drawdown so far
    expect(at9(6)).toBeNaN(); // flat again → no open trade 0
    // Broker report: total commission both sides; profit net of fees.
    expect(eng.strategy.totalCommission).toBeCloseTo(2, 9);
    expect(eng.strategy.netProfit).toBeCloseTo(3, 9);
    expect(eng.strategy.closedTrades[0].commission).toBeCloseTo(2, 9);
    expect(eng.strategy.closedTrades[0].maxRunup).toBeCloseTo(6, 9);
    expect(eng.strategy.closedTrades[0].entryTime).toBe(60000);
  });

  it('configurable mintick scales tick-denominated exits (was hard-coded 0.01)', async () => {
    // Long fills bar1 @101; lows are 98+i, so the lowest low from bar1 on is 99.
    // exit loss=50 ticks → stop = 101 - 50*mintick. mintick=0.01 → 100.5 (>= 99 → stopped
    // out); mintick=0.05 → 98.5 (< 99 → never breached → stays open). Same script, the only
    // difference is the tick size.
    const src =
      '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", loss = 50)\nplot(strategy.position_size)\n';

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
    const run = async (prices: number[]) => {
      const tb: Bar[] = prices.map((px, i) => ({
        time: i * 60000,
        open: px,
        high: px + 1,
        low: px - 1,
        close: px,
        volume: 1,
      }));
      const src =
        '//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", trail_points = 200, trail_offset = 300)\nplot(strategy.position_size)\n';
      const c = compile(src);
      const js = new Engine(c, new ArrayFeed(tb), { backend: 'js' });
      const ip = new Engine(c, new ArrayFeed(tb), { backend: 'interp' });
      await js.run({ symbol: 'T', timeframe: '1' });
      await ip.run({ symbol: 'T', timeframe: '1' });
      expect(ip.strategy.closedTrades.length).toBe(js.strategy.closedTrades.length);
      expect(js.strategy.closedTrades.length).toBe(1); // the trail closed the position
      return js.strategy.closedTrades[0];
    };
    // entry @100; rise to peak high 116 ratchets the stop (offset 3.0) to 113; the
    // pullback bar opens above it (113.5) and pierces it intrabar → exit @113.
    expect((await run([100, 100, 110, 115, 113.5, 105])).exitPrice).toBeCloseTo(113, 9);
    // same rally, but the pullback bar OPENS at 112 — through the 113 stop. A gap
    // through a stop fills at the open, not at the (unreachable) stop level.
    expect((await run([100, 100, 110, 115, 112, 105])).exitPrice).toBeCloseTo(112, 9);
  });

  it('closing a pyramided position books one trade row per entry (FIFO), not one blended row', async () => {
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 1\n    strategy.entry("B", strategy.long)\nif bar_index == 5\n    strategy.close_all()\nplot(strategy.opentrades)\n',
    );
    // A fills bar1 @101, B fills bar2 @102; close_all fills bar6 @106 → TWO rows
    expect(eng.strategy.closedTrades.length).toBe(2);
    const [a, b] = eng.strategy.closedTrades;
    expect(a.entryId).toBe('A');
    expect(a.entryPrice).toBe(101);
    expect(a.entryBar).toBe(1);
    expect(a.profit).toBeCloseTo(5, 9);
    expect(b.entryId).toBe('B');
    expect(b.entryPrice).toBe(102);
    expect(b.entryBar).toBe(2);
    expect(b.profit).toBeCloseTo(4, 9);
    // strategy.opentrades counts one open trade per entry lot
    const ot = eng.outputs.plots.get(0)!.data;
    expect(ot[1]).toBe(1);
    expect(ot[3]).toBe(2);
    expect(ot[9]).toBe(0);
  });

  it("strategy.exit from_entry targets only that entry's lots", async () => {
    // A @101 (bar1), B @102 (bar2). The exit tied to "B" (profit 100 ticks → 103,
    // hit by bar2's high 104) closes ONLY B; A stays open to the end.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 1\n    strategy.entry("B", strategy.long)\nstrategy.exit("X", from_entry = "B", profit = 100)\nplot(strategy.position_size)\n',
    );
    expect(eng.strategy.closedTrades.length).toBe(1);
    expect(eng.strategy.closedTrades[0].entryId).toBe('B');
    expect(eng.strategy.closedTrades[0].entryPrice).toBe(102);
    expect(eng.strategy.closedTrades[0].exitPrice).toBe(103);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(1); // A still open
  });

  it("exit profit ticks are measured from each entry's own fill price, not the position average", async () => {
    // A @101 → target 105 (hit bar3, high 105); B @102 → target 106 (hit bar4).
    // The position average (101.5) would have put both targets at 105.5.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", pyramiding = 2)\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 1\n    strategy.entry("B", strategy.long)\nstrategy.exit("X", profit = 400)\nplot(strategy.position_avg_price)\n',
    );
    expect(eng.strategy.closedTrades.length).toBe(2);
    const [a, b] = eng.strategy.closedTrades;
    expect(a.entryId).toBe('A');
    expect(a.exitPrice).toBe(105);
    expect(a.exitBar).toBe(3);
    expect(b.entryId).toBe('B');
    expect(b.exitPrice).toBe(106);
    expect(b.exitBar).toBe(4);
    // after the FIFO close of A, the remaining position re-prices to B's entry
    const ap = eng.outputs.plots.get(0)!.data;
    expect(ap[2]).toBeCloseTo(101.5, 9); // both lots open
    expect(ap[3]).toBeCloseTo(102, 9); // only B left
  });

  it('strategy.cancel(id) cancels exit brackets too', async () => {
    const falling: Bar[] = Array.from({ length: 10 }, (_, i) => {
      const px = 110 - i;
      return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
    });
    const src = (cancel: boolean) =>
      `//@version=6\nstrategy("s")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\n    strategy.exit("X", "L", stop = 104)\n${cancel ? 'if bar_index == 2\n    strategy.cancel("X")\n' : ''}plot(strategy.position_size)\n`;
    const c = compile(src(true));
    for (const backend of ['js', 'interp'] as const) {
      const eng = new Engine(c, new ArrayFeed(falling), { backend });
      await eng.run({ symbol: 'T', timeframe: '1' });
      expect(eng.strategy.closedTrades.length).toBe(0); // stop canceled before the breach
      expect(eng.outputs.plots.get(0)!.data[9]).toBe(1);
    }
    // control: without the cancel, the stop fills at 104 on bar 4
    const ctrl = new Engine(compile(src(false)), new ArrayFeed(falling), { backend: 'js' });
    await ctrl.run({ symbol: 'T', timeframe: '1' });
    expect(ctrl.strategy.closedTrades.length).toBe(1);
    expect(ctrl.strategy.closedTrades[0].exitPrice).toBe(104);
  });

  it('process_orders_on_close checks new exits against the close tick only (no pre-close lookahead)', async () => {
    // Long from bar0 close @100 (POC). The exit stop 101 is created at bar2's close
    // (close 102, but the bar's LOW was 100 ≤ 101). The pre-close range predates the
    // order, so it must NOT fill on bar2 — it fills on bar3, whose low touches 101.
    const eng = await bothBackends(
      '//@version=6\nstrategy("s", process_orders_on_close = true)\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 2\n    strategy.exit("X", "L", stop = 101)\nplot(strategy.position_size)\n',
    );
    expect(eng.strategy.closedTrades.length).toBe(1);
    const t = eng.strategy.closedTrades[0];
    expect(t.exitBar).toBe(3); // NOT bar 2
    expect(t.exitPrice).toBe(101);
  });
});
