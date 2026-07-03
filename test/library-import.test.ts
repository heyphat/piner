/**
 * Library import/export — core behavior + two-backend cross-check.
 * Feature: library-import-export.
 */
import { describe, it, expect } from 'bun:test';
import {
  compile,
  Engine,
  ArrayFeed,
  type Bar,
  type CompiledScript,
  type LibraryRegistry,
} from '../src/index.js';

// ── deterministic bar series ────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeBars(n: number, seed = 3): Bar[] {
  const r = mulberry32(seed);
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = Math.max(1, price + (r() - 0.5) * 6);
    const open = price + (r() - 0.5) * 2;
    const close = price + (r() - 0.5) * 2;
    const high = Math.max(open, close) + r() * 2;
    const low = Math.min(open, close) - r() * 2;
    bars.push({ time: i * 60000, open, high, low, close, volume: Math.floor(r() * 5000) });
  }
  return bars;
}

const eqNaN = (a: unknown, b: unknown) =>
  (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) || a === b;

/** Run both backends historically (+ optional realtime ticks); assert identical plot outputs. */
async function crossCheck(c: CompiledScript, bars: Bar[], ticks: [Bar, boolean][] = []) {
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [bar, close] of ticks) {
    js.tick(bar, close);
    ip.tick(bar, close);
  }

  expect([...ip.outputs.plots.keys()].sort()).toEqual([...js.outputs.plots.keys()].sort());
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    expect(jp.data.length).toBe(ipp.data.length);
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) {
        throw new Error(
          `plot ${id} '${jp.title}' diverged at bar ${i}: js=${jp.data[i]} interp=${ipp.data[i]}`,
        );
      }
    }
  }
  return js;
}

const bars = makeBars(60, 11);

describe('library import/export — resolution + execution', () => {
  it('resolves and calls an imported function; both backends agree', async () => {
    const registry: LibraryRegistry = [
      {
        key: 'alice/mathlib/1',
        source: `//@version=6
library("MathLib")
export dbl(float x) => x * 2.0
export addn(float x, float n) => x + n
`,
      },
    ];
    const c = compile(
      `//@version=6
indicator("consumer")
import alice/mathlib/1 as ml
plot(ml.dbl(close), title="d")
plot(ml.addn(close, 5.0), title="a")
`,
      { libraries: registry },
    );
    const js = await crossCheck(c, bars);
    // dbl(close) == close*2 on the last bar
    const last = bars.length - 1;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(bars[last].close * 2, 9);
    expect(js.outputs.plots.get(1)!.data[last]).toBeCloseTo(bars[last].close + 5, 9);
  });

  it('imported function is byte-for-byte identical to the same function declared locally', async () => {
    const registry: LibraryRegistry = [
      {
        key: 'u/ind/1',
        source: `//@version=6
library("Ind")
export smadiff(float src, int len) => ta.sma(src, len) - ta.ema(src, len)
`,
      },
    ];
    const imported = compile(
      `//@version=6
indicator("imp")
import u/ind/1 as lib
plot(lib.smadiff(close, 10), title="v")
`,
      { libraries: registry },
    );
    const local = compile(`//@version=6
indicator("loc")
smadiff(float src, int len) => ta.sma(src, len) - ta.ema(src, len)
plot(smadiff(close, 10), title="v")
`);
    const ei = new Engine(imported, new ArrayFeed(bars), { backend: 'js' });
    const el = new Engine(local, new ArrayFeed(bars), { backend: 'js' });
    await ei.run({ symbol: 'T', timeframe: '1' });
    await el.run({ symbol: 'T', timeframe: '1' });
    const di = ei.outputs.plots.get(0)!.data;
    const dl = el.outputs.plots.get(0)!.data;
    expect(di.length).toBe(dl.length);
    for (let i = 0; i < di.length; i++) expect(eqNaN(di[i], dl[i])).toBe(true);
    // and the imported variant cross-checks between its own backends
    await crossCheck(imported, bars);
  });

  it('omitted alias defaults to the lib component', async () => {
    const registry: LibraryRegistry = [
      {
        key: 'u/helper/1',
        source: `//@version=6
library("Helper")
export triple(float x) => x * 3.0
`,
      },
    ];
    const c = compile(
      `//@version=6
indicator("c")
import u/helper/1
plot(helper.triple(close))
`,
      { libraries: registry },
    );
    const js = await crossCheck(c, bars);
    const last = bars.length - 1;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(bars[last].close * 3, 9);
  });
});

describe('library import/export — backward compatibility (Req 2.4)', () => {
  const src = `//@version=6
indicator("plain")
plot(ta.sma(close, 5), title="s")
`;
  it('compile(src), compile(src, {}), compile(src, {libraries: []}) are identical for import-free scripts', () => {
    const a = compile(src);
    const b = compile(src, {});
    const d = compile(src, { libraries: [] });
    expect(b.source).toBe(a.source);
    expect(d.source).toBe(a.source);
    expect(JSON.stringify(b.metadata)).toBe(JSON.stringify(a.metadata));
    expect(JSON.stringify(d.metadata)).toBe(JSON.stringify(a.metadata));
  });
});
