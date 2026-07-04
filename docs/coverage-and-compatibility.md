# Pine Script v6 Coverage & fractal-chart Compatibility

Authoritative status of what **piner** supports of Pine Script v6, and how it maps
onto the **fractal-chart** app. Companion to [`compiler-design.md`](./compiler-design.md)
(how the compiler works). Figures are measured, not estimated — see Methodology.

> **TL;DR.** The full Pine v6 _language_ (lexer/parser/semantics, expressions,
> control flow, types, `var/varip`, history, `na`, UDFs, UDTs, enums, collections)
> is implemented, plus the complete _visual_ surface (plots, markers, candles,
> bar/bg color, fills incl. gradient, all drawing objects), inputs (schema +
> overrides), broad `ta.*`/`math.*`/`array.*`/`matrix.*`/`str.*`/`map.*`/`color.*`
> coverage, date/symbol/timeframe builtins, `request.security()`, and the
> `strategy.*` broker. Against the **official Pine v6 reference-manual corpus**,
> **97.8% of single-script examples compile _and run_ end-to-end** (399/408), the codegen and
> interpreter backends agree **byte-for-byte on every corpus script** (0
> divergences), and a **full-language numeric-parity suite vs PineTS** (~120 cases
> across every value-producing namespace + the language core) passes — every
> divergence traced to the v6 manual, where **piner matches the documented formula
> in every case** (and is _more_ correct than PineTS in several). Residual corpus
> failures are deferred features (`matrix.eigenvalues/eigenvectors/pinv`, anchored
> `ta.pivot_point_levels`) or invalid/v2 doc
> fragments. For fractal-chart, piner is an architectural drop-in: Pine source → a
> complete, serializable visual IR that fractal's source-agnostic renderer consumes.

---

## 1. Methodology

Coverage is measured empirically, not estimated. fractal-chart embeds the official
TradingView Pine v6 reference manual (`pinescriptv6/`); we extract every fenced
` ```pine ` example, **compile it with `piner.compile()` and execute it over 60
bars**, and bucket the failures. Running (not just compiling) surfaces missing
built-ins that parse fine but throw at execution. The corpus figures below are
produced by the committed `test/conformance.test.ts` (the per-commit floor +
divergence guard); `/tmp/eval-compat.ts` is a re-runnable scratch harness for
inspecting the raw failure buckets.

| Metric                                                                    | Value                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Reference-manual code blocks                                              | 465                                                                                |
| Full scripts (with `indicator/strategy` decl)                             | 459                                                                                |
| **Single-script examples compile + run OK**                               | **399 / 408 = 97.8%**                                                              |
| Full scripts incl. multi-script doc fences                                | 444 / 459 = 96.7%                                                                  |
| All code blocks (incl. doc fragments)                                     | 446 / 465 = 95.9%                                                                  |
| **Backend divergences across the whole corpus**                           | **0** (codegen ≡ interpreter)                                                      |
| **Numeric parity vs PineTS** (value-producing namespaces + language core) | **~120 cases**, all matching or verified PineTS deviations (piner ≡ the v6 manual) |
| Unit/integration/conformance/parity tests in piner                        | **509 (1 skipped, 0 failing)**, ~98% line coverage                                 |

Three independent verification layers run on every commit:

1. **Two-backend oracle.** Every test compiles to JS _and_ runs the AST interpreter
   over the same bars and asserts byte-for-byte-identical output (`cross-check.test.ts`
   plus the `bothBackends` helper threaded through most suites). This catches any
   lowering/codegen divergence — but not a _wrong-but-consistent_ runtime impl (both
   backends call the same namespace objects), which is why layers 2–3 exist.
2. **Conformance corpus** (`test/conformance.test.ts`). Runs the bundled reference
   manual, enforces a compile+run **floor** and **zero backend divergences**.
   `oneScript` filtering excludes doc fences that concatenate several `//@version=6`
   scripts (a corpus artifact, not a piner gap).
