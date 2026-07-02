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
function runReal(file: string, opts: { bars?: Bar[]; inputs?: Record<string, unknown>; libraries?: LibraryRegistry } = {}) {
  const data = opts.bars ?? bars;
  const src = readFileSync(join(HERE, 'pinescripts', file), 'utf8');
  const c = compile(src, opts.libraries ? { libraries: opts.libraries } : undefined);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  const run = { symbol: 'BTCUSD', timeframe: '60', inputs: opts.inputs };
  return Promise.all([js.run(run), ip.run(run)]).then(() => {
    for (const [id, jp] of js.outputs.plots) {
      const ipp = ip.outputs.plots.get(id)!;
      expect(ipp).toBeDefined();
      expect(jp.data.length).toBe(ipp.data.length);
      for (let i = 0; i < jp.data.length; i++) {
        if (!eqNaN(jp.data[i], ipp.data[i])) {
          throw new Error(`backend divergence in plot ${id} ("${jp.title}") at bar ${i}: js=${jp.data[i]} interp=${ipp.data[i]}`);
        }
      }
    }
    if (JSON.stringify(js.drawings) !== JSON.stringify(ip.drawings)) {
      throw new Error(`backend divergence in drawings (${js.drawings.length} js vs ${ip.drawings.length} interp)`);
    }
    if (c.metadata.isStrategy && JSON.stringify(js.strategy) !== JSON.stringify(ip.strategy)) {
      throw new Error(`backend divergence in the strategy report (${js.strategy.closedTrades.length} js vs ${ip.strategy.closedTrades.length} interp trades)`);
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
      return { time: Date.UTC(2021, 0, 4) + i * 3_600_000, open: p, high: p + 3, low: p + 0.5, close: p + 2.5, volume: 1000 + (i % 11) * 120 };
    });
    const { c, js } = await runReal('fvg.pine', { bars: trend, inputs: { 'Filter by ATR': false } });
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
    const zigzag: LibraryRegistry = [{
      key: 'TradingView/ZigZag/7',
      source: readFileSync(join(HERE, 'pinescripts/libraries/tradingview-zigzag-7.pine'), 'utf8'),
    }];
    const { c, js } = await runReal('auto-pitchfork.pine', { libraries: zigzag });
    expect(c.metadata.title).toBe('Auto Pitchfork');
    const byType = drawCounts(js);
    expect(byType.line).toBeGreaterThan(0);     // median + tines
    expect(byType.linefill).toBeGreaterThan(0); // level bands
  });
});

function drawCounts(eng: Engine): Record<string, number> {
  const pool = (eng as unknown as { ctx: { drawPool: { objects: Map<number, { type: string }> } } }).ctx.drawPool;
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
      out.push({ time: start + i * 3_600_000, open, close,
        high: Math.max(open, close) + wickU, low: Math.min(open, close) - wickD,
        volume: 1000 + Math.floor(rnd() * 900) });
      px = close;
    }
    return out;
  }

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
});
