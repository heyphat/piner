# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Piner (`@heyphat/piner`) is a clean-room **Pine Script v6 engine** in TypeScript — compiles and runs TradingView Pine indicators/strategies in the browser and Node. It powers fractalchart.com. License is AGPL-3.0.

## Commands

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
bun test                        # full suite (~530 tests, includes two-backend cross-check)
bun test test/parser.test.ts    # single test file
bun test -t "pattern"           # filter by test name
bun run typecheck               # tsc --noEmit
bun run build                   # ESM + CJS (bun) + d.ts (tsc) into dist/
bun scripts/v6-coverage-audit.ts  # regenerate docs/v6-coverage-gap.md
```

## Non-negotiable invariants

1. **Two-backend invariant.** `compile(src)` produces both generated JS (`src/codegen/emit.ts`) and an AST interpreter (`src/interp/interpreter.ts`) over the same runtime `$`. The test suite asserts **byte-for-byte identical output** from both. Any semantics change must update codegen AND interpreter in the same change.
2. **Clean-room policy.** Implemented only from public TradingView Pine v6 docs. Never copy/paraphrase code from other Pine engines.
3. **Determinism.** No `Date.now()`/`Math.random()` in the engine core; all time comes from the data feed. Core `compile()` is pure and browser-safe (no I/O) — Node-only filesystem helpers live exclusively in `src/node.ts` (`@heyphat/piner/node` entry point).
4. Behaviour changes need tests; bug fixes need a regression test. Use Conventional Commits (`feat(ta): ...`, `fix(parser): ...`) — the changelog depends on it.

## Architecture

Compilation pipeline (`src/engine/compiler.ts` orchestrates):

```
source → lexer/ → parser/ (AST) → sema/inline.ts (monomorphize user fns/methods per call site)
       → sema/analyze.ts (ONE pass: names, (qualifier,type) inference, na-lints, slot allocation via sema/slots.ts)
       → codegen/emit.ts (JS `main($)` closure)  AND  interp/interpreter.ts (oracle)
```

Both backends target the same runtime `$` = `ExecutionContext` (`src/runtime/context.ts`).

**The slot model** (heart of the engine, resolved at compile time in `sema/slots.ts`):
- **History slots** — a series value referenced as `x[n]` gets a column in `SeriesStore` (`runtime/series.ts`): flat typed-array columns indexed by a global bar counter; out-of-range reads return `na`, never throw.
- **State slots** — each *call site* of a stateful built-in (e.g. `ta.sma`) gets an integer site id; the builtin keeps per-site state (ring buffers etc.).
- **`var`/`varip` slots** — `var` persists across bars; `varip` also persists across realtime ticks (exempt from rollback).

**Realtime model** (`engine/driver.ts`): historical bars run `main($)` once and commit. A realtime tick = rollback (truncate SeriesStore to committed length, restore builtin/var snapshots, drop uncommitted outputs) + replay the open bar. This single mechanism produces correct repainting.

**`na` semantics**: numeric `na` is JS `NaN`; non-numeric `na` is the cloneable `NA` sentinel (`runtime/series.ts`). `na` through comparisons → `false` (v6 rule); comparisons funnel through `$.lt/$.eq/...` so the rule lives in one place.

**Libraries** (`sema/library.ts` etc.): `import Publisher/Lib/Version` resolves from an in-memory registry passed to `compile(src, { libraries })`; imported symbols are inline-merged so the two backends stay identical. `compileAsync` gathers sources via a `resolveLibrary` provider then calls the pure `compile`.

Other key areas: `runtime/builtins/` (one file per namespace: ta/math/str/color/array/map/matrix/input/drawing/strategy/request), `runtime/output.ts` (serializable visual IR, rollback-aware), `request.security` runs a nested sub-context, `strategy.ts` is a deterministic broker simulator (fills at next bar open).

## Tests

`test/` is flat by feature; notable ones: `cross-check.test.ts` and `parity.test.ts` (two-backend + reference parity), `corpus.test.ts` (optional reference-manual corpus, skipped without fixtures), `test/pbt/` (fast-check property tests, mostly for library import), `test/pinescripts/` (real-world `.pine` fixtures).

## Docs

`docs/` is substantive and kept current — read before changing semantics:
- `docs/architecture.md` — engine design (slot model, `$`, driver/rollback).
- `docs/compiler-design.md` — the compiler contract (AST annotations, precedence, slot rules, codegen mapping).
- `docs/pine-semantics.md` — the v6 spec being implemented, with citations.
- `docs/pine-v6-feature-support.md` — feature → `src/` location map.
- `docs/v6-coverage-gap.md` — auto-generated; regenerate via the audit script, don't hand-edit.
