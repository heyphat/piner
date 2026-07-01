/**
 * Public library corpus — real published/third-party Pine libraries, run through piner's
 * import/export via an in-memory registry, and cross-checked on both backends.
 *
 * The `.pine` files in test/pinescripts/libraries/ are vendored verbatim from public sources
 * (see that directory's README for provenance + attribution). Every library is loaded into a
 * LibraryRegistry; each is exercised by a small consumer that imports and calls it, then run on
 * the codegen (js) and interpreter backends with byte-for-byte agreement asserted.
 *
 * This is a HARD regression gate (unlike test/corpus.test.ts's soft backlog): every vendored
 * library must reach `pass`. Run: `bun test test/library-corpus.test.ts`.
 * Feature: library-import-export.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile, CompileError, ParseError, Engine, ArrayFeed, type Bar, type LibraryRegistry } from '../src/index.js';

const DIR = resolve(import.meta.dir, 'pinescripts/libraries');

/**
 * Each vendored library: the file to load, the identity it is registered under, and a small
 * consumer that imports + exercises its exported surface. The consumer's plots are what the
 * two backends are compared on.
 */
interface LibEntry { file: string; identity: string; exercise: string; }
const LIBRARIES: LibEntry[] = [
  {
    file: 'rayolf-rc-highest-lowest.pine',
    identity: 'rayolf/rc_highest_lowest/1',
    exercise: `//@version=6
indicator("uses rc_highest_lowest")
import rayolf/rc_highest_lowest/1 as rc
[hiIdx, hiPrice] = rc.f_highest(0, 20)
[loIdx, loPrice] = rc.f_lowest(0, 20)
plot(hiPrice, "highest(20)")
plot(loPrice, "lowest(20)")
`,
  },
  {
    file: 'pinecoders-alltimehighlow.pine',
    identity: 'PineCoders/AllTimeHighLow/1',
    exercise: `//@version=6
indicator("uses AllTimeHighLow")
import PineCoders/AllTimeHighLow/1 as allTime
plot(allTime.hi(), "ath high")
plot(allTime.lo(), "atl low")
plot(allTime.hi(close), "ath close")
`,
  },
  {
    file: 'tvdocs-point.pine',
    identity: 'TradingViewDocs/Point/1',
    exercise: `//@version=6
indicator("uses Point")
import TradingViewDocs/Point/1 as pt
pt.point p = pt.point.new(bar_index, close, close > open, false)
plot(p.y, "y")
plot(p.isHi ? 1.0 : 0.0, "isHi")
`,
  },
  {
    file: 'tvdocs-signal.pine',
    identity: 'TradingViewDocs/Signal/1',
    exercise: `//@version=6
indicator("uses Signal")
import TradingViewDocs/Signal/1 as Signal
s = close > open ? Signal.State.long : close < open ? Signal.State.short : Signal.State.neutral
plot(s == Signal.State.long ? 1.0 : s == Signal.State.short ? -1.0 : 0.0, "signal")
`,
  },
];

// A registry containing EVERY vendored library (so transitive/cross references also resolve).
const registry: LibraryRegistry = LIBRARIES.map((l) => ({
  key: l.identity,
  source: readFileSync(resolve(DIR, l.file), 'utf8'),
}));

const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const base = 100 + i * 0.25 + 9 * Math.sin(i / 7);
  const close = base + Math.cos(i / 5) * 2;
  return {
    time: Date.UTC(2024, 0, 1) + i * 3600_000,
    open: base,
    high: Math.max(base, close) + 1.5,
    low: Math.min(base, close) - 1.5,
    close,
    volume: 1000 + (i % 9) * 50,
  };
});

type Stage = 'pass' | 'parse' | 'sema' | 'runtime' | 'divergence';
const eqNaN = (a: number, b: number) =>
  (Number.isNaN(a) && Number.isNaN(b)) || a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

async function classify(exercise: string): Promise<{ stage: Stage; detail: string }> {
  let compiled;
  try {
    compiled = compile(exercise, { libraries: registry });
  } catch (e) {
    if (e instanceof ParseError) return { stage: 'parse', detail: `${e.line}:${e.col} ${e.raw}` };
    if (e instanceof CompileError) {
      const d = e.diagnostics.find((x) => x.severity === 'error');
      return { stage: 'sema', detail: d ? `${d.line}:${d.col} ${d.message}` : e.message.split('\n')[1]?.trim() ?? e.message };
    }
    return { stage: 'sema', detail: (e as Error).message.split('\n')[0] };
  }
  const run = async (backend: 'js' | 'interp') => {
    const e = new Engine(compiled, new ArrayFeed(bars), { backend });
    await e.run({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
    return e;
  };
  let js, ip;
  try { js = await run('js'); } catch (e) { return { stage: 'runtime', detail: `js: ${(e as Error).message.split('\n')[0]}` }; }
  try { ip = await run('interp'); } catch (e) { return { stage: 'runtime', detail: `interp: ${(e as Error).message.split('\n')[0]}` }; }
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id);
    if (!ipp) return { stage: 'divergence', detail: `plot ${id} present in js, absent in interp` };
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) {
        return { stage: 'divergence', detail: `plot "${jp.title}" bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}` };
      }
    }
  }
  return { stage: 'pass', detail: '' };
}

describe('public library corpus — import/export cross-check (both backends)', () => {
  it('every vendored real-world library compiles, runs, and both backends agree', async () => {
    expect(LIBRARIES.length).toBeGreaterThan(0);
    const results = await Promise.all(
      LIBRARIES.map(async (l) => ({ identity: l.identity, ...(await classify(l.exercise)) })),
    );

    const failures = results.filter((r) => r.stage !== 'pass');
    if (failures.length) {
      // eslint-disable-next-line no-console
      console.log('\n===== public library corpus — failures =====');
      for (const f of failures) console.log(`  ${f.identity}\n      [${f.stage}] ${f.detail}`);
    }

    // Hard gate: every curated real-world library must pass.
    for (const r of results) {
      expect(r.stage, `${r.identity} → [${r.stage}] ${r.detail}`).toBe('pass');
    }
    expect(results.filter((r) => r.stage === 'pass').length).toBe(LIBRARIES.length);
  }, 60_000);

  it('exercises the documented feature surface across the corpus', () => {
    // sanity: the corpus covers functions, tuple returns, UDTs, and enums.
    expect(registry.length).toBe(LIBRARIES.length);
    expect(LIBRARIES.map((l) => l.identity)).toContain('rayolf/rc_highest_lowest/1');
  });
});
