# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added

- Pine v6 library `import`/`export`: registry-based resolution, transitive graphs,
  UDTs/enums/methods, name mangling + inline-merge, and the Node filesystem/async loaders
  (`@heyphat/piner/node`, `compileAsync`).
- Same-named exported **methods** distinguished by receiver type or arity are now real
  overloads (each resolves to its own definition); exported methods on builtin receivers
  (`array`/`matrix`/`map`/…) dispatch through method syntax.
- `chart.point.copy()`, and `chart.point.now()`'s price defaults to `close`; `copy(na)` is `na`.
- Vendored the official `TradingView/ZigZag/7` library (MPL-2.0, verbatim v7) into the
  library test corpus; TradingView's **Auto Pitchfork** now runs end-to-end through
  `import TradingView/ZigZag/7` with byte-for-byte identical drawings on both backends.
- Per-trade introspection on the open position: `strategy.opentrades` counts one open
  trade per entry, and the `strategy.opentrades.*(i)` getters (`profit`, `entry_price`,
  `entry_bar_index`, `size`, `entry_id`) read each entry lot individually.

### Changed (breaking)

- `compile(source)` now **resolves `import` statements**. A script containing imports
  requires every imported library in `options.libraries` (or a `compileAsync` provider);
  an unresolved import is a `CompileError` instead of being silently ignored. Import-free
  scripts are unaffected and remain byte-identical.
- A script with more than one top-level `indicator`/`strategy`/`library` declaration is now
  a `CompileError` (matching TradingView); previously the extra declarations were ignored.
- Import version segments match the registry **exactly as a string** (`import a/b/01`
  requires key `a/b/01`, not `a/b/1`) — no numeric coercion.
- The strategy trade ledger now books **one closed-trade row per entry-exit pair** (FIFO),
  as TradingView does. Closing a pyramided position produces one row per entry — with that
  entry's own fill price/bar — instead of a single blended row, so `strategy.closedtrades`
  counts and the `engine.strategy` report change for pyramided strategies.

### Fixed

**Full-codebase correctness audit (both backends, verified against the v6 manual):**

- `na` was truthy in every condition context (`if`, `while`, ternaries, `and`/`or`,
  subject-less `switch`) — an na bool executed the branch it should have skipped.
  Conditions now coerce na → false per v6, and `not na` is `true`.
- `break`/`continue` inside a `switch` in a loop failed to compile on the JS backend and
  was silently swallowed by the interpreter.
- The realtime tick path was systematically broken: strategy hooks never ran on live ticks
  (orders queued forever), broker and alert state did not roll back between ticks of the
  developing bar (duplicate orders/alerts), `request.security` caches went stale once live
  ticks began, and `barstate.isfirst` was hardcoded false on realtime bars.
- `time_close` (the variable) returned the bar's **open** time.
- The function inliner captured same-named caller variables into parameter bindings
  (`f(1, a)` could bind a later argument to an earlier parameter's fresh value, in either
  direction for method receivers). Arguments now evaluate into fresh temps first.
- Type inference feeding `+` dispatch: `str.*` returns were all typed string
  (`str.tonumber("2") + 1` → `"21"`), string builtin members (`syminfo.ticker`,
  `timeframe.period`, …) were typed float (`prefix + ticker` → NaN), and a user method
  named after a builtin function hijacked calls like `str.tostring(...)`.
- Backend divergences: `continue` in an indexed `for [i, v] in` desynced codegen's index;
  compound assignment read the target after the RHS in the interpreter; drawing
  constructors evaluated opts before coordinates in one backend; member access on an na
  object threw in codegen but was na in the interpreter.

**ta/math numerics:**

- `math.round` rounds ties away from zero (`round(-4.5)` → `-5`, was `-4`; also
  `round_to_mintick`); `math.pow(na, 0)` is na, not 1.
- One na source value permanently poisoned `ta.bb`'s basis; `ta.kc` used RMA instead of
  **EMA** of true range (bands systematically wide/slow); `ta.change`/`mom`/`roc` counted
  non-na samples instead of bars; `ta.cmo`/`ta.mfi` emitted one bar early; bare `ta.tr`
  is na on bar 0 and `ta.tr(handle_na)` actually reaches the runtime;
  `ta.percentrank(na, …)` is na; Woodie pivot uses the current period's open.