3. **Numeric parity vs PineTS** (`test/parity.test.ts`; see
   [`parity-matrix.md`](./parity-matrix.md)). The same Pine source runs over the same
   bars through piner and **PineTS** (LuxAlgo's TradingView-targeting runtime), and
   plot values are compared bar-by-bar — non-numeric results encoded as numbers
   (`bool → x?1:0`, `string → str.length`, `color → r/g/b/t`, `collection → size/get/sum`).
   **Ground-truth order: the v6 manual is authoritative; PineTS is a cross-check, not
   an oracle.** Where they disagree the manual's documented `pine_*` formula decides —
   and piner matched the manual every time. This pass found and fixed **16 real piner
   bugs** and surfaced **5 PineTS bugs** (see §4.1). This is the **narrowest** layer by
   design: it pins **~134 distinct manual entries (~15% of the 884-entry manual, but
   ~43% of the ~310 entries PineTS can even oracle)** — PineTS has no strategy, drawing,
   `request`, or constant engine, so ~554 entries are structurally off-limits to it and
   are instead proven by layers 1–2. See [`parity-matrix.md`](./parity-matrix.md) for
   the full breakdown.

---

## 2. Pine v6 language coverage

| Area                                                  | Status    | Notes                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lexer (indentation/continuation, literals, operators) | ✅        | full INDENT/DEDENT engine, color/number/string literals                                                                                                                                                                                                                                                                             |
| Operator precedence + expressions                     | ✅        | full table incl. `[]` history, `?:`, `and/or` (lazy); parity-verified `+ - * / %`, comparisons, unary, precedence                                                                                                                                                                                                                   |
| `na` semantics                                        | ✅        | propagation in arithmetic; comparisons → `false` (v6); `==na` lint. **`na(x)` is the is-na _function_** (parser fix — was mis-tokenized as the truthy `na` literal)                                                                                                                                                                 |
| `bool(x)` cast                                        | ✅        | `bool(false)` is `false` (piner correct; PineTS returns `true` for `bool(comparison)`)                                                                                                                                                                                                                                              |
| `var` / `varip` persistence + realtime rollback       | ✅        | snapshot/restore; `varip` escapes rollback; `var` collections deep-cloned in the snapshot                                                                                                                                                                                                                                           |
| History `[]` (series, out-of-range → na)              | ✅        | on variables & built-in series + derived-leaf auto-history. Inline-expression history `(a+b)[n]` deferred (assign to a var first)                                                                                                                                                                                                   |
| Types & qualifier inference                           | ✅ (core) | `const/input/simple/series`; int→float; `bool()` required. `const`/`simple`/`series` also usable as parameter names / identifiers (parser fix)                                                                                                                                                                                      |
| Control flow `if/else/switch/for/for-in/while`        | ✅        | as statements **and** expressions (value = last statement)                                                                                                                                                                                                                                                                          |
| Tuples / destructuring `[a,b] = f()`                  | ✅        | incl. tuple-returning `ta.*`; a bare `[a,b,c]` tuple literal as a statement (e.g. a function's last-line return) is no longer mis-parsed as a destructuring decl                                                                                                                                                                    |
| **User-defined functions**                            | ✅        | call-site inlining/monomorphization; per-call-site state; recursion rejected                                                                                                                                                                                                                                                        |
| User-defined types (UDT) + `.new()` + field access    | ✅        | `type T`, `T.new(...)` (positional/named args + field defaults), field read/assign; both backends build identical instances                                                                                                                                                                                                         |
| `enum` + `input.enum`                                 | ✅        | members resolve to their title constant at compile time                                                                                                                                                                                                                                                                             |
| User `method` (receiver dispatch)                     | ✅        | `recv.m(…)` dispatches user `method`s (on UDTs _and_ built-in types), monomorphized like UDFs — `this`-binding, per-call-site state, chaining. A user method whose name collides with a built-in collection/drawing method (`push`/`get`/…) is reachable only in function form `m(recv, …)`                                         |
| `import` / library `export`                           | ✅        | registry-based (no network/FS) via `compile(src, { libraries })`: exact-version match, functions/UDTs/enums/methods exportable, transitive resolution (depth cap 32) with cycle rejection, enforced export constraints; inline-merged so both backends stay byte-identical. An alias equal to a builtin namespace is a CompileError |

### 2.1 Library import/export — parity notes vs. the TradingView docs

Audited against the official [Libraries](https://www.tradingview.com/pine-script-docs/concepts/libraries/)
page (the doc's own `AllTimeHighLow`, `Point`, `Signal`, and `PivotLabels` examples run verbatim
through both backends — see `test/library-doc-examples.test.ts`). The full documented **feature
surface is supported**: `library()` scripts; `export` of functions, methods, UDTs, enums, **and
constants** (`export NAME = …`, the v6 addition); `import Publisher/Lib/Version [as alias]` with
explicit versions and optional aliasing (namespace defaults to the lib name); transitive imports
(including a library importing a _previous version of itself_); UDT construction/fields/methods;
enum members; and tuple returns.

Resolution is registry-based and pure (no I/O) so the core stays browser-safe and
deterministic. For Node/CLI use, the optional `@heyphat/piner/node` entry point
(`loadLibraryDir`/`loadLibraryManifest`) builds a `LibraryRegistry` from `.pine` files on
disk (`<root>/<publisher>/<lib>/<version>.pine`); it is never bundled into the browser entry.
For async or lazy sources (HTTP/CDN, large trees), `compileAsync(src, { resolveLibrary })`
fetches only the transitively-imported libraries via a caller-supplied provider (browser-safe;
`fsLibrarySource` is a ready-made lazy filesystem provider) and then calls the pure `compile()`.

piner is a near-**permissive superset**: apart from the one deliberate restriction noted below, it
does not reject valid TradingView library code, and by design it accepts a few constructs TradingView
rejects, because the inline-merge model makes imported code behave exactly like local code and piner
uses a coarse (unqualified) type system:

| TradingView rule                                                                                                      | piner                                              | Why                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Qualifier control — a `series` arg to a `simple`-inferred param is an error; `simple`/`series` keywords shape results | accepted / ignored                                 | no qualifier-inference system; imported fns are inlined + monomorphized like local fns |
| Exported fn may not call `input.*()`                                                                                  | accepted (input hoists to the consumer schema)     | export purity not enforced beyond side-effecting global builtins + declarations        |
| Exported fn may not call `request.*()` unless `dynamic_requests=true`                                                 | accepted (piner does not model `dynamic_requests`) | same as above; `request.*` is treated like any other builtin call                      |
| Exported fn may not use non-`const` globals (const globals are allowed)                                               | accepted (const globals allowed too)               | distinguishing const vs. non-const globals needs qualifier analysis                    |
| Exported fn parameter types are mandatory                                                                             | untyped params accepted                            | params are typeless in piner as in local UDFs                                          |

Intentional restriction (the one place piner is _stricter_ than TradingView): an import whose alias
equals a builtin namespace (e.g. the default `ta` alias of `import TradingView/ta/12`) is a
**CompileError** — piner does not implement TradingView's builtin-namespace _extension_. Give the
import an explicit non-namespace alias (`import TradingView/ta/12 as tvta`) to use it.

Exported **methods** with the same name are true overloads when distinguished by receiver type or
arity (each resolves to its own definition). Two exported items that genuinely collide — a duplicate
function/type/enum/constant name, or a method with an identical receiver type _and_ arity — are a
**CompileError** (Pine has no user-defined function overloading).

## 3. Built-in coverage

| Namespace / family           | Status        | Implemented (highlights)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Not yet                                                                                                                               |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ta.*`                       | ✅ broad      | sma, ema, rma, wma, hma, vwma, swma, alma, linreg, rsi, atr, tr (incl. bare `ta.tr`), stoch, macd, bb, kc, bbw, kcw, cci, cmo, cog, mfi, wpr, vwap (session-anchored), dmi, supertrend (TradingView −1=up / +1=down direction sign), sar (faithful `pine_sar`), highest(bars), lowest(bars), change, mom, roc, rising, falling, median, mode, range, rci, variance, stdev, dev, percentrank, percentile_nearest_rank, percentile_linear_interpolation, correlation, tsi, ao, max/min (all-time running), cum, barssince, valuewhen (incl. occurrence), cross/over/under, pivothigh, pivotlow, pivot_point_levels (Traditional/Fibonacci/Woodie/Classic/DM/Camarilla), **obv/accdist/iii/wvad/wad/nvi/pvi/pvt** (no-paren series variables)                                                                                    | — (pivots anchor to the daily period)                                                                                                 |
| `math.*`                     | ✅            | max, min, abs, round, round_to_mintick, pow, sqrt, sign, avg, log, log10, exp, floor, ceil, **sum**, sin/cos/tan/asin/acos/atan/atan2, todegrees/toradians, gcd, factorial, random (deterministic), `pi/e/phi/rphi`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                     |
| `str.*`                      | ✅            | tostring, length, contains, format, split, replace, replace_all, substring, upper, lower, startswith, endswith, pos, trim, repeat, match, tonumber, format_time + **number-format patterns** (`#.##`/`0.00`/`integer`/`percent`/`currency`) + **IANA-tz `format_time`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | exotic DecimalFormat edge cases                                                                                                       |
| `color.*`                    | ✅            | new, rgb, named constants (**v6 palette** + `olive`), r/g/b/t, from_gradient (transparency exact)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `color.rgb` quantizes alpha to a hex byte (minor)                                                                                     |
| `array.*`                    | ✅ broad      | new/new_* (incl. new_line/label/box/table/linefill), push/pop/…/get/set/size/clear, first/last, includes/indexof/lastindexof, sum/avg/min/max (nth), median/mode (smallest-on-tie)/range, stdev/variance/covariance (biased flag), copy/slice/concat/join/fill/sort/reverse, sort_indices, standardize, abs, binary_search(+leftmost/rightmost), percentrank, percentile_*, every/some, `from`                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                     |
| `map.*`                      | ✅            | new, put (returns previous value), get, contains, remove, keys, values, size, clear, copy, put_all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                     |
| `matrix.*`                   | ✅            | new, get/set, rows/columns, elements_count, add_row/add_col (insert at index), row/col, sum/diff (element-wise), avg/max/min/median/mode, copy, transpose, fill, concat, remove_row/col, swap_rows/swap_columns, reshape, submatrix, mult, det, inv, trace, rank, pow, reverse, sort, kron, eigenvalues, eigenvectors, pinv, is_square/is_zero/is_identity/is_diagonal/is_antidiagonal/is_symmetric/is_antisymmetric/is_binary/is_triangular/is_stochastic                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                     |
| `input.*`                    | ✅            | int/float/bool/string/source/color/price/timeframe/symbol/session/time/text_area/enum + **bare auto-typed `input(defval)`** + **schema extraction + override-by-title**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                     |
| Plots & visuals              | ✅            | plot (per-bar color; positional title/color), plotshape/plotchar/plotarrow, plotcandle/plotbar, hline, bgcolor, barcolor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | plotarrow sizing nuances                                                                                                              |
| Fills                        | ✅            | solid, between hlines, **gradient** (top/bottom value+color, args **named or positional**), `linefill`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                     |
| Drawing objects              | ✅            | line, label, box, table, polyline (+ `chart.point`), `.all` arrays, `.copy()`, chart-point setters (`set_first_point`/`set_second_point`/`set_point`/`set_top_left_point`/`set_bottom_right_point`), `set_text_font_family`/`set_text_formatting`/`set_text_wrap`/`set_textalign`/`set_tooltip`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | some set_* property nuances                                                                                                           |
| Date/time                    | ✅            | year/month/dayofmonth/dayofweek/hour/minute/second/weekofyear (leaf + `year(t)` fn), **`dayofweek.<day>` constants** (Sun=1…Sat=7), `timestamp(...)` (numeric / tz / string forms), `time(tf, session, tz)`, `time_close(...)` (**in-session filtering** — `na` outside the session window, evaluated in the given timezone), **`last_bar_time`**, **`timenow`** (deterministic: last-bar close instant), **`time_tradingday`** (UTC midnight of the bar's day)                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                     |
| `syminfo.*`                  | ✅ (from run) | tickerid/ticker/prefix/currency/mintick/**minmove**/**pricescale** (mintick≡minmove/pricescale)/type/…, `prefix()`/`ticker()` function form (parse a tickerid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | live exchange metadata                                                                                                                |
| `timeframe.*`                | ✅            | period, multiplier, **main_period**, in_seconds() (`1M`=2628003s), from_seconds()/change() (functions), **isticks**/isseconds/isintraday/isdaily/…                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                     |
| `barstate.*` / `session.*`   | ✅            | barstate: isfirst, islast, isnew, isconfirmed, ishistory, isrealtime, islastconfirmedhistory; session: `regular`/`extended` consts + **`isfirstbar`/`islastbar`/`isfirstbar_regular`/`islastbar_regular`** (trading-day boundaries)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | last-fed bar is treated as confirmed history; intraday session windows (`ismarket`/`ispremarket`/`ispostmarket`) need a session model |
| `chart.*`                    | ✅            | `chart.point.*` constructors, **`is_standard`** (true) + `is_heikinashi`/`is_renko`/`is_kagi`/`is_pnf`/`is_range`/`is_linebreak` (false on a standard feed), **`bg_color`/`fg_color`**, **`left_visible_bar_time`/`right_visible_bar_time`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | non-standard chart synthesis                                                                                                          |
| `alert` / `alertcondition`   | ✅            | recorded as alert events; `alert(msg, freq)` callable + **`alert.freq_all`/`freq_once_per_bar`/`freq_once_per_bar_close`** constants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | server routing (app concern)                                                                                                          |
| `log.*`, `ticker.*`          | ✅ minimal    | recorded / id-string builders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                     |
| `runtime.*` & casts          | ✅            | `runtime.error(msg)` halts the run; `max_bars_back()` (noop — full history kept); `line()/label()/box()/table()/linefill()/polyline()` type casts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                     |
| **`request.security()`**     | ✅ v1         | same-symbol HTF resampling + sub-evaluation; `lookahead_off`/`on`; tuples; **same-TF is identity (no lag)**; cross-symbol degrades to na                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | realtime re-request                                                                                                                   |
| `request.*` (fundamentals)   | ⚠️ na-stub    | dividends/earnings/splits/financial/economic/quandl/currency_rate/seed/footprint/security_lower_tf return na (no external feed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | real data feeds                                                                                                                       |
| `TradingView/ta` library fns | ⚠️ partial    | `ta.requestUpAndDownVolume(ltf)` provided as a builtin — callable directly as `ta.requestUpAndDownVolume(...)` **without** any `import` (drop the `import TradingView/ta/12` line: its default alias `ta` shadows the builtin namespace and is a CompileError); single-bar volume split by candle direction since there's no intrabar feed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | true lower-TF split needs intrabar data                                                                                               |
| **`strategy.*`**             | ✅ v1         | broker sim: entry/order/close/close_all/exit/cancel (market/limit/stop + **trailing** stops), next-bar-open fills, reverse + pyramiding, sizing/commission/slippage, PnL + trade list + equity curve + max drawdown/run-up, live read-backs, `when`-gating, **per-trade introspection** (`closedtrades`/`opentrades` `.profit(_percent)`/`.entry_price`/`.commission`/`.entry_time`/`.exit_time`/`.max_runup`/`.max_drawdown`/… — only `*_comment`/`exit_id` stay na), **performance stats** (`netprofit_percent`/`openprofit_percent`/`grossprofit_percent`/`grossloss_percent`, `max_drawdown_percent`, `max_runup(_percent)`, `avg_trade(_percent)`, `avg_winning_trade(_percent)`, `avg_losing_trade(_percent)`, `max_contracts_held_all/long/short`, `position_entry_name`), **bare collection stats** (`closedtrades.first_index`, `opentrades.capital_held`), `default_entry_qty`, `convert_to_account`/`symbol` (single-currency identity), **`strategy.risk.*`** (all 6 rules: `allow_entry_in`, `max_position_size`, `max_drawdown`, `max_intraday_loss`, `max_intraday_filled_orders`, `max_cons_loss_days` — cancel/close/halt semantics, per-trading-day buckets) | OCA groups, `calc_on_every_tick`, `margin_liquidation_price` (na — margin not modeled)                             |

### 3.1 Coverage audit (all 7 manual sections)

[`v6-coverage-gap.md`](./v6-coverage-gap.md) is an auto-generated, re-runnable
(`bun scripts/v6-coverage-audit.ts`) name-by-name diff of piner's surface against
**every documented `##` entry** (884) across the manual's 7 sections — Types,
Variables, Constants, Functions, Keywords, Operators, Annotations — classifying each
gap as _fillable now_ vs _deferred_ (needs a data feed/larger subsystem). Current
total: **852/884 = 96.4%**, and **every fillable gap is now closed** (0 fillable
remaining). Keywords/Types/Operators/Annotations are 100%; **Constants is 100%**
(204/204 — `dayofweek.*` day constants, `alert.freq_*`, `backadjustment.*`,
`settlement_as_close.*`, the `plot`/`text`/`label`/`line` style tags, and the FX
currency codes all wired); **Functions is now 100%** (457/457 — the last 6, the
`strategy.risk.*` risk-limit rules, are implemented in the broker). The remaining
32 gaps are exclusively _deferred_ Variables needing a live data feed (`bid`/`ask`,
fundamentals, analyst recommendations, target prices, intraday session state).

A name-by-name diff of piner's implemented surface against **every documented
function header** in the bundled reference manual (884 `##` entries) found the only
real _function_ gaps were small mechanical ones — now closed: `ta.max`/`ta.min`,
`array.new_linefill`, the `matrix.is_*` predicate family + `elements_count`,
`runtime.error`, `max_bars_back` (noop), the `line()/box()/…` type casts,
`strategy.default_entry_qty`, and the drawing chart-point/formatting setters. The
last holdouts — the 6 `strategy.risk.*` risk-limit rules — are now implemented as
broker halt logic, so **every documented function is covered**.

⚠️ **Caveat — the bundled manual is an older v6 snapshot.** It has no
`type_footprint`/`footprint` entry (footprint charts / `request.footprint`), so the
audit can't see features TradingView added after this snapshot. The live
`pine-script-reference/v6/` page is a JS-rendered SPA and can't be fetched as text,
so a definitive diff against the _current_ manual needs an updated export of it. (`piner`
already stubs `request.footprint` → na; the `footprint` UDT itself is not modeled.)

## 4. Empirical corpus — remaining failure buckets

Only ~6 single-script examples still fail, and they are all corpus artifacts (no
failure is a silent wrong-answer — those are caught by §3 parity). Library
`import`/`export` is now **supported** (registry-based; see §2), so it is no longer
a genuine gap:

| Bucket                                                                                                           | ~count | Disposition                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| multiline string literals (`"""…"""`)                                                                            | 0      | ✅ supported — the line-based lexer suspends layout across the delimiters (Pine v6 Apr-2026)         |
| library `import` / `export`                                                                                      | 0      | ✅ supported — registry-based resolver + inline-merge multi-module compilation (see §2)              |
| concatenated multi-script doc fences (`matrix.mult`/`matrix.new<type>` examples)                                 | ~4     | corpus artifact (several `//@version=6` in one fence); filtered by the conformance `oneScript` guard |
| v2/v3 fragments (`study($)`), indented-top-level & pseudo-code (`expr1`, multi-assign, polylines/donut snippets) | ~6     | not valid v6 / not runnable scripts                                                                  |

### 4.1 Parity findings — bugs fixed & PineTS deviations

The full-language parity pass (§1, layer 3) is what turned "compiles and runs" into
"computes the right number." It found bugs in **both** engines; piner matched the v6
manual in every disagreement.

**Real piner bugs found by parity & fixed** (each regression-tested):

| Fix                                                               | Was                                                  | Now                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `request.security` same-TF                                        | returned `close[1]` (lagged)                         | returns `close` (the lookahead_off lag is HTF-only)                |
| `ta.vwap`                                                         | cumulative (never reset)                             | resets per session (UTC day)                                       |
| `ta.sar`                                                          | a simplified variant                                 | faithful port of `pine_sar` (na bar 0, init bar 1, 2-bar lookback) |
| `ta.valuewhen`                                                    | ignored the occurrence arg                           | indexes the nth prior true                                         |
| `ta.tr` (bare, no parens)                                         | silently na                                          | works as a no-paren series variable                                |
| `ta.obv/accdist/iii/wvad/wad/nvi/pvi/pvt`                         | na (unimplemented)                                   | implemented, parity-exact                                          |
| `ta.range`, `ta.percentile_nearest_rank/linear_interpolation`     | missing                                              | added                                                              |
| `array.percentrank`                                               | missing                                              | added                                                              |
| `array.min/max(nth)`, `stdev/variance/covariance(biased)`, `mode` | ignored the 2nd arg / first-on-tie                   | honor the arg / smallest value on ties                             |
| `matrix.add_row/add_col`                                          | ignored the insert index                             | insert at the given index (per Pine)                               |
| `matrix.diff/swap_rows/swap_columns/reshape/submatrix`            | missing                                              | added                                                              |
| `math.round_to_mintick`                                           | missing                                              | added                                                              |
| `map.put`                                                         | returned na                                          | returns the previous value                                         |
| `barstate.isfirst` / `islastconfirmedhistory`                     | always false                                         | correct                                                            |
| `color.red/blue/yellow/black/teal` (+ `olive`)                    | old v4 palette / missing                             | v6 palette                                                         |
| `plot(series, title, color)`                                      | positional title/color dropped                       | honored                                                            |
| `na(x)` (parser)                                                  | parsed as the truthy `na` literal                    | the is-na test function                                            |
| `line/label/box/table.copy`, `set_text_font_family`               | missing (surfaced once `islastconfirmedhistory` ran) | added                                                              |

**Confirmed PineTS-is-wrong, piner-is-right** (left as-is, asserted against the manual):
`ta.bbw` (PineTS returns it ×100), `ta.ema`/`ta.macd` seeding (piner seeds with the
first value per `pine_ema`; PineTS warms up with an sma seed), `ta.crossover` (PineTS
misses a valid cross), `bool(comparison)` (PineTS returns true for a false comparison),
`color.blue` (PineTS still carries the stale v4 `#2196F3`).

**Newly completed (clearing the §3 "Not yet" column).** `matrix.eigenvalues`
(QR/Householder) `/eigenvectors/pinv`, `ta.rci`/`mode`/`pivot_point_levels` (6 types),
`str.*` number-format patterns (`#.##`/`0.00`/`integer`/`percent`/`currency`) and
IANA-timezone `format_time`, `color.from_gradient` transparency (exact), `timestamp(...)`
(numeric/tz/string), `time(tf)`/`time_close(tf)`, `timeframe.in_seconds("1M")`=2628003,
`syminfo.prefix()`/`ticker()` function form, and `strategy.*` trailing stops + per-trade
introspection (`closedtrades`/`opentrades.*`). Parity-exact vs PineTS where it supports
them (`ta.mode`, `timestamp`, `time`, `matrix.eigenvalues`, `from_gradient`); hand-verified
against the manual where PineTS lacks/differs (`ta.rci`, `pivot_point_levels`, the str
currency/percent specs).

**Gap-report sweep — every _fillable_ gap closed (95.7% total).** A pass over the
auto-generated [`v6-coverage-gap.md`](./v6-coverage-gap.md) filled all gaps that
needed no external feed: `ta.pvt`; the `dayofweek.<day>` constants (Sun=1…Sat=7,
constant-folded at compile time); `last_bar_time`/`timenow`/`time_tradingday`;
`syminfo.minmove`/`pricescale`; `timeframe.isticks`/`main_period`; the `chart.is_*`
chart-type flags + `bg_color`/`fg_color` + visible-range bar times; the four
`session.is{first,last}bar(_regular)` flags; the callable `alert` namespace + its
`freq_*` constants; `backadjustment.*`/`settlement_as_close.*`; the `label.style_*`,
`line.style_*` tags + `linefill.all`/`polyline.all`; and the strategy performance
statistics (percent / averages / drawdown-run-up extremes / max-contracts-held /
`position_entry_name` / `closedtrades.first_index` / `opentrades.capital_held`).
Parity-exact vs PineTS where it has them (`ta.pvt` ~1e-11, `dayofweek.*`,
`last_bar_time`, `time_tradingday`); both-backend cross-checked otherwise
(`test/coverage-gaps.test.ts`). The 32 remaining gaps are all _deferred_ — they
need a live data feed or an intraday session model.

See [`parity-matrix.md`](./parity-matrix.md) for the per-namespace coverage matrix and
the full deferred list.

---

## 5. fractal-chart compatibility

**Verdict: architectural drop-in.** fractal feeds **byte-for-byte Pine source**
(scripts are user-authored at runtime), which is exactly what `compile(src)`
accepts, and its renderer is **source-agnostic** — it consumes a flat per-bar
result regardless of who produced it. piner is dependency-free ESM (worker- and
browser-safe). Since the first assessment, the adapter-level blockers (inputs,
per-bar colors, drawings) are **closed**.

### 5.1 The integration seam (main branch, native engine)

| fractal symbol                                                                 | role                                                 | piner mapping                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `registerCustomIndicator(ind)` / `resolveIndicator(id)` (`engine/registry.ts`) | the single registration/lookup chokepoint            | register a `pine:<id>` `IndicatorSpec` whose `compute()` runs piner      |
| `IndicatorComputeResult { values, colors }` (`engine/spec.ts`)                 | per-bar output the renderer draws                    | from `engine.outputs.plots` (`.data` + per-bar `.colors`)                |
| `IndicatorVisualDefinition`                                                    | how to draw each series (line/histogram/hline, pane) | synthesized from piner plot options + `metadata.overlay`                 |
| `ChartIndicatorFieldDefinition` + `ChartIndicator.inputs`                      | settings panel + user values                         | from `metadata.inputs` (schema) + `Engine({inputs})` (override-by-title) |
| `ISeriesPrimitive` (e.g. `BandFillPrimitive`)                                  | custom chart primitives                              | piner `outputs.fills` / `drawings` → primitives                          |
| `CandleBar { time, open…, volume? }` (`core/types.ts`)                         | OHLCV                                                | `toPinerBar`: ms→s/string handling, `volume ?? 0`                        |

### 5.2 Compatibility scorecard (current)

| Dimension                             | Fit                | Note                                                                                              |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| Engine input (Pine source)            | **full**           | `compile(src)` takes real v6 source                                                               |
| Registration / engine seam            | **full**           | `registerCustomIndicator` + `pine:` namespace                                                     |
| Data model (Bar/OHLCV)                | **full** (adapter) | `CandleBar` ↔ `Bar`                                                                               |
| Output → render (plots/markers/hline) | **full**           | `outputs.plots`/`markers`/`hlines` → result + visuals                                             |
| **Per-bar / dynamic colors**          | **full**           | closed — `PlotSeries.colors[]`, `bgcolor/barcolor`                                                |
| **Inputs / settings UI**              | **full**           | closed — `metadata.inputs` + override-by-title                                                    |
| Fills (solid/hline/gradient/linefill) | **full**           | `outputs.fills` (+ gradient) → primitives                                                         |
| Drawing objects                       | **full**           | `outputs.drawings` (line/label/box/table/polyline)                                                |
| Execution placement (browser/worker)  | **full**           | dependency-free deterministic ESM                                                                 |
| Backtest / alerting consumption       | **full**           | same `resolveIndicator → computeHeadless` path                                                    |
| Multi-timeframe (`request.security`)  | **v1**             | same-symbol HTF (Phase 7)                                                                         |
| Strategies (`strategy.*`)             | **v1**             | broker sim via `engine.strategy` (Phase 8; fractal's own backtester stays separate/Pine-agnostic) |
| Pine version                          | **v6 only**        | no v5                                                                                             |

### 5.3 Adapter surface (net new code on fractal)

`toPinerBar` (Bar adapter) · `pinerOutputsToResult` (plots→`IndicatorComputeResult`,
NaN→null, per-bar colors) · `pinerOutputsToVisuals` (plot options + overlay →
`IndicatorVisualDefinition[]`, fills→primitives, drawings→`ISeriesPrimitive`) ·
`metadata.inputs → ChartIndicatorFieldDefinition[]` and user values →
`Engine({inputs})` · a `PineIndicator extends StandardChartIndicator` registered
under `pine:` · a compile cache keyed by source hash. **No piner changes required
for the indicator path** — both engines (Phase 7/8) are now built; only niche
builtins remain.

---

## 6. Roadmap

- **Phase 7 — `request.security()` / multi-timeframe** ✅ (v1): same-symbol HTF
  resampling + sub-evaluation context, `lookahead_off`/`on` repaint semantics,
  tuple requests. Tail: cross-symbol/realtime, other `request.*`.
- **Phase 8 — `strategy.*`** ✅ (v1): broker/order engine — next-bar-open fills,
  reverse + pyramiding, exit brackets, PnL/equity/drawdown via `engine.strategy`.
  Tail: trailing stops, per-trade introspection, OCA, `calc_on_every_tick`.
- **Phase 9 — conformance & hardening** ✅: `test/conformance.test.ts` enforces a
  corpus compile+run floor and **zero codegen↔interpreter divergences** every commit.
  **Full-language numeric parity vs PineTS** (`test/parity.test.ts`, ~120 cases across
  every value-producing namespace + the language core; [`parity-matrix.md`](./parity-matrix.md))
  found and fixed **16 real piner bugs** and confirmed **5 PineTS deviations** where
  piner matches the v6 manual (§4.1). Tail: ULP-level parity vs _TradingView itself_
  (PineTS is the current proxy); hot-path bars/sec benchmarks.
- **Tails (genuine gaps):**
  history on inline expressions, strategy OCA groups + `calc_on_every_tick`, live
  `syminfo` metadata, cross-symbol/realtime `request.security` + real `request.*`
  data feeds.
