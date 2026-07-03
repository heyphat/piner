# Piner Documentation

Clean-room **Pine Script v5/v6** engine for the browser and Node. Designed from the
public TradingView v6 docs only.

## Contents

| Doc                                                              | What it covers                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)                             | The engine design: compilation pipeline, the slot model (history/state/var), the execution context (`$`), the driver + realtime rollback, built-in library structure, multi-timeframe and strategy engines, and the directory layout.                               |
| [compiler-design.md](./compiler-design.md)                       | The **compiler contract**: the AST/annotation contract, lexer indentation algorithm, the full operator-precedence table, qualifier inference, slot-allocation rules, the codegen node→JS mapping, and the interpreter oracle.                                       |
| [pine-semantics.md](./pine-semantics.md)                         | The **specification** the engine implements: verified Pine v6 execution semantics (bar-by-bar, series `[]`, `na`, `var`/`varip`, rollback, repaint, `request.security()`), with source citations.                                                                   |
| [coverage-and-compatibility.md](./coverage-and-compatibility.md) | **What's supported** of Pine v6 (measured against the official reference-manual corpus) and **how piner maps onto fractal-chart** — the integration seam, compatibility scorecard, and adapter surface.                                                             |
| [pine-v6-feature-support.md](./pine-v6-feature-support.md)       | The **feature→location map**: every language feature and builtin namespace with its `src/` implementation site and support status (✅ / ⚠️ / ❌).                                                                                                                   |
| [parity-matrix.md](./parity-matrix.md)                           | **Numeric parity vs an independent reference runtime / the v6 manual**, namespace by namespace — how the math is verified.                                                                                                                                          |
| [v6-coverage-gap.md](./v6-coverage-gap.md)                       | **Auto-generated** name-by-name diff of piner's surface against every `##` entry in the bundled v6 reference manual (`bun scripts/v6-coverage-audit.ts`).                                                                                                           |
| [audit-2026-07.md](./audit/2026-07.md)                           | **Correctness audit & fix log** (July 2026): every verified logic bug found in the initial release — na-truthiness, realtime rollback, inliner capture, broker fills, numeric formulas — what was fixed, what was deliberately left, and the test-coverage lessons. |

## Status

The full Pine **v5/v6 language** is implemented — lexer/parser/semantics, the full
expression grammar, control flow as statements _and_ expressions, `(qualifier,
type)` inference, `var`/`varip` + realtime rollback, history `[]`, `na` semantics,
user-defined functions (call-site inlining), UDTs, `enum`, user `method`s, and the
`array`/`map`/`matrix` collections. On top of it: the complete **visual surface**
(plots, per-bar colors, markers, candles, bar/bg color, fills incl. gradient, all
drawing objects), **inputs** (schema + override-by-title), broad
`ta.*`/`math.*`/`str.*`/`color.*` coverage, date/symbol/timeframe builtins,
**`request.security()`** (v1), and the **`strategy.*`** broker (v1).

- **Two backends, byte-for-byte identical.** `compile(src)` emits both a JS closure
  (`codegen/emit.ts`) and an AST interpreter (`interp/interpreter.ts`) against the
  same runtime `$`; the whole test suite asserts they agree. **530 tests** (1 skipped
  — the optional reference-manual corpus), 0 failing.
- **Coverage.** ~96% of the official v6 reference-manual single-script examples
  compile _and run_ end-to-end with **0 backend divergences**; the auto-generated
  gap report covers **846/884 manual entries (95.7%)** with every _fillable_ gap
  closed. See [coverage-and-compatibility.md](./coverage-and-compatibility.md).
- **Now supported:** library `import`/`export` via an in-memory source registry
  (`compile(src, { libraries })`; no network/FS, both backends byte-identical).
- **Still deferred:** fundamental/alternative `request.*` data feeds, a live
  session model, and ULP-level numeric parity vs TradingView itself.

## Reading order

1. [pine-semantics.md](./pine-semantics.md) — what Pine _does_ (the problem).
2. [architecture.md](./architecture.md) — how the engine models the runtime.
3. [compiler-design.md](./compiler-design.md) — how the compiler is built.
4. [pine-v6-feature-support.md](./pine-v6-feature-support.md) — what's supported, and where it lives.
5. [coverage-and-compatibility.md](./coverage-and-compatibility.md) — measured coverage + fractal-chart integration.
