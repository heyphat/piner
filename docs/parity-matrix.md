# Mathematical Parity Matrix — piner vs PineTS / the v6 manual

How piner's numeric output is verified against an independent reference, namespace
by namespace. Companion to [`coverage-and-compatibility.md`](./coverage-and-compatibility.md).

## Methodology

The same Pine v6 source runs over the **same bars** through piner and **PineTS**
(LuxAlgo's independent runtime, which targets TradingView precision), and plot
values are compared bar-by-bar (`test/parity.test.ts`; harness `/tmp/pcheck.ts`).
Non-numeric results are encoded into numbers: `bool → x?1:0`, `string → str.length`,
`color → color.r/g/b/t`, `array → size/get/sum`, `matrix → get/rows/columns/sum`.

**Ground-truth order:** the bundled v6 reference manual is authoritative; PineTS is
a _cross-check_, not an oracle — it has its own bugs. Where the two disagree, the
manual's documented `pine_*` formula decides. A function is **exact** when
`maxRel < 1e-6` and `naMis = 0` vs PineTS.

## How much of Pine the parity layer covers (and why it's the narrowest)

Parity is the **narrowest of piner's three verification layers by design** — you
cannot numerically diff against PineTS what PineTS doesn't compute. The numbers,
counted from `test/parity.test.ts` (namespace `ns.member` references + bare
series/date leaves + the `na`/`nz`/`fixnan`/`timestamp` functions, deduped):

| Measure                                                     | Numerator / Denominator                                                     | Coverage                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| **(a) Parity coverage of the WHOLE manual**                 | **134** / 884                                                               | **~15%**                                        |
| **(b) Parity coverage of the _parity-able_ universe**       | **134** / ~310                                                              | **~43%**                                        |
| (c1) piner _implementation_ coverage (for contrast)         | 846 / 884                                                                   | **95.7%**                                       |
| (c2) two-backend oracle + conformance corpus (for contrast) | js ≡ interp on every builtin; 399/408 manual example scripts run end-to-end | **~100% of implemented surface, 0 divergences** |

- **134** distinct manual entries (functions + variables + constants) carry a PineTS
  numeric check (~114 namespaced + ~20 bare leaves/fns). Operators (20/20) and
  core-language constructs are parity-tested on top of that; the count is approximate
  at the ±10 level depending on convention (e.g. whether `color.r/g/b/t` count as 4).
- **(b) ~43% is the fair number.** Of the 884 manual entries only **~310 are ever
  numerically parity-able** by PineTS (≈258 functions + 39 variables + 13 constants;
  +20 operators if counted). The other **~554 are structurally off-limits**: PineTS
  has **no strategy/backtest engine** (~47 fns + 35 vars), **no drawing-object model**
  (line/label/box/table/linefill/polyline ≈ 107 fns), **doesn't evaluate most of the
  204 constants** (opaque string/enum tags — only ~13 fold to comparable scalars), and
  stubs/omits `request.*` fundamentals, live `syminfo` metadata, `chart`/`session`
  state, and `alert`/`log`/`runtime` side-effects. Keywords/Types/Annotations (43) are
  structural, not numeric.
- **What covers the rest.** PineTS is the targeted _external_ sanity check on
  indicator/series **math** — the part most likely to be subtly wrong. The full breadth
  (strategy, drawings, constants, casts, control flow, every namespace) is proven by
  the **two-backend byte-for-byte oracle** (every test asserts js-codegen ≡
  AST-interpreter, |Δ|<1e-9) and the **conformance corpus** (399/408 reference example
  scripts run through both backends, 0 divergences). See
  [`coverage-and-compatibility.md`](./coverage-and-compatibility.md) §1.

## Coverage by namespace

| Namespace                                                                                                                                                                                      | Value fns | Status                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **language core** (operators, na-propagation, history `[]`, `var`/`varip`, `if`/`switch`/`for`/`while` as values, casts, `nz`/`na`/`fixnan`, OHLCV + `hl2/hlc3/ohlc4`, `bar_index`, date/time) | —         | ✅ **100% exact**                                                                                                                                                                                                                                                                                        |
| `math.*`                                                                                                                                                                                       | 28        | ✅ exact; `round_to_mintick` added. `atan2`/`gcd`/`factorial` are piner extensions (absent from PineTS, sanity-checked vs definition). `random` deterministic by design.                                                                                                                                 |
| `ta.*`                                                                                                                                                                                         | ~70       | ✅ broad exact; see fixes below. `rci`/`mode`/`pivot_point_levels` (6 types) now implemented (hand-verified — PineTS lacks them). `ta.pvt` parity-exact (~1e-11).                                                                                                                                        |
| `array.*`                                                                                                                                                                                      | 55        | ✅ exact; `percentrank` added, `min/max` nth, `stdev/variance/covariance` biased flag, `mode` smallest-on-tie.                                                                                                                                                                                           |
| `matrix.*`                                                                                                                                                                                     | 49        | ✅ exact; `add_row/add_col` signature fixed, `diff/swap_rows/swap_columns/reshape/submatrix` added, plus `eigenvalues` (QR/Householder, exact vs PineTS), `eigenvectors`, `pinv`.                                                                                                                        |
| `str.*`                                                                                                                                                                                        | 18        | ✅ incl. `str.tostring`/`str.format` number-format patterns (`#.##`/`0.00`/`integer`/`percent`/`currency`) and IANA-tz `format_time`. piner follows the manual where PineTS's currency/percent/`#` differ.                                                                                               |
| `map.*`                                                                                                                                                                                        | 11        | ✅ exact; `put` now returns the previous value.                                                                                                                                                                                                                                                          |
| `color.*`                                                                                                                                                                                      | 24        | ✅ channels + `from_gradient`; palette corrected to the v6 hex + `olive` added (transparency rounding ±1).                                                                                                                                                                                               |
| `timeframe.*`                                                                                                                                                                                  | 16        | ✅ `in_seconds()`/`from_seconds()`/`change()` are functions; `isticks`/`main_period` added; `1M` second-count approximate.                                                                                                                                                                               |
| `barstate.*` / `session.*`                                                                                                                                                                     | 7 + 4     | ✅ `isfirst` + `islastconfirmedhistory` fixed. `ishistory/isrealtime` reflect piner's historical-replay model. `session.is{first,last}bar(_regular)` flag trading-day boundaries (24h feed).                                                                                                             |
| `chart.*`                                                                                                                                                                                      | —         | ✅ `is_standard` true; `is_heikinashi`/`is_renko`/`is_kagi`/`is_pnf`/`is_range`/`is_linebreak` false; `bg_color`/`fg_color`; `left_visible_bar_time`/`right_visible_bar_time`.                                                                                                                           |
| `alert`                                                                                                                                                                                        | —         | ✅ callable namespace `alert(msg, freq)` + `freq_all`/`freq_once_per_bar`/`freq_once_per_bar_close` constants.                                                                                                                                                                                           |
| `input.*`                                                                                                                                                                                      | 13        | ✅ all typed forms + bare auto-typed `input(defval)`; defaults flow through.                                                                                                                                                                                                                             |
| `request.*`                                                                                                                                                                                    | —         | ✅ `security` same-TF is identity, HTF non-repainting; fundamentals (`dividends`/`earnings`/…) are na-stubs (no feed).                                                                                                                                                                                   |
| `syminfo.*`                                                                                                                                                                                    | 43        | ✅ fixed defaults + `minmove`/`pricescale` (mintick≡minmove/pricescale) + `prefix()`/`ticker()` function form; live exchange metadata still N/A.                                                                                                                                                         |
| `strategy.*` (stats)                                                                                                                                                                           | —         | ✅ `*_percent` (netprofit/openprofit/grossprofit/grossloss/max_drawdown), `max_runup(_percent)`, `avg_trade/winning/losing(_percent)`, `max_contracts_held_*`, `position_entry_name`, `closedtrades.first_index`, `opentrades.capital_held`. Both-backend cross-checked (PineTS has no strategy engine). |
| Date/time                                                                                                                                                                                      | —         | ✅ `timestamp(...)` (numeric/tz/string), `time(tf)`/`time_close(tf)`, `last_bar_time`/`time_tradingday` (parity-exact vs PineTS), `timenow` (deterministic), `dayofweek.<day>` constants (Sun=1…Sat=7); session-filtering inside `time()` deferred.                                                      |

## Real piner bugs found by parity & fixed

| Fix                                                               | Was                               | Now                               |
| ----------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| `request.security` same-TF                                        | returned `close[1]` (lagged)      | returns `close` (lag is HTF-only) |
| `ta.vwap`                                                         | cumulative                        | resets per session (UTC day)      |
| `ta.sar`                                                          | simplified variant                | faithful `pine_sar` port          |
| `ta.valuewhen`                                                    | ignored occurrence arg            | indexes the nth prior true        |
| `ta.tr` (bare)                                                    | returned na                       | works as a no-paren variable      |
| `ta.obv/accdist/iii/wvad/wad/nvi/pvi/pvt`                         | na (unimplemented)                | implemented, parity-exact         |
| `ta.range`, `ta.percentile_nearest_rank/linear_interpolation`     | missing                           | added                             |
| `array.percentrank`                                               | missing                           | added                             |
| `array.min/max(nth)`, `stdev/variance/covariance(biased)`, `mode` | ignored 2nd arg / first-on-tie    | honor args / smallest-on-tie      |
| `matrix.add_row/add_col`                                          | ignored the index arg             | insert at index per Pine          |
| `math.round_to_mintick`                                           | missing                           | added                             |
| `barstate.isfirst` / `islastconfirmedhistory`                     | always false                      | correct                           |
| `map.put`                                                         | returned na                       | returns the previous value        |
| `color.red/blue/yellow/black/teal`                                | old v4 palette                    | v6 palette; `olive` added         |
| `plot(series, title, color)`                                      | positional title/color dropped    | honored                           |
| `na(x)` (parser)                                                  | parsed as the truthy `na` literal | the is-na test function           |

## PineTS deviations (piner is correct, matches the manual)

- `ta.bbw` — PineTS returns it ×100; piner returns `(upper−lower)/basis` per the manual.
- `ta.ema` / `ta.macd` — piner seeds with the first value per `pine_ema`; PineTS warms up with an sma seed.
- `ta.crossover` — piner fires per `x[1]<=y[1] and x>y`; PineTS misses a valid cross.
- `bool(comparison)` — PineTS returns true for a false comparison; piner is correct.
- `color.blue` — PineTS still carries the stale v4 `#2196F3`; piner uses the v6 `#2962FF`.

## Deferred (documented, low-frequency or out-of-scope)

- **Warmup-edge only:** `ta.cmo`/`ta.mfi` differ from PineTS at the first valid bar
  (steady state exact); `ta.supertrend` warmup region (steady state and the
  TradingView direction sign — −1=up / +1=down — match).
- **Language:** history on an inline expression `(a+b)[n]` (assign to a var first).
- **Strategy:** OCA groups, `calc_on_every_tick` (deliberate no-op — realtime-only
  on TV, so backtests are unaffected), trailing per-trade comments.
- **No live data/infra:** session/timezone _filtering_ in `time()`/`time_close()`;
  live `syminfo` exchange metadata; cross-symbol/realtime `request.security`;
  `request.*` fundamental data feeds.