- A shrinking series-int `length` shed only one buffer element per bar (`sma` over a
  window that dropped 5 → 2 averaged 5 values by 2); the 2-arg `ta.vwap(source, anchor)`
  overload silently ignored its anchor.

**Collections, strings, parser:**

- `array.sort`/`sort_indices` never sorted string arrays (numeric comparator); negative
  index / out-of-range JS **wraparound** eliminated (`array.insert(a, -1, …)`,
  `array.fill` past the end, `str.substring` negative start); `array.sum([])` is na;
  `matrix.mult(matrix, array)` returns an array per Pine's overload (was an n×1 matrix),
  with `reshape`/`pow`/`trace`/`add_col` edge cases fixed alongside.
- `str.format` applies MessageFormat digit grouping (`{0,number}` → `"1,340,000"`);
  `str.tonumber` uses a strict decimal/scientific grammar (no `"0x10"`/`"Infinity"`);
  `color.new(c)` with transp omitted no longer emits a malformed color string.
- Parser: a block-form `if`/`switch` in expression position consumed the **next**
  statement's leading `[`/`(` as a postfix operator; UDT fields with dotted builtin types
  (`chart.point point`) were rejected.
- `request.security` same-symbol detection used unanchored `endsWith` (`WETHUSDT` on an
  `ETHUSDT` chart was answered with the chart's own bars).

**Strategy broker — order handling (first audit pass):**

- `strategy.order` in the opposite direction **nets** against the position instead of
  fully reversing; limit/stop fills are bounded by the bar open on gaps (no impossible
  fill prices); re-submitting an order id replaces the resting order instead of stacking;
  an exit bracket is spent after it fills (no re-fire); `strategy.close(id)` is a no-op
  unless the id holds an open entry; trade profit includes pro-rated entry-side
  commission; zero-profit trades count as `eventrades` (not wins); slippage applies to
  stop fills as well as market; intrabar stop-vs-limit ordering follows the bar-shape
  heuristic (extreme nearer the open first).

**Strategy broker — TradingView-faithful rework (per-entry FIFO lots):**

- `strategy.exit` honors `from_entry` (was: always closed the whole position), and its
  `profit`/`loss` ticks are measured from each entry's own fill price, not the position
  average; `position_avg_price` re-prices to the remaining lots after a partial close.
- `strategy.cancel`/`cancel_all` cancel exit brackets too (market orders stay
  uncancelable, matching TV).
- `process_orders_on_close` treats the close pass as a **one-price tick**: new exit
  orders can no longer fill at pre-close prices that predate them (lookahead), and
  limit/stop orders can fill on the close tick as TV does.
- Trailing stops walk the assumed intrabar path (open → nearer extreme → farther extreme
  → close): a gap through the stop fills at the open instead of the unreachable stop
  level, an adverse extreme that occurs before arming can no longer trigger, and the
  ratchet can't use an extreme the path hasn't reached yet.
- `stop`+`loss` (or `limit`+`profit`) on one exit combine per TV's "whichever triggers
  first" rule (ticks no longer silently override the absolute price); max drawdown/run-up
  are computed from intrabar equity extremes, not close-only equity.

**Library import/export:**

- A library body calling one of its **own methods in function form** (`f(receiver, …)` —
  Pine methods "can be used as a function or method") bound to a mangled name no
  declaration carries, so the call silently evaluated to `na` (ZigZag's pivots never
  registered). It now dispatches through the method mangler, with a clean diagnostic when
  no overload matches.
- Library methods with **defaulted trailing parameters** were dispatched by exact arity,
  so calls omitting the defaulted tail were rejected. Dispatch now accepts the
  min-to-declared arity range in every call form (method, function, `alias.method`,
  builtin-receiver).
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

[0.3.0]: https://github.com/heyphat/piner/compare/v0.2.1...v0.3.0
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
