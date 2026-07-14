import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar, type LibraryRegistry } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ~5 trending, volatile days of hourly bars so sessions, week separators,
// HTF request.security (Day/Week), pivots, swings and FVGs all get exercised.
function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2021, 0, 4, 0, 0, 0); // Mon 2021-01-04
  for (let i = 0; i < n; i++) {
    const p = 100 + i * 0.3 + Math.sin(i / 3) * 10;
    bars.push({
      time: start + i * 3_600_000,
      open: p,
      high: p + Math.abs(Math.sin(i)) * 5,
      low: p - Math.abs(Math.cos(i)) * 5,
      close: p + Math.sin(i / 2) * 3,
      volume: 1000 + (i % 11) * 120,
    });
  }
  return bars;
}

const eqNaN = (a: unknown, b: unknown) =>
  (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) || a === b;

const bars = makeBars(200);

/** Compile a real script, run both backends, and assert byte-for-byte plot + drawing parity. */
function runReal(
  file: string,
  opts: {
    bars?: Bar[];
    inputs?: Record<string, unknown>;
    libraries?: LibraryRegistry;
    /** Host-injected request.security bars, keyed "<symbol>@<tf>" (lower-TF) or "<symbol>". */
    securityBars?: Record<string, Bar[]>;
  } = {},
) {
  const data = opts.bars ?? bars;
  const src = readFileSync(join(HERE, 'pinescripts', file), 'utf8');
  const c = compile(src, opts.libraries ? { libraries: opts.libraries } : undefined);
  // Input overrides are an ENGINE option (ctx.inputOverrides), not a run() option —
  // passing them to run() silently dropped them.
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js', inputs: opts.inputs });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp', inputs: opts.inputs });
  for (const [key, sb] of Object.entries(opts.securityBars ?? {})) {
    js.ctx.securityBars.set(key, sb);
    ip.ctx.securityBars.set(key, sb);
  }
  const run = { symbol: 'BTCUSD', timeframe: '60' };
  return Promise.all([js.run(run), ip.run(run)]).then(() => {
    for (const [id, jp] of js.outputs.plots) {
      const ipp = ip.outputs.plots.get(id)!;
      expect(ipp).toBeDefined();
      expect(jp.data.length).toBe(ipp.data.length);
      for (let i = 0; i < jp.data.length; i++) {
        if (!eqNaN(jp.data[i], ipp.data[i])) {
          throw new Error(
            `backend divergence in plot ${id} ("${jp.title}") at bar ${i}: js=${jp.data[i]} interp=${ipp.data[i]}`,
          );
        }
      }
    }
    if (JSON.stringify(js.drawings) !== JSON.stringify(ip.drawings)) {
      throw new Error(
        `backend divergence in drawings (${js.drawings.length} js vs ${ip.drawings.length} interp)`,
      );
    }
    if (c.metadata.isStrategy && JSON.stringify(js.strategy) !== JSON.stringify(ip.strategy)) {
      throw new Error(
        `backend divergence in the strategy report (${js.strategy.closedTrades.length} js vs ${ip.strategy.closedTrades.length} interp trades)`,
      );
    }
    return { c, js };
  });
}

describe('real published TradingView scripts', () => {
  it('VWAP + Trading Sessions (v6): compiles, runs, plots the VWAP and bands', async () => {
    const { c, js } = await runReal('vwap-trading-sessions.pine');
    expect(c.metadata.title).toBe('VWAP + Trading Sessions');
    // VWAP + 3 upper + 3 lower bands = 7 plots, all populated.
    expect(js.outputs.plots.size).toBe(7);
    for (const p of js.outputs.plots.values()) {
      const real = p.data.filter((v) => typeof v === 'number' && !Number.isNaN(v)).length;
      expect(real).toBeGreaterThan(0);
    }
  });

  it('LuxAlgo FVG + Liquidity Swings + Previous H/L (v5): compiles, runs, draws & alerts', async () => {
    const { c, js } = await runReal('luxalgo.pine');
    expect(c.metadata.title).toContain('FVG');
    // The script's value is its drawings + alerts, not plots.
    const byType = drawCounts(js);
    expect(byType.box).toBeGreaterThan(0);
    expect(byType.line).toBeGreaterThan(0);
    expect(byType.label).toBeGreaterThan(0);
    expect(js.outputs.alerts.length).toBeGreaterThan(0);
  });

  it('TigerX Fair Value Gap (v5): compiles, draws FVG boxes (legacy `box[]` array types)', async () => {
    // A strong uptrend leaves bullish FVGs unmitigated so the `box[]` store fills.
    const trend: Bar[] = Array.from({ length: 120 }, (_, i) => {
      const p = 100 + i * 2;
      return {
        time: Date.UTC(2021, 0, 4) + i * 3_600_000,
        open: p,
        high: p + 3,
        low: p + 0.5,
        close: p + 2.5,
        volume: 1000 + (i % 11) * 120,
      };
    });
    const { c, js } = await runReal('fvg.pine', {
      bars: trend,
      inputs: { 'Filter by ATR': false },
    });
    expect(c.metadata.title).toBe('Fair Value Gap (FVG)');
    const byType = drawCounts(js);
    expect(byType.box).toBeGreaterThan(0); // FVG zones
    expect(byType.table).toBe(1); // info table
    expect(js.outputs.alerts.length).toBeGreaterThan(0);
  });

  it('LuxAlgo Breaker Blocks with Signals (v5): compiles, runs, draws (comma-separated statement series)', async () => {
    // Exercises Pine's comma-separated statement series on one line — method bodies
    // like `=> aB.unshift(b), aB.pop().delete()` and expression-statement runs such as
    // `aZZ.d.unshift(d), aZZ.x.unshift(x2), …`. runReal also asserts JS↔interp parity.
    const { c, js } = await runReal('breaker.pine');
    expect(c.metadata.title).toBe('Breaker Blocks with Signals [LuxAlgo]');
    const byType = drawCounts(js);
    expect(byType.box).toBeGreaterThan(0);
    expect(byType.line).toBeGreaterThan(0);
    expect(byType.label).toBeGreaterThan(0);
  });

  it('TradingView Auto Pitchfork (v6): `import TradingView/ZigZag/7` end-to-end (library-import-export)', async () => {
    // The motivating script for library imports: it delegates swing detection to the
    // vendored TradingView/ZigZag/7 library (UDTs + methods + chart.point), then draws
    // the pitchfork median/levels + linefills from the last three pivots. Its output is
    // exclusively drawings — runReal asserts they are byte-for-byte identical across
    // backends.
    const zigzag: LibraryRegistry = [
      {
        key: 'TradingView/ZigZag/7',
        source: readFileSync(join(HERE, 'pinescripts/libraries/tradingview-zigzag-7.pine'), 'utf8'),
      },
    ];
    const { c, js } = await runReal('auto-pitchfork.pine', { libraries: zigzag });
    expect(c.metadata.title).toBe('Auto Pitchfork');
    const byType = drawCounts(js);
    expect(byType.line).toBeGreaterThan(0); // median + tines
    expect(byType.linefill).toBeGreaterThan(0); // level bands
  });

  it('Intrabar X-Ray Profile (v6): security_lower_tf tuple + string `+=` bar text', async () => {
    // Builds a per-candle volume profile from injected 1-minute intrabars. The profile
    // bars are runs of "█" accumulated with a string `+=` in a loop — the regression
    // that used to lower to numeric add and emit null box text (crashing the host).
    const ltf: Bar[] = [];
    for (const b of bars)
      for (let m = 0; m < 60; m++) {
        const f0 = m / 60,
          f1 = (m + 1) / 60;
        const p0 = b.low + (b.high - b.low) * Math.abs(Math.sin(f0 * 7));
        const p1 = b.low + (b.high - b.low) * Math.abs(Math.sin(f1 * 7));
        ltf.push({
          time: b.time + m * 60_000,
          open: p0,
          high: Math.max(p0, p1),
          low: Math.min(p0, p1),
          close: p1,
          volume: (b.volume ?? 0) / 60,
        });
      }
    const { c, js } = await runReal('intrabar-xray-profile.pine', {
      securityBars: { 'BTCUSD@1': ltf },
    });
    expect(c.metadata.title).toBe('Intrabar X-Ray Profile by [dk_codenut]');
    const byType = drawCounts(js);
    expect(byType.box).toBeGreaterThan(0); // profile rows
    expect(byType.label).toBeGreaterThan(0); // footprint values + delta summaries
    expect(byType.line).toBeGreaterThan(0); // POC connector
    // every profile box carries its block-character bar text — never na/null
    for (const d of js.drawings)
      if (d.type === 'box') expect(String(d.props['text'])).toMatch(/^█+$/);
  });
});

