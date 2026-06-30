# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
