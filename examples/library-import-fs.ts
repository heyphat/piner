/**
 * Library import/export from the FILESYSTEM (Node) — `@heyphat/piner/node`.
 *
 * The core `compile()` is pure and browser-safe: it resolves `import`s only from an
 * in-memory registry (see `examples/library-import.ts` for that browser-friendly form).
 * On Node/CLI/server, the optional `@heyphat/piner/node` entry point reads `.pine` files
 * from disk and builds that registry for you — so you don't assemble it by hand.
 *
 * The on-disk layout mirrors the import identity `Publisher/Lib/Version`:
 *
 *     examples/pine-libs/
 *       alice/mathx/1.pine   → identity "alice/mathx/1"
 *       alice/bands/1.pine   → identity "alice/bands/1"   (imports alice/mathx/1)
 *
 * A real consumer installs the package and imports the Node entry:
 *
 *     import { loadLibraryDir, compile, Engine, ArrayFeed } from '@heyphat/piner/node';
 *
 * This in-repo example imports from source so it runs as-is:
 *
 *     bun run examples/library-import-fs.ts
 */
import { join } from 'node:path';
// `@heyphat/piner/node` re-exports the full core, so one import gives you the loader
// AND compile/Engine/ArrayFeed. (In-repo we point at the source module `../src/node.ts`.)
import { loadLibraryDir, compile, Engine, ArrayFeed, type Bar } from '../src/node.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Deterministic OHLCV bars.
// ─────────────────────────────────────────────────────────────────────────────
function makeBars(count: number, startMs = Date.UTC(2024, 0, 1)): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 9) * 2.5 + Math.cos(i / 23) * 1.2;
    const open = price;
    const close = price + drift;
    bars.push({
      time: startMs + i * 60_000,
      open,
      high: Math.max(open, close) + 0.8,
      low: Math.min(open, close) - 0.8,
      close,
      volume: 1_000 + (i % 13) * 25,
    });
    price = close;
  }
  return bars;
}
const bars = makeBars(200);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Load every library under examples/pine-libs/ into a registry. `loadLibraryDir`
//    scans <root>/<publisher>/<lib>/<version>.pine and keys each by its identity.
//    (Use `loadLibraryManifest('…/manifest.json')` for non-conventional layouts.)
// ─────────────────────────────────────────────────────────────────────────────
const libraries = loadLibraryDir(join(import.meta.dir, 'pine-libs'));
console.log('discovered libraries on disk:');
for (const lib of libraries) console.log(`  ${lib.key}  (${lib.source.split('\n').length} lines)`);
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// 3. Compile a consumer that imports from the loaded registry — identical to the
//    in-memory form; only the SOURCE of the registry differs (disk vs. inline).
// ─────────────────────────────────────────────────────────────────────────────
const source = `//@version=6
indicator("Library Import (filesystem)", overlay = false)

import alice/mathx/1 as mx
import alice/bands/1 as bands

length = input.int(20, "Length")
mult   = input.float(2.0, "Band width")

z = mx.zscore(close, length)
bands.Band b = bands.compute(close, length, mult)
bandWidth = b.width()
zw = bands.zWidth(close, length, mult)

plot(z,         "z-score")
plot(b.upper,   "upper band")
plot(b.lower,   "lower band")
plot(bandWidth, "band width")
plot(zw,        "z-weighted width")
`;

const compiled = compile(source, { libraries });
console.log(`compiled "${compiled.metadata.title}" — ${compiled.metadata.inputs.length} inputs\n`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Run BOTH backends and confirm byte-for-byte agreement (the core invariant).
// ─────────────────────────────────────────────────────────────────────────────
async function runPlots(backend: 'js' | 'interp') {
  const engine = new Engine(compiled, new ArrayFeed(bars), { backend });
  await engine.run({ symbol: 'BINANCE:BTCUSDT', timeframe: '1' });
  return engine.outputs.plots;
}
const [js, interp] = await Promise.all([runPlots('js'), runPlots('interp')]);
let diverged = 0;
for (const [id, plot] of js) {
  const other = interp.get(id)!.data;
  for (let i = 0; i < plot.data.length; i++) {
    const a = plot.data[i],
      b = other[i];
    if (!((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9)) diverged++;
  }
}
console.log(
  `two backends over ${bars.length} bars: ${diverged === 0 ? 'IDENTICAL ✓' : `${diverged} divergences ✗`}\n`,
);

const last = bars.length - 1;
for (const plot of js.values()) {
  const v = plot.data[last];
  console.log(`plot "${plot.title}": last = ${Number.isNaN(v) ? 'na' : v.toFixed(3)}`);
}
