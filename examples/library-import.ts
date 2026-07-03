/**
 * Library import/export with piner — resolve Pine `import`s from your own sources.
 *
 * Unlike TradingView, piner does NOT fetch libraries from a network or a registry.
 * You supply the library sources yourself, in memory, via `compile(src, { libraries })`.
 * Resolution is fully local and deterministic: no network, no filesystem.
 *
 * This example wires up two small libraries — a stats library (`MathX`) and a
 * bands library (`Bands`) that imports it transitively — then compiles a consumer
 * script that uses an imported function, a UDT + method, an enum, and a symbol
 * that reaches through the transitive dependency. It runs BOTH backends and checks
 * they agree byte-for-byte (the invariant that motivates the whole engine), then
 * shows how the guardrails reject a few invalid programs.
 *
 * A real consumer installs the package:
 *
 *     import { compile, Engine, ArrayFeed, type LibraryRegistry } from '@heyphat/piner';
 *
 * This in-repo example imports from source so it runs as-is:
 *
 *     bun run examples/library-import.ts
 *
 * See `examples/library-import-fs.ts` for the SAME libraries loaded from disk on Node
 * via `@heyphat/piner/node`'s `loadLibraryDir()` (browser-first core stays pure).
 */
import {
  compile,
  CompileError,
  Engine,
  ArrayFeed,
  type Bar,
  type LibraryRegistry,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Deterministic OHLCV bars (same output every run — the engine never reads the
//    clock). A Bar is { time, open, high, low, close, volume }, time in epoch-ms.
// ─────────────────────────────────────────────────────────────────────────────
function makeBars(count: number, startMs = Date.UTC(2024, 0, 1)): Bar[] {
  const bars: Bar[] = [];
  const tf = 60_000; // 1-minute bars
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 9) * 2.5 + Math.cos(i / 23) * 1.2;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 0.8;
    const low = Math.min(open, close) - 0.8;
    bars.push({ time: startMs + i * tf, open, high, low, close, volume: 1_000 + (i % 13) * 25 });
    price = close;
  }
  return bars;
}
const bars = makeBars(200);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The library sources — an in-memory registry. Each entry is { key, source }.
//    The key is EITHER a "Publisher/Lib/Version" string OR a structured
//    { user, lib, version } object; both forms are shown below and are equivalent.
//
//    `MathX` exports a function (and keeps a PRIVATE helper the consumer can't see).
//    `Bands` imports `MathX` (a transitive dependency) and exports a UDT, an enum,
//    a method, and functions — one of which reaches through to `MathX`.
// ─────────────────────────────────────────────────────────────────────────────
const registry: LibraryRegistry = [
  {
    // string-form key
    key: 'alice/mathx/1',
    source: `//@version=6
library("MathX")

// A PRIVATE (non-exported) helper: it is merged into any script that calls an
// exported function using it, but a consumer cannot reference \`mathx.mean\`.
mean(float src, int len) => ta.sma(src, len)

// z-score = (value − mean) / standard deviation
export zscore(float src, int len) =>
    (src - mean(src, len)) / ta.stdev(src, len)
`,
  },
  {
    // object-form key — identical to "alice/bands/1"
    key: { user: 'alice', lib: 'bands', version: '1' },
    source: `//@version=6
library("Bands")

// A library may import OTHER libraries (resolved from the same registry).
import alice/mathx/1 as mx

// An exported user-defined type (UDT).
export type Band
    float basis = 0.0
    float upper = 0.0
    float lower = 0.0

// An exported enum.
export enum Side
    Above
    Below
    Inside

// An exported method — callable on a value via receiver dispatch: \`b.width()\`.
export method width(Band self) =>
    self.upper - self.lower

// An exported function returning a UDT instance.
export compute(float src, int len, float mult) =>
    basis = ta.sma(src, len)
    dev = mult * ta.stdev(src, len)
    Band.new(basis, basis + dev, basis - dev)

// An exported function that takes an imported-UDT parameter and returns an enum.
export classify(float src, Band bnd) =>
    src > bnd.upper ? Side.Above : src < bnd.lower ? Side.Below : Side.Inside

// An exported function whose body uses the TRANSITIVELY-imported MathX library.
export zWidth(float src, int len, float mult) =>
    math.abs(mx.zscore(src, len)) * mult
`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. The consumer script. It imports both libraries and exercises every kind of
//    exported symbol: a function, a UDT (constructor + field access + method),
//    an enum member, and a symbol that reaches through the transitive dependency.
// ─────────────────────────────────────────────────────────────────────────────
const source = `//@version=6
indicator("Library Import Demo", overlay = false)

import alice/mathx/1 as mx
import alice/bands/1 as bands

length = input.int(20, "Length")
mult   = input.float(2.0, "Band width")

// (a) call an imported function directly
z = mx.zscore(close, length)

// (b) construct an imported UDT, read its fields, call an imported method
bands.Band b = bands.compute(close, length, mult)
bandWidth = b.width()

// (c) pass an imported UDT to an imported function that returns an imported enum
side = bands.classify(close, b)
aboveBand = side == bands.Side.Above ? 1.0 : 0.0

// (d) a function whose body transitively uses MathX (bands → mathx)
zw = bands.zWidth(close, length, mult)

plot(z,         "z-score")
plot(b.upper,   "upper band")
plot(b.lower,   "lower band")
plot(bandWidth, "band width")
plot(aboveBand, "close above upper (1/0)")
plot(zw,        "z-weighted width")
`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Compile with the registry. Imported symbols are mangled + merged into the
//    consumer AST, so they flow through the exact same monomorphization + slot
//    allocation as local functions — which is why both backends stay identical.
// ─────────────────────────────────────────────────────────────────────────────
const compiled = compile(source, { libraries: registry });
console.log(
  `compiled "${compiled.metadata.title}" — ${compiled.metadata.inputs.length} inputs, ${compiled.metadata.historySlotCount} history slots\n`,
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Run BOTH backends and prove they agree byte-for-byte over every bar. This is
//    the core invariant: imported code must not be able to break it.
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
    const equal = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
    if (!equal) diverged++;
  }
}
console.log(
  `two backends over ${bars.length} bars: ${diverged === 0 ? 'IDENTICAL ✓' : `${diverged} divergences ✗`}\n`,
);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Read the structured outputs (plain data — no rendering).
// ─────────────────────────────────────────────────────────────────────────────
const last = bars.length - 1;
for (const plot of js.values()) {
  const v = plot.data[last];
  console.log(`plot "${plot.title}": last = ${Number.isNaN(v) ? 'na' : v.toFixed(3)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The guardrails. Each of these is a clean CompileError (never a raw crash),
//    so a bad registry or a bad import surfaces as a structured, attributed error.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nguardrails — each of these is rejected with a CompileError:');

function expectRejected(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(`  ✗ ${label}: NOT rejected (unexpected)`);
  } catch (e) {
    const msg =
      e instanceof CompileError ? (e.diagnostics[0]?.message ?? e.message) : (e as Error).message;
    console.log(`  ✓ ${label}\n      → ${msg}`);
  }
}

// (a) importing a library that isn't in the registry
expectRejected('missing library', () =>
  compile('//@version=6\nindicator("x")\nimport alice/ghost/1 as g\nplot(g.f(close))\n', {
    libraries: registry,
  }),
);

// (b) requesting a version that doesn't match
expectRejected('version mismatch', () =>
  compile(
    '//@version=6\nindicator("x")\nimport alice/mathx/2 as mx\nplot(mx.zscore(close, 20))\n',
    { libraries: registry },
  ),
);

// (c) referencing a private (non-exported) symbol
expectRejected('private symbol', () =>
  compile('//@version=6\nindicator("x")\nimport alice/mathx/1 as mx\nplot(mx.mean(close, 20))\n', {
    libraries: registry,
  }),
);

// (d) a library whose export calls a global-only side-effecting builtin (plot)
expectRejected('export-constraint violation', () =>
  compile('//@version=6\nindicator("x")\nimport bad/lib/1 as bad\nplot(bad.draw(close))\n', {
    libraries: [
      {
        key: 'bad/lib/1',
        source: '//@version=6\nlibrary("Bad")\nexport draw(float x) =>\n    plot(x)\n    x\n',
      },
    ],
  }),
);

// (e) an alias that shadows a builtin namespace (piner does not extend builtins)
expectRejected('alias shadows builtin namespace', () =>
  compile(
    '//@version=6\nindicator("x")\nimport alice/mathx/1 as math\nplot(math.zscore(close, 20))\n',
    { libraries: registry },
  ),
);
