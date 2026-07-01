/**
 * Async / lazy library import/export — `compileAsync` + `resolveLibrary` (Phase 2).
 *
 * The core `compile()` is synchronous and resolves imports from an in-memory registry.
 * When library sources live behind async I/O (an HTTP CDN, a database) or in a large
 * on-disk tree you don't want to eagerly scan, `compileAsync(src, { resolveLibrary })`
 * walks the import graph and fetches ONLY the libraries actually imported (transitively),
 * then hands them to the pure `compile()`.
 *
 *     import { compileAsync, fsLibrarySource } from '@heyphat/piner/node';
 *
 * This in-repo example imports from source so it runs as-is:
 *
 *     bun run examples/library-import-async.ts
 */
import { join } from 'node:path';
import { compileAsync, fsLibrarySource, Engine, ArrayFeed, type Bar, type LibraryIdentity } from '../src/node.js';

function makeBars(count: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 9) * 2.5 + Math.cos(i / 23) * 1.2;
    const close = price + drift;
    bars.push({ time: Date.UTC(2024, 0, 1) + i * 60_000, open: price, high: Math.max(price, close) + 0.8, low: Math.min(price, close) - 0.8, close, volume: 1000 });
    price = close;
  }
  return bars;
}
const bars = makeBars(200);

async function runBoth(compiled: Awaited<ReturnType<typeof compileAsync>>, label: string) {
  const js = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(compiled, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  let diverged = 0;
  for (const [id, p] of js.outputs.plots) {
    const o = ip.outputs.plots.get(id)!.data;
    for (let i = 0; i < p.data.length; i++) {
      const a = p.data[i], b = o[i];
      if (!((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9)) diverged++;
    }
  }
  console.log(`${label}: ${diverged === 0 ? 'both backends IDENTICAL ✓' : `${diverged} divergences ✗`}, last z-score = ${js.outputs.plots.get(0)!.data.at(-1)?.toFixed(3)}`);
}

const consumer = `//@version=6
indicator("async import demo")
import alice/mathx/1 as mx
import alice/bands/1 as bands
plot(mx.zscore(close, 20), "z")
plot(bands.compute(close, 20, 2.0).upper, "upper")
`;

// ── A) A simulated remote registry (think: an HTTP CDN) reached via an async provider ──
const REMOTE: Record<string, string> = {
  'alice/mathx/1': `//@version=6
library("MathX")
mean(float src, int len) => ta.sma(src, len)
export zscore(float src, int len) => (src - mean(src, len)) / ta.stdev(src, len)
`,
  'alice/bands/1': `//@version=6
library("Bands")
import alice/mathx/1 as mx
export type Band
    float basis = 0.0
    float upper = 0.0
    float lower = 0.0
export compute(float src, int len, float mult) =>
    basis = ta.sma(src, len)
    dev = mult * ta.stdev(src, len)
    Band.new(basis, basis + dev, basis - dev)
`,
};

const fetched: string[] = [];
async function fetchFromRemote(id: LibraryIdentity): Promise<string | undefined> {
  fetched.push(id.canonical);
  await new Promise((r) => setTimeout(r, 1)); // simulate network latency
  return REMOTE[id.canonical];
}

const remoteCompiled = await compileAsync(consumer, { resolveLibrary: fetchFromRemote });
console.log(`A) remote provider — fetched only what was imported: ${JSON.stringify(fetched)}`);
await runBoth(remoteCompiled, '   ');

// ── B) A large on-disk tree, read lazily: only imported files touched (Node) ──
const fsCompiled = await compileAsync(consumer, {
  resolveLibrary: fsLibrarySource(join(import.meta.dir, 'pine-libs')),
});
console.log('\nB) lazy filesystem provider (examples/pine-libs, reads only imported files)');
await runBoth(fsCompiled, '   ');
