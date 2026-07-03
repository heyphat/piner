# Piner

[![CI](https://github.com/heyphat/piner/actions/workflows/ci.yml/badge.svg)](https://github.com/heyphat/piner/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@heyphat/piner.svg)](https://www.npmjs.com/package/@heyphat/piner)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

A clean-room **Pine Script v6** engine in TypeScript — compile and run Pine
indicators and strategies anywhere, browser-first. Designed from the public
TradingView v6 docs only.

Piner is the engine behind [fractalchart.com](https://fractalchart.com), which
is its primary use case, and it's published here as a standalone open-source
library.

![Fractal Chart, powered by Piner](./docs/assets/fractalchart.png)

> `compile(src)` lexes → parses → analyzes → emits JS **and** an interpreter
> oracle; the two backends are cross-checked for byte-for-byte identical output.
> The full v6 language runs end-to-end, plus broad built-in, input, drawing,
> `request.security`, and `strategy` coverage. See
> [`docs/compiler-design.md`](./docs/compiler-design.md).

## Documentation

All docs live in [`docs/`](./docs/README.md):

- **[Architecture](./docs/architecture.md)** — the engine design.
- **[Pine semantics](./docs/pine-semantics.md)** — the v6 spec the engine implements.

## Install

```bash
npm install @heyphat/piner
# or: bun add @heyphat/piner / pnpm add @heyphat/piner / yarn add @heyphat/piner
```

Ships ESM + CJS builds and TypeScript types. Works in the browser and in Node ≥ 18.

## Develop

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
bun test          # full suite incl. the two-backend (js vs interp) cross-check
bun run typecheck # tsc --noEmit
bun run build     # ESM + CJS (bun) + d.ts (tsc) into dist/
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the clean-room policy and the
two-backend invariant before opening a PR.

## What works today

Compile Pine v6 source and run it against a data feed:

```ts
import { compile, Engine, ArrayFeed } from '@heyphat/piner';

const compiled = compile(`//@version=6
indicator("SMA cross", overlay=true)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
plot(fast, title="fast")
plot(slow, title="slow")
plotshape(ta.crossover(fast, slow), title="up")
`);

const engine = new Engine(compiled, new ArrayFeed(bars)); // backend: 'js' (default) | 'interp'
await engine.run({ symbol: 'BTCUSD', timeframe: '60' });
engine.outputs.plots.get(0); // → { id, title, data: number[] }

// realtime: each tick re-runs the open bar (repaint), commit on close
engine.tick(liveBar, /* isClose */ false);
```

`compiled.interpret` is the AST-interpreter backend over the same runtime — used
as the correctness oracle (cross-checked against the generated JS). The runtime
can also execute a hand-written `ScriptFn` directly (see `test/runtime-core.test.ts`).

### Library `import` / `export`

Pine `import Publisher/Lib/Version [as alias]` resolves from an **in-memory
registry** you pass to `compile` — no network, no filesystem, fully deterministic:

```ts
import { compile, Engine, ArrayFeed } from '@heyphat/piner';

const compiled = compile(
  `//@version=6
indicator("uses a library")
import alice/mathlib/1 as ml
plot(ml.zscore(close, 20), title="z")
`,
  {
    libraries: [
      {
        key: 'alice/mathlib/1',
        source: `//@version=6
library("MathLib")
export zscore(float src, int len) => (src - ta.sma(src, len)) / ta.stdev(src, len)
`,
      },
    ],
  },
);
```

Registry keys are `"Publisher/Lib/Version"` or `{ user, lib, version }`. Exported
functions, UDTs (`type`), enums, and `method`s resolve through the alias. Versions
match exactly; transitive imports resolve (depth cap 32) with cycles rejected;
export-constraint violations (e.g. `plot` inside an export) are compile errors.
Imported symbols are inline-merged, so the two backends stay byte-for-byte identical.
An alias equal to a builtin namespace (e.g. `ta`) is rejected — piner does not
implement TradingView's builtin-namespace _extension_.

#### Loading libraries from the filesystem (Node)

The core `compile()` is pure and browser-safe (no I/O). For Node/CLI/server use, the
optional `@heyphat/piner/node` entry point builds a registry from `.pine` files on disk —
so you don't assemble it by hand. It's never bundled into the browser build.

```ts
import { loadLibraryDir, compile } from '@heyphat/piner/node';

// Scans <root>/<publisher>/<lib>/<version>.pine  (mirrors the import identity):
//   pine-libs/PineCoders/AllTimeHighLow/1.pine → "PineCoders/AllTimeHighLow/1"
const libraries = loadLibraryDir('./pine-libs');
const compiled = compile(source, { libraries });
```

`loadLibraryManifest('libs/manifest.json')` is also available for non-conventional layouts
(a JSON map of `"Publisher/Lib/Version"` → source-file path). The identity comes from the
path, not the file's `library("…")` title; multiple `<version>.pine` files coexist.

#### Async / lazy resolution (HTTP, CDN, large trees)

When sources live behind async I/O (an HTTP CDN, a database) or in a large on-disk tree you
don't want to scan eagerly, `compileAsync(src, { resolveLibrary })` walks the import graph and
fetches ONLY the libraries actually imported (transitively), then calls the pure `compile()`:

```ts
import { compileAsync } from '@heyphat/piner';

const compiled = await compileAsync(source, {
  resolveLibrary: async ({ canonical }) => {
    const res = await fetch(`https://cdn.example.com/pine/${canonical}.pine`);
    return res.ok ? await res.text() : undefined; // undefined ⇒ missing-library error
  },
});
```

The provider may be sync or async. Node's `fsLibrarySource('./pine-libs')` (from
`@heyphat/piner/node`) is a ready-made **lazy** provider that reads only the single
`<publisher>/<lib>/<version>.pine` files that are imported. `compile()` itself stays
synchronous and pure — `compileAsync` just gathers sources first (see
`resolveLibraryClosure` for the standalone gatherer).

## Contributing

Contributions are welcome — bug reports, fixes, new built-in coverage, and docs.
Please read [CONTRIBUTING.md](./CONTRIBUTING.md) (especially the clean-room
policy) and the [Code of Conduct](./CODE_OF_CONDUCT.md) first.

## License

[GNU AGPL-3.0](./LICENSE) © Phat Huynh.

Piner is a clean-room reimplementation from public TradingView documentation. No
third-party Pine engine code is used or copied.
