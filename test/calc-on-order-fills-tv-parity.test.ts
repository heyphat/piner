import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// calc_on_order_fills — TV GROUND-TRUTH PARITY (dev-docs/calc-parity-findings.md)
//
// Replays the time-anchored probe (calc-on-order-fills-probe-v2.pine) over a
// snapshot of the exact BINANCE:XAUUSDT.P 1h bars it ran on at TradingView,
// and asserts the engine's trade ledger matches TV's exported List of Trades
// FILL-FOR-FILL: 55 trades — side, entry/exit price, entry/exit bar time.
// This is the empirical pin of the path-point model (A/W/E1/E2; close is not
// a fill point; discrete-at-next-point then continuous).
// ═══════════════════════════════════════════════════════════════════════════

const HERE = join(dirname(fileURLToPath(import.meta.url)), 'pinescripts', 'strategies');

interface TvTrade {
  side: 'long' | 'short';
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
}

/** Parse TV's "List of Trades" export (one Entry + one Exit row per trade). */
function parseTvCsv(file: string): TvTrade[] {
  const lines = readFileSync(join(HERE, file), 'utf8').replace(/^﻿/, '').trim().split('\n');
  const acc = new Map<number, Partial<TvTrade>>();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const m = c[1].match(/^(Entry|Exit) (long|short)$/);
    if (!m) throw new Error(`unrecognized row type: ${c[1]}`);
    const t = acc.get(Number(c[0])) ?? {};
    if (m[1] === 'Entry') {
      t.side = m[2] as 'long' | 'short';
      t.entryTime = c[2];
      t.entryPrice = Number(c[4]);
    } else {
      t.exitTime = c[2];
      t.exitPrice = Number(c[4]);
    }
    acc.set(Number(c[0]), t);
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t as TvTrade);
}

const fmtUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

describe('calc_on_order_fills — TV ground-truth parity (XAUUSDT.P 1h)', () => {
  it('reproduces the TV List of Trades fill-for-fill (55/55)', async () => {
    const tv = parseTvCsv('calc-on-order-fills-XAUUSDT-1h.csv');
    expect(tv.length).toBe(55);

    const bars: Bar[] = JSON.parse(
      readFileSync(join(HERE, 'calc-on-order-fills-xau-1h-bars.json'), 'utf8'),
    ).map((b: Bar) => ({ ...b, time: b.time * 1000 })); // pinery seconds → engine ms
    const src = readFileSync(join(HERE, 'calc-on-order-fills-probe-v2.pine'), 'utf8');
    const c = compile(src);
    const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
    const run = { symbol: 'XAUUSDT.P', timeframe: '60', mintick: 0.01 };
    await js.run(run);
    await ip.run(run);
    expect(JSON.stringify(ip.strategy)).toBe(JSON.stringify(js.strategy)); // two-backend invariant

    const got = js.strategy.closedTrades;
    expect(got.length).toBe(55);
    expect(js.ctx.strategy.position_size).toBe(0);
    for (let i = 0; i < tv.length; i++) {
      const want = tv[i];
      const t = got[i];
      const label = `trade #${i + 1}`;
      expect(`${label} ${t.dir > 0 ? 'long' : 'short'}`).toBe(`${label} ${want.side}`);
      expect(t.entryPrice).toBeCloseTo(want.entryPrice, 6);
      expect(t.exitPrice).toBeCloseTo(want.exitPrice, 6);
      expect(`${label} in ${fmtUtc(t.entryTime)}`).toBe(`${label} in ${want.entryTime}`);
      expect(`${label} out ${fmtUtc(t.exitTime)}`).toBe(`${label} out ${want.exitTime}`);
    }
  });
});
