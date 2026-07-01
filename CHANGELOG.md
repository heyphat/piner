# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Pine v6 library `import`/`export`: registry-based resolution, transitive graphs,
  UDTs/enums/methods, name mangling + inline-merge, and the Node filesystem/async loaders
  (`@heyphat/piner/node`, `compileAsync`).
- Same-named exported **methods** distinguished by receiver type or arity are now real
  overloads (each resolves to its own definition); exported methods on builtin receivers
  (`array`/`matrix`/`map`/…) dispatch through method syntax.

### Changed (breaking)
- `compile(source)` now **resolves `import` statements**. A script containing imports
  requires every imported library in `options.libraries` (or a `compileAsync` provider);
  an unresolved import is a `CompileError` instead of being silently ignored. Import-free
  scripts are unaffected and remain byte-identical.
- A script with more than one top-level `indicator`/`strategy`/`library` declaration is now
  a `CompileError` (matching TradingView); previously the extra declarations were ignored.
- Import version segments match the registry **exactly as a string** (`import a/b/01`
  requires key `a/b/01`, not `a/b/1`) — no numeric coercion.

### Fixed
- A module-level `var`/tuple binding mutated or read by an exported function is now mangled
  consistently, so it can no longer clobber (or be clobbered by) a same-named consumer
  variable, and the two backends stay byte-for-byte identical.
- Duplicate exported names (functions/types/enums/constants, or a method with an identical
  receiver type + arity) are reported instead of silently collapsing to the last one.
- Library-scoped imports get the same duplicate-alias / builtin-namespace validation as the
  consumer's; a private (non-exported) or misspelled imported type used as an annotation is
  rejected; export-purity checks follow method-syntax private helpers.
- `RefRewriter` type tracking is scoped per function, so a UDT-typed name no longer leaks
  into a sibling function that reuses the name for a plain value.
- `compileAsync` validates its `libraries` seed like `compile()` (duplicate/malformed keys
  throw) instead of silently keeping the last duplicate.
- Node loaders no longer follow symlinks out of the library root, `fsLibrarySource` matches
  identities case-sensitively (consistent with `loadLibraryDir`), and `loadLibraryManifest`
  rejects source paths that escape the manifest directory.
- `@heyphat/piner/node` shares one copy of the core with the main entry, so
  `err instanceof CompileError` holds across both entry points.

## [0.2.1]

First public open-source release.

### Added
- Multiline string literals (`"""…"""` / `'''…'''`).
- Headless usage example (`examples/headless.ts`).

### Changed
- Open-sourced under the GNU AGPL-3.0 license.
- Published to the public npm registry as `@heyphat/piner`
  (previously a private package on GitHub Packages).

## [0.1.8]

### Added
- `ta.requestUpAndDownVolume` (TradingView/ta library).

### Fixed
- `color.new(na)` returns `na` instead of crashing.
- `ta.supertrend` matches TradingView's direction sign convention.
- `fill` detects the gradient overload from positional args.

## [0.1.7]

### Fixed
- Weekly timeframe buckets start on Monday, not Sunday.
- Inputs capture positional options / `minval` / `maxval` / `step`.

## [0.1.6]

### Fixed
- Drawings bind positional styling args and method named-args into opts.
- Parser recognizes qualified-type var declarations (`chart.point[] x`).

## [0.1.5]

### Fixed
- `plotshape` / `plotchar` / `plotarrow` bind positional args.

## [0.1.4]

### Fixed
- `ta.highest` / `ta.lowest` warmup gated by bars elapsed, not non-`na` count.
- Drawing constructors preserve named opts when a positional arg is omitted.

## [0.1.3]

### Fixed
- `max_*_count` caps enforced with most-recent-N (FIFO) retention.
- Parser allows a fundamental-type keyword as a variable name.
- Empty-timeframe `request.security_lower_tf` falls back to chart bars.
- Positional `xloc` / `extend` handled in the `line.new` / `box.new` point overload.
- `label.new` chart.point overload implemented.
- Inputs resolve named-constant defaults/options in metadata.

## [0.1.2]

### Fixed
- Parser supports comma-separated statement series on one line.

## [0.1.1]

### Added
- Per-bar loop-iteration budget and rejection of reserved-property access (sandboxing).
- Inline-expression and chained history `(expr)[n]`.
- Non-numeric series history, `request.security_lower_tf`, qualified-type & UDT-array parsing.
- Cross-symbol `request.security` via injected bars; security dependency declaration.
- `strategy` features: `process_orders_on_close`, stop-limit orders, real pyramiding entry counts.
- Configurable `mintick` (was hard-coded to 0.01).
- `input.source` honors a source-name string override.

### Fixed
- Descending `for` loops count down in both backends.
- Parser allows keywords as identifiers, param names, and statement values.
- `if` / `switch` as a function body returns its value.

## [0.1.0]

Initial release: clean-room Pine Script v6 engine. `compile(src)` lexes → parses
→ analyzes → emits JS and an interpreter oracle, cross-checked for identical
output. Real indicators (SMA/EMA cross, RSI, Bollinger, ATR, …) run end-to-end.

[0.2.1]: https://github.com/heyphat/piner/compare/v0.1.8...v0.2.1
[0.1.8]: https://github.com/heyphat/piner/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/heyphat/piner/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/heyphat/piner/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/heyphat/piner/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/heyphat/piner/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/heyphat/piner/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/heyphat/piner/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/heyphat/piner/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/heyphat/piner/releases/tag/v0.1.0