function drawCounts(eng: Engine): Record<string, number> {
  const pool = (eng as unknown as { ctx: { drawPool: { objects: Map<number, { type: string }> } } })
    .ctx.drawPool;
  const byType: Record<string, number> = {};
  for (const o of pool.objects.values()) byType[o.type] = (byType[o.type] ?? 0) + 1;
  return byType;
}

describe('realistic strategy corpus (test/pinescripts/strategies)', () => {
  // Seeded LCG random walk with slow bull/bear regimes and occasional impulse bars —
  // organic enough to form swings, BOS/CHoCH flips, and FVGs that price retraces into.
  // Deterministic: the SMC assertions below are pinned to this exact series.
  function smcBars(n: number, seed: number, drift = 0.8, vol = 1.6): Bar[] {
    let s = seed >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const out: Bar[] = [];
    let px = 100;
    const start = Date.UTC(2021, 0, 4);
    for (let i = 0; i < n; i++) {
      const regime = Math.sin(i / 40) > 0 ? 1 : -1;
      const shock = rnd() < 0.08 ? (rnd() < 0.5 ? -1 : 1) * vol * 4 : 0;
      const move = regime * drift + (rnd() - 0.5) * 2 * vol + shock;
      const open = px;
      const close = px + move;
      const wickU = rnd() * vol * (shock !== 0 ? 0.15 : 0.9);
      const wickD = rnd() * vol * (shock !== 0 ? 0.15 : 0.9);
      out.push({
        time: start + i * 3_600_000,
        open,
        close,
        high: Math.max(open, close) + wickU,
        low: Math.min(open, close) - wickD,
        volume: 1000 + Math.floor(rnd() * 900),
      });
      px = close;
    }
    return out;
  }

  it('order-demo (TV docs): close_all only acts on an open position — one-bar trades, labels one bar before each entry', async () => {
    // TradingView's "Order execution demo" from the Strategies docs: an entry every
    // 20th bar and strategy.close_all() on EVERY bar. Per the docs, the close_all
    // call "only creates a new exit order when the strategy has an open position" —
    // so each entry fills at the NEXT bar's open and the position closes one bar
    // later, never instantly.
    const { c, js } = await runReal('strategies/tv-docs-strategies/02-order-execution-demo.pine');
    expect(c.metadata.title).toBe('Order execution demo');
    expect(c.metadata.isStrategy).toBe(true);
    const s = js.strategy;
    // entries signal on bars 0,20,…,180 → fill on 1,21,…,181 → close on the next bar
    expect(s.closedTrades.length).toBe(10);
    for (const t of s.closedTrades) {
      expect(t.entryBar % 20).toBe(1); // filled one bar after the signal
      expect(t.exitBar).toBe(t.entryBar + 1); // held exactly one bar
      expect(t.entryPrice).toBe(bars[t.entryBar].open);
      expect(t.exitPrice).toBe(bars[t.exitBar].open);
    }
    // one debug label per entry signal, drawn on the SIGNAL bar (one before the fill)
    const labels = js.drawings.filter((d) => d.type === 'label');
    expect(labels.length).toBe(10);
  });

  it('market-order (TV docs): alternating entries reverse the position every cycle', async () => {
    // TradingView's "Market order demo": a long entry every 2×length bars, a short
    // entry every length bars in between (else-if). Each strategy.entry REVERSES:
    // it closes the open opposite trade at its own fill price and opens the flip.
    const { c, js } = await runReal('strategies/tv-docs-strategies/03-market-order-demo.pine');
    expect(c.metadata.title).toBe('Market order demo');
    const s = js.strategy;
    // signals at 0,10,…,190 fill at 1,11,…,191 → 20 fills, 19 closed + 1 still open
    expect(s.closedTrades.length).toBe(19);
    for (const t of s.closedTrades) {
      expect(t.entryBar % 10).toBe(1); // filled one bar after its signal
      expect(t.exitBar).toBe(t.entryBar + 10); // reversed by the next signal's fill
      expect(t.dir).toBe((t.entryBar - 1) % 20 === 0 ? 1 : -1); // alternating sides
      expect(t.entryId).toBe(t.dir === 1 ? 'My Long Entry Id' : 'My Short Entry Id');
      expect(t.entryPrice).toBe(bars[t.entryBar].open);
      expect(t.exitPrice).toBe(bars[t.exitBar].open);
    }
    expect(js.drawings.filter((d) => d.type === 'label').length).toBe(20);

    // The "Cycle length" input re-paces the whole cycle (8 fills → 7 closed trades).
    const { js: slow } = await runReal('strategies/tv-docs-strategies/03-market-order-demo.pine', {
      inputs: { 'Cycle length': 25 },
    });
    expect(slow.strategy.closedTrades.length).toBe(7);
  });

  it('limit-order (TV docs): the resting limit fills at its price on first touch, or better on a gap', async () => {
    // TradingView's "Limit order demo": 100 bars before the last bar, place a long
    // limit 800 ticks below the close. The order RESTS until price trades down to
    // it — filling at the limit price (or at the open when a bar gaps through) —
    // and never fills on the placement bar itself.
    const { c, js } = await runReal('strategies/tv-docs-strategies/04-limit-order-below.pine');
    expect(c.metadata.title).toBe('Limit order demo');
    const signalBar = 199 - 100;
    const limit = bars[signalBar].close - 0.01 * 800; // syminfo.mintick default 0.01
    // Expected fill: the first later bar that reaches the level (open → gap fill
    // at the better price; else at the limit itself).
    let fillBar = -1;
    let fillPx = NaN;
    for (let i = signalBar + 1; i < bars.length; i++) {
      if (bars[i].open <= limit) {
        fillBar = i;
        fillPx = bars[i].open;
        break;
      }
      if (bars[i].low <= limit) {
        fillBar = i;
        fillPx = limit;
        break;
      }
    }
    expect(fillBar).toBeGreaterThan(signalBar); // the feed does dip to the level
    const st = js.ctx.strategy;
    expect(st.opentrades).toBe(1); // no exit in the script — the trade stays open
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(fillBar);
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(fillPx);
    expect(js.strategy.closedTrades.length).toBe(0);
    // debugLabel draws one label + one dashed extend-right level line
    expect(js.drawings.filter((d) => d.type === 'label').length).toBe(1);
    expect(js.drawings.filter((d) => d.type === 'line').length).toBe(1);
  });

  it('stop-order (TV docs): the resting stop fills at its price on first touch, or WORSE on a gap', async () => {
    // TradingView's "Stop order demo": 100 bars before the last bar, place a long
    // stop 800 ticks above the close. The mirror of the limit demo with the gap
    // rule inverted: a bar opening through the stop fills at the (worse) open.
    const { c, js } = await runReal('strategies/tv-docs-strategies/06-stop-order-demo.pine');
    expect(c.metadata.title).toBe('Stop order demo');
    const signalBar = 199 - 100;
    const stop = bars[signalBar].close + 0.01 * 800; // syminfo.mintick default 0.01
    let fillBar = -1;
    let fillPx = NaN;
    for (let i = signalBar + 1; i < bars.length; i++) {
      if (bars[i].open >= stop) {
        fillBar = i;
        fillPx = bars[i].open; // gap up through the stop → adverse open
        break;
      }
      if (bars[i].high >= stop) {
        fillBar = i;
        fillPx = stop;
        break;
      }
    }
    expect(fillBar).toBeGreaterThan(signalBar); // the feed does rise to the level
    const st = js.ctx.strategy;
    expect(st.opentrades).toBe(1); // no exit in the script — the trade stays open
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(fillBar);
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(fillPx);
    expect(js.strategy.closedTrades.length).toBe(0);
    // debugLabel draws one label + a dotted marker line + a dashed extend-right level line
    expect(js.drawings.filter((d) => d.type === 'label').length).toBe(1);
    expect(js.drawings.filter((d) => d.type === 'line').length).toBe(2);
  });

  it('reverse-position (TV docs): opposite entries reverse with asymmetric quantities (15 ⇄ 5)', async () => {
    // TradingView's "Reversing positions" demo: buy 15 every 100 bars, sell 5 every
    // 50 bars in between. Each opposite strategy.entry closes the WHOLE open
    // position and opens its own full quantity — the position flips +15 → −5 →
    // +15 → −5, never netting.
    const { c, js } = await runReal(
      'strategies/tv-docs-strategies/09-reversing-positions-demo.pine',
    );
    expect(c.metadata.title).toBe('Reversing positions demo');
    const s = js.strategy;
    // signals 0/100 (buy) and 50/150 (sell) fill one bar later; 3 closed + 1 open
    expect(s.closedTrades.length).toBe(3);
    const expected = [
      { id: 'buy', dir: 1, qty: 15, entryBar: 1, exitBar: 51 },
      { id: 'sell', dir: -1, qty: 5, entryBar: 51, exitBar: 101 },
      { id: 'buy', dir: 1, qty: 15, entryBar: 101, exitBar: 151 },
    ];
    expected.forEach((x, k) => {
      const t = s.closedTrades[k];
      expect(t.entryId).toBe(x.id);
      expect(t.dir).toBe(x.dir);
      expect(t.qty).toBe(x.qty);
      expect(t.entryBar).toBe(x.entryBar);
      expect(t.exitBar).toBe(x.exitBar);
      expect(t.entryPrice).toBe(bars[x.entryBar].open);
      expect(t.exitPrice).toBe(bars[x.exitBar].open);
    });
    expect(js.ctx.strategy.position_size).toBe(-5); // short 5 from bar 151 still open
    // bgcolor highlights on exactly the four signal bars (blue buys, red sells)
    const layers = [...js.outputs.bgColors.values()];
    expect(layers.length).toBe(1);
    const colored = layers[0]
      .map((v: string | null, i: number) => (v != null ? i : -1))
      .filter((i: number) => i >= 0);
    expect(colored).toEqual([0, 50, 100, 150]);
  });

  it('pyramiding (TV docs): the default cap admits ONE entry per position; later signals are blocked', async () => {
    // TradingView's "Pyramiding demo", first variant (default pyramiding = 1): an
    // entry every 25 bars, direction flipping every 100 (the bar-0 flip makes the
    // first cycle SHORT). Only the FIRST entry of each cycle fills — the three
    // same-direction calls after it are blocked; the next cycle's opposite entry
    // reverses.
    const { c, js } = await runReal('strategies/tv-docs-strategies/10-pyramiding-default.pine');
    expect(c.metadata.title).toBe('Pyramiding demo');
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(1); // the single short, closed by the bar-101 reversal
    const t = s.closedTrades[0];
    expect(t.dir).toBe(-1);
    expect(t.qty).toBe(1); // adds at bars 26/51/76 were blocked by the cap
    expect(t.entryBar).toBe(1);
    expect(t.entryPrice).toBe(bars[1].open);
    expect(t.exitBar).toBe(101);
    expect(t.exitPrice).toBe(bars[101].open);
    expect(js.ctx.strategy.position_size).toBe(1); // the reversal's long, alone at the cap
    expect(js.ctx.strategy.opentrades).toBe(1);
    // signal-bar highlights fire on EVERY signal, filled or blocked
    const layer = [...js.outputs.bgColors.values()][0];
    const colored = layer
      .map((v: string | null, i: number) => (v != null ? i : -1))
      .filter((i: number) => i >= 0);
    expect(colored).toEqual([0, 25, 50, 75, 100, 125, 150, 175]);
  });

  it('strategy-order (TV docs): strategy.order NETS — partial closes, never a reversal', async () => {
    // TradingView's "strategy.order() demo": buy 15 every 100 bars, sell 5 on the
    // 25th bars between. Unlike strategy.entry, strategy.order nets against the
    // open position — each sell partially closes the long (15 → 10 → 5 → 0), so
    // the strategy NEVER goes short, and each partial close books its own FIFO
    // row from the "buy" lot at that lot's fill price.
    const { c, js } = await runReal('strategies/tv-docs-strategies/12-strategy-order-demo.pine');
    expect(c.metadata.title).toBe('`strategy.order()` demo');
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(6); // 3 partial closes × 2 cycles
    const expected = [
      { entryBar: 1, exitBar: 26 },
      { entryBar: 1, exitBar: 51 },
      { entryBar: 1, exitBar: 76 },
      { entryBar: 101, exitBar: 126 },
      { entryBar: 101, exitBar: 151 },
      { entryBar: 101, exitBar: 176 },
    ];
    expected.forEach((x, k) => {
      const t = s.closedTrades[k];
      expect(t.entryId).toBe('buy');
      expect(t.dir).toBe(1); // always the long side — never a short trade
      expect(t.qty).toBe(5);
      expect(t.entryBar).toBe(x.entryBar);
      expect(t.exitBar).toBe(x.exitBar);
      expect(t.entryPrice).toBe(bars[x.entryBar].open);
      expect(t.exitPrice).toBe(bars[x.exitBar].open);
    });
    expect(js.ctx.strategy.position_size).toBe(0); // each cycle nets back to flat
    expect(js.ctx.strategy.max_contracts_held_short).toBe(0); // never short at any point
  });

  it('strategy-exit (TV docs): one exit call arms a TP limit + SL stop bracket; either side closes the trade', async () => {
    // TradingView's "Take-profit and stop-loss demo": every 100th bar, enter long
    // and arm strategy.exit("exit", "buy", limit = close*1.01, stop = close*0.99).
    // The bracket is placed on the SIGNAL bar — before its entry even fills — and
    // waits for it. Feed: flat at 100 (range inside the bracket), with bar 10
    // touching the 101 TP and bar 120 touching the 99 SL.
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: 100,
      high: i === 10 ? 101.5 : 100.5,
      low: i === 120 ? 98.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { c, js } = await runReal(
      'strategies/tv-docs-strategies/13-take-profit-stop-loss-demo.pine',
      { bars: data },
    );
    expect(c.metadata.title).toBe('Take-profit and stop-loss demo');
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(2);
    // cycle 1: the take-profit limit fills AT its price on the touching bar
    expect(s.closedTrades[0].entryBar).toBe(1);
    expect(s.closedTrades[0].entryPrice).toBe(100);
    expect(s.closedTrades[0].exitBar).toBe(10);
    expect(s.closedTrades[0].exitPrice).toBe(101);
    // cycle 2: the stop-loss fills AT its price on the touching bar
    expect(s.closedTrades[1].entryBar).toBe(101);
    expect(s.closedTrades[1].exitBar).toBe(120);
    expect(s.closedTrades[1].exitPrice).toBe(99);
    expect(js.ctx.strategy.position_size).toBe(0);
    // the TP/SL level plots show while armed and reset to na on the exit bar
    // (ta.change(strategy.closedtrades) sees the fill BEFORE the body runs)
    const tp = js.outputs.plots.get(0)!.data;
    const sl = js.outputs.plots.get(1)!.data;
    for (const [bar, tpv, slv] of [
      [0, 101, 99],
      [9, 101, 99],
      [10, NaN, NaN],
      [100, 101, 99],
      [119, 101, 99],
      [120, NaN, NaN],
      [199, NaN, NaN],
    ] as const) {
      expect(eqNaN(tp[bar], tpv)).toBe(true);
      expect(eqNaN(sl[bar], slv)).toBe(true);
    }
  });

  it('invalid-entry-id (TV docs): an exit bracket for a nonexistent from_entry never places orders', async () => {
    // TradingView's "Invalid from_entry ID demo" — the negative control for the
    // strategy-exit test, on the SAME feed that filled both bracket sides there:
    // the bracket targets "buy2", which no entry ever creates, so it must never
    // fire even as price crosses both its levels. The position stays open for the
    // whole run and the TP/SL plots never reset.
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: 100,
      high: i === 10 ? 101.5 : 100.5,
      low: i === 120 ? 98.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { c, js } = await runReal(
      'strategies/tv-docs-strategies/14-invalid-from-entry-id-demo.pine',
      { bars: data },
    );
    expect(c.metadata.title).toBe('Invalid `from_entry` ID demo');
    expect(js.strategy.closedTrades.length).toBe(0); // the bracket never fills
    const st = js.ctx.strategy;
    expect(st.position_size).toBe(1); // the bar-1 entry is still open at the end
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(1);
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(100);
    // levels plot from bar 0 and never reset (ta.change(closedtrades) never fires)
    const tp = js.outputs.plots.get(0)!.data;
    const sl = js.outputs.plots.get(1)!.data;
    for (const bar of [0, 10, 11, 120, 121, 199]) {
      expect(tp[bar]).toBe(101);
      expect(sl[bar]).toBe(99);
    }
  });

  it('multi-exit (TV docs): two qty-capped brackets exit one position in stages; oversize reduces to fit', async () => {
    // TradingView's "Multi-level exit demo": enter 2 lots, arm "exit1" (qty 1,
    // TP 101 / SL 99) and "exit2" (qty 3 — auto-reduced to what the position can
    // give, TP 102 / SL 98). Cycle 1 walks up through both TPs; cycle 2 walks
    // down through both SLs. Each partial close books its own FIFO row from the
    // same entry lot.
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: 100,
      high: i === 10 ? 101.5 : i === 20 ? 102.5 : 100.5,
      low: i === 110 ? 98.5 : i === 120 ? 97.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { c, js } = await runReal('strategies/tv-docs-strategies/15-multi-level-exit-demo.pine', {
      bars: data,
    });
    expect(c.metadata.title).toBe('Multi-level exit demo');
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(4);
    const expected = [
      { entryBar: 1, exitBar: 10, exitPrice: 101 }, // exit1 TP takes 1 of 2
      { entryBar: 1, exitBar: 20, exitPrice: 102 }, // exit2 TP takes the rest (3 → 1)
      { entryBar: 101, exitBar: 110, exitPrice: 99 }, // exit1 SL
      { entryBar: 101, exitBar: 120, exitPrice: 98 }, // exit2 SL
    ];
    expected.forEach((x, k) => {
      const t = s.closedTrades[k];
      expect(t.entryId).toBe('buy');
      expect(t.qty).toBe(1); // every fill is a PARTIAL close — never the whole lot
      expect(t.entryBar).toBe(x.entryBar);
      expect(t.entryPrice).toBe(100);
      expect(t.exitBar).toBe(x.exitBar);
      expect(t.exitPrice).toBe(x.exitPrice);
    });
    expect(js.ctx.strategy.position_size).toBe(0);
    // each level's plot resets (na) on its own touch bar, independently
    const plot = (n: number, i: number) => js.outputs.plots.get(n)!.data[i];
    expect(plot(0, 9)).toBe(101); // TP1 armed …
    expect(Number.isNaN(plot(0, 10))).toBe(true); // … reset on its touch
    expect(plot(1, 19)).toBe(102); // TP2 survives TP1's touch …
    expect(Number.isNaN(plot(1, 20))).toBe(true); // … until its own
    expect(plot(2, 109)).toBe(99); // SL1 (cycle 2)
    expect(Number.isNaN(plot(2, 110))).toBe(true);
    expect(plot(3, 119)).toBe(98); // SL2
    expect(Number.isNaN(plot(3, 120))).toBe(true);
  });

  it('trailing-stop (TV docs): arm at the activation level, ratchet behind the highs, fill on the cross-back', async () => {
    // TradingView's "Trailing stops" demo: enter long, then arm strategy.exit with
    // trail_price = entry + 1000 ticks and trail_offset = 2000 ticks. Path: flat at
    // 100 (entry fills bar 100), rise +1/bar to 130, fall −1/bar. The stop arms at
    // 110 (bar 110), ratchets to high−20 (peaking at 110.5 with bar 130's high),
    // holds through the decline, and fills at EXACTLY the ratcheted level on the
    // first touching bar. The script also plots its own bar-level model of the
    // stop — the broker's fill must agree with it to the tick.
    const px = (i: number) => (i <= 100 ? 100 : i <= 130 ? 100 + (i - 100) : 130 - (i - 130));
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: px(i),
      high: px(i) + 0.5,
      low: px(i) - 0.5,
      close: px(i),
      volume: 1,
    }));
    const { c, js } = await runReal(
      'strategies/tv-docs-strategies/17-trailing-stop-order-demo.pine',
      { bars: data },
    );
    expect(c.metadata.title).toBe('Trailing stop order demo');
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(1);
    const t = s.closedTrades[0];
    expect(t.entryId).toBe('Long');
    expect(t.entryBar).toBe(100);
    expect(t.entryPrice).toBe(100);
    expect(t.exitBar).toBe(149); // first bar whose low reaches the ratcheted stop
    expect(t.exitPrice).toBe(110.5); // fills AT the stop level, not the bar low
    expect(t.maxRunup).toBe(30.5); // per-trade MFE: the 130.5 peak over the hold
    expect(js.ctx.strategy.position_size).toBe(0);
    // the script's own visualization of the stop, bar by bar
    const tr = js.outputs.plots.get(0)!.data;
    expect(Number.isNaN(tr[109])).toBe(true); // not yet activated
    expect(tr[110]).toBe(90.5); // arms when high crosses 110 → high − 20
    expect(tr[120]).toBe(100.5); // ratchets with each new high
    expect(tr[130]).toBe(110.5); // the peak locks the final level
    expect(tr[148]).toBe(110.5); // no new highs → holds through the fall
    expect(tr[199]).toBe(110.5); // stays after the close (script never resets it)
    // debug drawings: activation level (bar 100), crossed + activated (bar 110)
    const labelBars = js.drawings.filter((d) => d.type === 'label').map((d) => d.props.x);
    expect(labelBars).toEqual([100, 110, 110]);
  });

  it('same-id-exit (TV docs): one exit call covers both same-id entries, incl. the one pending at call time', async () => {
    // pyramiding = 2, entries on two consecutive bars per cycle; the exit is
    // called on the SECOND signal bar (first lot open, second entry queued) and
    // covers both — they close together at the shared level, so
    // ta.change(closedtrades) == 2 resets the plots on the exit bar.
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: 100,
      high: i === 30 ? 101.5 : 100.5,
      low: i === 130 ? 98.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { js } = await runReal('strategies/tv-docs-strategies/18-exits-same-id-demo.pine', {
      bars: data,
    });
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(4);
    expect(s.closedTrades.map((t) => t.entryBar)).toEqual([1, 2, 101, 102]);
    expect(s.closedTrades.map((t) => t.exitBar)).toEqual([30, 30, 130, 130]);
    expect(s.closedTrades.map((t) => t.exitPrice)).toEqual([101, 101, 99, 99]);
    const tp = js.outputs.plots.get(0)!.data;
    expect(tp[29]).toBe(101);
    expect(Number.isNaN(tp[30])).toBe(true); // reset exactly when BOTH trades close
  });

  it('exit-persist (TV docs): one exit call covers only entries created before/on its bar', async () => {
    // pyramiding = 100, an entry EVERY bar between the start/end time inputs, and
    // ONE strategy.exit(loss = 0) call in the middle. Per the docs, the call
    // covers the entries created before or on its bar and "does not affect any
    // subsequent entries". Staircase feed (low == open, no downticks) so the
    // stop-at-entry orders can't fire during the rise; bar 100 crashes through
    // every stop. Only the 11 covered entries exit — the 19 later ones ride the
    // crash with no exits at all.
    const T0 = Date.UTC(2021, 0, 4);
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => {
      const px = i === 100 ? 50 : 100 + i;
      return {
        time: T0 + i * 3_600_000,
        open: px,
        high: px + 1,
        low: px,
        close: px + 1,
        volume: 1,
      };
    });
    const { js } = await runReal(
      'strategies/tv-docs-strategies/21-exit-persist-with-from-entry.pine',
      {
        bars: data,
        inputs: {
          'Start time for entries': T0 + 10 * 3_600_000, // orders created bars 10..39
          'Exit call time': T0 + 20 * 3_600_000, // covers those created bars 10..20
          'End time for entries': T0 + 40 * 3_600_000,
        },
      },
    );
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(11); // created 10..20 → fills 11..21
    // the bar-20 entry fills at bar 21 with stop == its own open → exits at once;
    // the other ten covered lots gap out at the crash open
    expect(s.closedTrades.filter((t) => t.exitBar === 21).length).toBe(1);
    expect(s.closedTrades.filter((t) => t.exitBar === 100).length).toBe(10);
    for (const t of s.closedTrades.filter((t) => t.exitBar === 100)) expect(t.exitPrice).toBe(50);
    expect(js.ctx.strategy.position_size).toBe(19); // uncovered entries never exit
  });

  it('reversed-exit (TV docs): exit quantity is RESERVED in call order across brackets', async () => {
    // "Reserved exit demo": enter 20 shares; exit "limit" (qty 19) reserves 19,
    // so exit "stop" (qty 20) creates an order for only 1 share. The stop
    // triggers FIRST (bar 110) and must close exactly 1; the limit later closes
    // its reserved 19 (bar 130).
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: Date.UTC(2021, 0, 4) + i * 3_600_000,
      open: 100,
      high: i === 130 ? 101.5 : 100.5,
      low: i === 110 ? 98.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { js } = await runReal('strategies/tv-docs-strategies/16-reserved-exit-demo.pine', {
      bars: data,
    });
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(2);
    expect(s.closedTrades[0].qty).toBe(1); // the stop's unreserved share only
    expect(s.closedTrades[0].exitPrice).toBe(99);
    expect(s.closedTrades[0].exitBar).toBe(110);
    expect(s.closedTrades[1].qty).toBe(19); // the limit's reservation held
    expect(s.closedTrades[1].exitPrice).toBe(101);
    expect(s.closedTrades[1].exitBar).toBe(130);
    expect(js.ctx.strategy.position_size).toBe(0);
  });

  const TVD = 'strategies/tv-docs-strategies';
  const T0 = Date.UTC(2021, 0, 4);
  const H = 3_600_000;

  it('01 simple-strategy: MA-cross entries trade both directions (pinned to the standard feed)', async () => {
    const { c, js } = await runReal(`${TVD}/01-simple-strategy-demo.pine`);
    expect(c.metadata.title).toBe('Simple strategy demo');
    expect(js.strategy.closedTrades.length).toBe(17);
    expect(js.strategy.wins).toBe(17); // every reversal on this trending feed wins
    expect(js.strategy.netProfit).toBeCloseTo(67.8706, 3);
    expect(js.ctx.strategy.position_size).toBe(1);
  });

  it('05 limit-above: a buy limit ABOVE the close is already favorable → fills at the next bar open', async () => {
    // The docs contrast with 04: the closing price is already better than the
    // limit, so no resting — the order fills like a market order.
    const { js } = await runReal(`${TVD}/05-limit-order-above.pine`);
    expect(js.strategy.closedTrades.length).toBe(0);
    const st = js.ctx.strategy;
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(100); // signal bar 99 + 1
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(bars[100].open);
  });

  it('07 stop-limit: the stop arms a resting limit that fills on the retrace', async () => {
    // Flat at 100 → stop 108, limit = the signal bar low (99.5). A rise to 108.5
    // ARMS the limit (bar 127); the fall back to 99.5 fills it (bar 138).
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => {
      const px = i < 120 ? 100 : i <= 130 ? 100 + (i - 119) : Math.max(108 - (i - 130), 95);
      return { time: T0 + i * H, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 1 };
    });
    const { js } = await runReal(`${TVD}/07-stop-limit-order-demo.pine`, { bars: data });
    const st = js.ctx.strategy;
    expect(st.opentrades).toBe(1);
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(138);
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(99.5); // the LIMIT, not the stop
    // labels: gray + teal at the signal, green "Limit order activated" at arming
    expect(js.drawings.filter((d) => d.type === 'label').length).toBe(3);
  });

  it('08 bar-magnifier: limit entry + exit with an input threshold time (flag accepted)', async () => {
    // The script declares use_bar_magnifier = false, so default fill assumptions
    // apply. Entry limit 99 fills on the bar-110 down-bar; the exit limit (99.25)
    // gap-improves at the next bar recovering open (100).
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => {
      if (i === 110)
        return { time: T0 + i * H, open: 99.1, high: 99.2, low: 98.5, close: 99, volume: 1 };
      return { time: T0 + i * H, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 };
    });
    const { js } = await runReal(`${TVD}/08-bar-magnifier-demo.pine`, {
      bars: data,
      inputs: { 'Threshold time': T0 + 100 * H },
    });
    const t = js.strategy.closedTrades[0];
    expect(js.strategy.closedTrades.length).toBe(1);
    expect(t.entryBar).toBe(110);
    expect(t.entryPrice).toBe(99);
    expect(t.exitBar).toBe(111);
    expect(t.exitPrice).toBe(100); // better than the 99.25 limit → open fill
    expect(js.drawings.filter((d) => d.type === 'line').length).toBe(2);
  });

  it('11 pyramiding-enhanced: pyramiding = 4 admits four adds; a reversal closes every lot FIFO', async () => {
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => {
      const px = 100 + i;
      return { time: T0 + i * H, open: px, high: px + 2, low: px - 2, close: px + 0.5, volume: 1 };
    });
    const { js } = await runReal(`${TVD}/11-pyramiding-enhanced.pine`, { bars: data });
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(4); // all four short lots, closed by the bar-101 reversal
    const entryBars = [1, 26, 51, 76];
    s.closedTrades.forEach((t, k) => {
      expect(t.dir).toBe(-1);
      expect(t.entryBar).toBe(entryBars[k]);
      expect(t.exitBar).toBe(101);
    });
    expect(s.closedTrades.map((t) => t.profit)).toEqual([-100, -75, -50, -25]);
    expect(js.ctx.strategy.position_size).toBe(4); // long side rebuilt to the cap
  });

  it('19 different-ids: an id-less exit covers every entry in the position, whatever its id', async () => {
    // Same shape as 18, but each entry gets a unique generated id and the exit
    // call passes NO from_entry — both lots still close together at the level.
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: T0 + i * H,
      open: 100,
      high: i === 30 ? 101.5 : 100.5,
      low: i === 130 ? 98.5 : 99.5,
      close: 100,
      volume: 1,
    }));
    const { js } = await runReal(`${TVD}/19-exits-different-ids-demo.pine`, { bars: data });
    const s = js.strategy;
    expect(s.closedTrades.map((t) => t.entryId)).toEqual(['buy0', 'buy1', 'buy2', 'buy3']);
    expect(s.closedTrades.map((t) => t.exitBar)).toEqual([30, 30, 130, 130]);
    expect(s.closedTrades.map((t) => t.exitPrice)).toEqual([101, 101, 99, 99]);
  });

  it('20 exit-persist (no from_entry): guard errors on default inputs; scoping matches the from_entry variant', async () => {
    // (a) The script itself raises runtime.error when the time inputs are unset.
    await expect(runReal(`${TVD}/20-exit-persist-without-from-entry.pine`)).rejects.toThrow(
      /input timestamps/,
    );
    // (b) With proper inputs, the id-less exit call still covers only entries
    // created before/on its bar — same numbers as the from_entry variant (21).
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => {
      const px = i === 100 ? 50 : 100 + i;
      return { time: T0 + i * H, open: px, high: px + 1, low: px, close: px + 1, volume: 1 };
    });
    const { js } = await runReal(`${TVD}/20-exit-persist-without-from-entry.pine`, {
      bars: data,
      inputs: {
        'Start time for entries': T0 + 10 * H,
        'Exit call time': T0 + 20 * H,
        'End time for entries': T0 + 40 * H,
      },
    });
    expect(js.strategy.closedTrades.length).toBe(11);
    expect(js.ctx.strategy.position_size).toBe(19);
  });

  it('22 close-demo: buy every 50 bars, close every 25th between — four clean cycles', async () => {
    const { js } = await runReal(`${TVD}/22-close-demo.pine`);
    const s = js.strategy;
    expect(s.closedTrades.map((t) => [t.entryBar, t.exitBar])).toEqual([
      [1, 26],
      [51, 76],
      [101, 126],
      [151, 176],
    ]);
    for (const t of s.closedTrades) {
      expect(t.entryPrice).toBe(bars[t.entryBar].open);
      expect(t.exitPrice).toBe(bars[t.exitBar].open);
    }
    expect(js.strategy.netProfit).toBeCloseTo(36.1306, 3);
  });

  it('23 + 24 cancel demos: a canceled resting limit never fills, even when price later dips through it', async () => {
    const data: Bar[] = Array.from({ length: 200 }, (_, i) => ({
      time: T0 + i * H,
      open: 100,
      high: 100.5,
      low: i === 150 ? 90 : 99.5,
      close: 100,
      volume: 1,
    }));
    for (const f of [`${TVD}/23-cancel-demo.pine`, `${TVD}/24-cancel-all.pine`]) {
      const { js } = await runReal(f, { bars: data });
      expect(js.strategy.closedTrades.length).toBe(0);
      expect(js.ctx.strategy.position_size).toBe(0);
    }
  });

  it('25 close-all fixture ("Multiple close demo"): close(id) exits every lot under the id in one fill', async () => {
    const { js } = await runReal(`${TVD}/25-close-all.pine`);
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(3);
    const entryBars = [26, 51, 76];
    s.closedTrades.forEach((t, k) => {
      expect(t.entryBar).toBe(entryBars[k]); // FIFO rows, each at its own entry price
      expect(t.entryPrice).toBe(bars[entryBars[k]].open);
      expect(t.exitBar).toBe(101);
      expect(t.exitPrice).toBe(bars[101].open);
    });
    expect(js.ctx.strategy.position_size).toBe(3); // second cycle's stack, still open
  });

  it('26 close-multiple-id: the A/B/C/close_all state machine cycles every four bars', async () => {
    const { js } = await runReal(`${TVD}/26-close-multiple-id-demo.pine`);
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(147); // 49 cycles × 3 lots
    expect(s.closedTrades.slice(0, 3).map((t) => [t.entryId, t.entryBar, t.exitBar])).toEqual([
      ['A', 1, 4],
      ['B', 2, 4],
      ['C', 3, 4],
    ]);
    expect(js.ctx.strategy.position_size).toBe(3); // mid-cycle at the feed's end
  });

  it('27 cancel-market: cancel_all cannot cancel a market order — it fills regardless', async () => {
    const { js } = await runReal(`${TVD}/27-cancel-market-demo.pine`);
    expect(js.strategy.closedTrades.length).toBe(0);
    const st = js.ctx.strategy;
    expect(st.position_size).toBe(1); // the "canceled" order filled anyway
    expect(st.tradeField('opentrades', 'entry_bar_index', 0)).toBe(100);
    expect(st.tradeField('opentrades', 'entry_price', 0)).toBe(bars[100].open);
  });

  it('28 + 29 buy-low-sell-high: explicit qty vs na-qty falling back to cash sizing', async () => {
    // 28: qty comes from the inputs (2 contracts short on this feed).
    const { js: a } = await runReal(`${TVD}/28-buy-low-sell-high.pine`);
    expect(a.ctx.strategy.position_size).toBe(-2);
    expect(a.strategy.closedTrades.length).toBe(0);
    // 29: zero inputs pass qty = na → default_qty_type = strategy.cash (5000) sizing.
    const { js: b } = await runReal(`${TVD}/29-buy-low-sell-high-guarded.pine`);
    const qty = b.ctx.strategy.tradeField('opentrades', 'size', 0) as number;
    const px = b.ctx.strategy.tradeField('opentrades', 'entry_price', 0) as number;
    expect(Math.abs(qty * px)).toBeCloseTo(5000, 6);
  });

  it('30 vs 31 exit demos: a shared bracket exits both lots; split close+bracket manage them separately', async () => {
    // Micro-range flat feed (±2 ticks, inside the ±10-tick brackets) with one
    // spike at bar 8 that touches the +10-tick profit levels.
    const data: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      time: T0 + i * H,
      open: 100,
      high: i === 8 ? 100.2 : 100.02,
      low: 99.98,
      close: 100,
      volume: 1,
    }));
    // 30: one id-less bracket covers Buy1 AND Buy2 → both exit at their +10-tick
    // levels on the spike; the strategy then rebuilds to the cap.
    const { js: a } = await runReal(`${TVD}/30-exit-demo-shared-bracket.pine`, { bars: data });
    expect(a.strategy.closedTrades.map((t) => [t.entryId, t.qty, t.exitBar, t.exitPrice])).toEqual([
      ['Buy1', 5, 8, 100.1],
      ['Buy2', 10, 8, 100.1],
    ]);
    expect(a.ctx.strategy.position_size).toBe(15);
    // 31: close("Buy2") is a market order (fills at the next open, profit 0) and
    // pyramiding capacity FREES on each close, so Buy2 re-adds and re-closes every
    // two bars until the spike exits Buy1 via its bracket.
    const { js: b } = await runReal(`${TVD}/31-exit-demo-split-brackets.pine`, { bars: data });
    expect(b.strategy.closedTrades.map((t) => [t.entryId, t.qty, t.entryBar, t.exitBar])).toEqual([
      ['Buy2', 10, 2, 3],
      ['Buy2', 10, 4, 5],
      ['Buy2', 10, 6, 7],
      ['Buy1', 5, 1, 8],
    ]);
    for (const t of b.strategy.closedTrades.slice(0, 3)) expect(t.exitPrice).toBe(100); // market opens
    expect(b.strategy.closedTrades[3].exitPrice).toBe(100.1); // the bracket level
    expect(b.ctx.strategy.position_size).toBe(10);
  });

  it('32 + 33 OCA cancel demos: DEVIATION — oca groups are not enforced, both variants behave identically', async () => {
    // TV cancels the sibling stop order when one of an oca.cancel pair fills; piner
    // accepts the oca_* args but does not enforce grouping (documented deviation),
    // so 33 currently reproduces 32's fills exactly. If OCA lands, split this pin.
    const { js: a } = await runReal(`${TVD}/32-oca-cancel-demo.pine`);
    const { js: b } = await runReal(`${TVD}/33-oca-cancel-demo-with-oca.pine`);
    expect(a.strategy.closedTrades.length).toBe(14);
    expect(JSON.stringify(a.strategy)).toBe(JSON.stringify(b.strategy));
    expect(a.strategy.netProfit).toBeCloseTo(-89.054, 3);
  });

  it('34 + 35 multiple-TP demos: DEVIATION — oca.reduce is not modeled; 35 oversells where TV nets flat', async () => {
    // Without OCA (34) TV itself ends short 6 (the demo point). With oca.reduce
    // (35) TV reduces sibling orders as fills happen and ends flat; piner fills
    // them at full size → short 9. Split this pin when OCA lands.
    const { js: a } = await runReal(`${TVD}/34-multiple-tp-demo.pine`);
    expect(a.ctx.strategy.position_size).toBe(-6);
    const { js: b } = await runReal(`${TVD}/35-multiple-tp-demo-oca-reduce.pine`);
    expect(b.ctx.strategy.position_size).toBe(-9);
  });

  it('36 currency-test: single-currency identity — conversions pass through, rate requests are na', async () => {
    const { js } = await runReal(`${TVD}/36-currency-test.pine`);
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(199);
    expect([s.wins, s.losses]).toEqual([99, 100]);
    expect(s.netProfit).toBeCloseTo(-1, 6); // ±1 point per trade nets to −1
    // request.currency_rate has no feed → the rate plot stays na
    const rate = js.outputs.plots.get(1)!.data;
    expect(rate.every((v: number) => Number.isNaN(v))).toBe(true);
  });

  it('37 donchian (calc_on_every_tick): historical bars behave identically to the default model', async () => {
    // calc_on_every_tick only changes REALTIME behavior on TV too — historical
    // bars calculate on close either way, so this pin is TV-consistent.
    const { js } = await runReal(`${TVD}/37-donchian-channel-break.pine`);
    expect(js.strategy.closedTrades.length).toBe(54);
    expect(js.ctx.strategy.position_size).toBe(4);
    expect(js.strategy.netProfit).toBeCloseTo(-819.4135, 3);
  });

  it('38 + 39 calc_on_order_fills: DEVIATION — the flag is ignored (no intrabar recalculation)', async () => {
    // TV recalculates after each fill even on historical bars, producing extra
    // same-bar orders; piner runs the default once-per-bar model.
    const { js: a } = await runReal(`${TVD}/38-intrabar-exit.pine`);
    expect(a.strategy.closedTrades.length).toBe(55);
    const { js: b } = await runReal(`${TVD}/39-buy-on-every-fill.pine`);
    expect(b.strategy.closedTrades.length).toBe(0);
    expect(b.ctx.strategy.position_size).toBe(25); // one fill per bar over the last 26 signals
  });

  it('40 + 41 commission demos: commission drags netProfit and is reported as totalCommission', async () => {
    const { js: a } = await runReal(`${TVD}/40-commission-demo.pine`);
    const { js: b } = await runReal(`${TVD}/41-commission-demo-with-commission.pine`);
    expect(a.strategy.closedTrades.length).toBe(10);
    expect(b.strategy.closedTrades.length).toBe(10);
    expect(a.strategy.totalCommission).toBe(0);
    expect(b.strategy.totalCommission).toBeGreaterThan(0);
    expect(b.strategy.netProfit).toBeLessThan(a.strategy.netProfit);
  });

  it('42 slippage: every fill lands exactly 20 ticks against the taker', async () => {
    const { js } = await runReal(`${TVD}/42-slippage-demo.pine`);
    const s = js.strategy;
    expect(s.closedTrades.length).toBe(11);
    for (const t of s.closedTrades) {
      expect(t.entryPrice).toBeCloseTo(bars[t.entryBar].open + 0.2, 9); // buy: worse (higher)
      expect(t.exitPrice).toBeCloseTo(bars[t.exitBar].open - 0.2, 9); // sell: worse (lower)
    }
  });

  it('43 verify-price-for-limits: the limit entry rests at hlcc4 and the level line tracks it', async () => {
    const { js } = await runReal(`${TVD}/43-verify-price-for-limits.pine`);
    expect(js.strategy.closedTrades.length).toBe(0);
    expect(js.ctx.strategy.opentrades).toBe(1); // filled and held on this feed
    expect(js.drawings.filter((d) => d.type === 'line').length).toBeGreaterThanOrEqual(1);
  });

  it('44 + 45 information demos: dashboards render from live stats on an oscillating feed', async () => {
    const wave: Bar[] = Array.from({ length: 300 }, (_, i) => {
      const p = 100 + 20 * Math.sin(i / 8);
      return {
        time: T0 + i * H,
        open: p,
        high: p + 1.5,
        low: p - 1.5,
        close: p + Math.sin(i / 3),
        volume: 1000,
      };
    });
    const { js: a } = await runReal(`${TVD}/44-strategy-information-dashboard.pine`, {
      bars: wave,
    });
    expect(a.strategy.closedTrades.length).toBe(4);
    expect(a.strategy.wins).toBe(4);
    expect(a.drawings.filter((d) => d.type === 'table').length).toBe(1);
    const { js: b } = await runReal(`${TVD}/45-individual-trade-information.pine`, { bars: wave });
    expect(b.strategy.closedTrades.length).toBe(5);
    expect(b.ctx.strategy.position_size).toBe(0);
    expect(b.drawings.filter((d) => d.type === 'table').length).toBe(1);
  });

  it('46 alert-message: the @strategy_alert_message annotation is inert; the MA-cross strategy runs', async () => {
    const { js } = await runReal(`${TVD}/46-alert-message-demo.pine`);
    expect(js.strategy.closedTrades.length).toBe(19);
    expect(js.ctx.strategy.position_size).toBe(-1);
    expect(js.strategy.netProfit).toBeCloseTo(-146.3366, 3);
  });

  it('SMC Structure + FVG: trades both sides through the reworked broker (POC, % equity, commission)', async () => {
    // End-to-end exercise of the broker rework on a realistic strategy:
    // percent_of_equity sizing, percent commission, process_orders_on_close,
    // and stop+limit exit brackets keyed by from_entry. runReal asserts
    // byte-for-byte plot/drawing/strategy-report parity across backends.
    const data = smcBars(700, 37);
    const { c, js } = await runReal('strategies/smc-structure.pine', { bars: data });
    expect(c.metadata.title).toBe('SMC — Structure + FVG');
    expect(c.metadata.isStrategy).toBe(true);
    const s = js.strategy;
    // Pinned to the seeded series — a change here means broker semantics moved.
    expect(s.closedTrades.length).toBe(6);
    expect(s.closedTrades.filter((t) => t.dir > 0).length).toBe(3);
    expect(s.closedTrades.filter((t) => t.dir < 0).length).toBe(3);
    expect(s.wins).toBeGreaterThan(0);
    expect(s.losses).toBeGreaterThan(0);
    for (const t of s.closedTrades) {
      // process_orders_on_close: every (market) entry fills at ITS OWN bar's close.
      expect(t.entryPrice).toBe(data[t.entryBar].close);
      // percent-of-equity sizing → fractional, price-dependent quantities (not the fixed default 1)
      expect(t.qty).toBeGreaterThan(0);
      expect(t.qty).not.toBe(1);
      // 0.04% commission on both sides is netted into the trade's profit
      const raw = t.dir * (t.exitPrice - t.entryPrice) * t.qty;
      expect(t.profit).toBeLessThan(raw);
      expect(raw - t.profit).toBeCloseTo((0.04 / 100) * t.qty * (t.entryPrice + t.exitPrice), 6);
    }
    // exits come from the stop/limit bracket, not market closes
    expect(js.outputs.plots.size).toBeGreaterThanOrEqual(3); // swing/eq level plots
  });

  it('RSI DCA (3Commas): the averaging-down ladder fills as price slides, one TP closes the stack', async () => {
    // A hand-authored long-only DCA strategy: RSI(14) < 28 arms a base order, then
    // five safety orders fire at FIXED −2/−5/−9.5/−16/−25% deviations from the base
    // entry (USDT sizes scaling ~1.8x per rung) and a single +3% take-profit closes
    // the whole stack. Feed: a deterministic ~35% slide over the first 60 bars —
    // walking price down the whole AO ladder — then a recovery through the TP.
    // The RSI timeframe input is forced to the chart's so request.security is an
    // identity pass-through, and the strategy's 2024→2026 date filter is disabled so
    // the 2021 feed trades. runReal asserts byte-for-byte plot/drawing/report parity.
    const data: Bar[] = [];
    let px = 100;
    for (let i = 0; i < 140; i++) {
      px = Math.max(20, px + (i < 60 ? -0.9 : 1.1) + Math.sin(i / 4) * 0.6);
      data.push({
        time: Date.UTC(2021, 0, 4) + i * 3_600_000,
        open: px,
        high: px + 0.8,
        low: px - 0.8,
        close: px,
        volume: 1000,
      });
    }
    const { c, js } = await runReal('strategies/rsi-dca.pine', {
      bars: data,
      inputs: { 'RSI Timeframe': '60', 'Limit Backtest Period': false },
    });
    expect(c.metadata.title).toBe('GRAM RSI Strategy [3Commas]');
    expect(c.metadata.isStrategy).toBe(true);
    const s = js.strategy;
    // base order + all five averaging orders fill, in ladder order, all long
    expect(s.closedTrades.map((t) => t.entryId)).toEqual([
      'Long_Base',
      'Long_AO_1',
      'Long_AO_2',
      'Long_AO_3',
      'Long_AO_4',
      'Long_AO_5',
    ]);
    expect(s.closedTrades.every((t) => t.dir > 0)).toBe(true);
    // the martingale ladder: each rung steps DOWN in price and UP in quantity
    const eps = s.closedTrades.map((t) => t.entryPrice);
    const qty = s.closedTrades.map((t) => t.qty);
    expect(eps.every((p, i) => i === 0 || p < eps[i - 1])).toBe(true);
    expect(qty.every((q, i) => i === 0 || q > qty[i - 1])).toBe(true);
    // process_orders_on_close + 3-tick slippage: every market entry fills at ITS
    // bar's close, nudged adverse (higher for a long) by slippage × mintick (3 × 0.01)
    for (const t of s.closedTrades) {
      expect(t.entryPrice).toBeCloseTo(data[t.entryBar].close + 0.03, 10);
    }
    // one +3% take-profit closes the ENTIRE stack on a single bar at one price
    expect(new Set(s.closedTrades.map((t) => t.exitBar)).size).toBe(1);
    expect(new Set(s.closedTrades.map((t) => t.exitPrice)).size).toBe(1);
    expect(s.closedTrades[0].exitBar).toBe(84);
    expect(js.ctx.strategy.position_size).toBe(0); // flat after the TP
    // net winner: the deep AOs (bought cheap) more than pay for the early lots
    expect(s.netProfit).toBeCloseTo(1019.8378, 3);
    // 7 webhook alerts: base entry + 5 add-funds + 1 close
    expect(js.outputs.alerts.length).toBe(7);
    // avg-entry + TP level plots; status + watermark tables; one entry label
    // (the AO ladder viz needs an open position on the last bar — flat here → none)
    expect(js.outputs.plots.size).toBe(2);
    expect(js.drawings.filter((d) => d.type === 'table').length).toBe(2);
    expect(js.drawings.filter((d) => d.type === 'label').length).toBe(1);
  });
});
