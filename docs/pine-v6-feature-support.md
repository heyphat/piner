# Pine Script v6 — feature support matrix (piner)

**The source of truth for what you can write in a Pine script and have piner run it.** Feature
by feature, with the implementation location for each, so you know exactly what's supported,
what's partial, and what's not.

- **Scope:** piner targets **Pine Script v5 + v6**. v4 and older are out of scope (see
  [coverage-and-compatibility.md](./coverage-and-compatibility.md); rationale in the project
  memory). Library `import`/`export` is supported via an in-memory registry (no network/FS).
- **Locations** are file:line under `src/` — e.g. `ta.sma → runtime/builtins/ta.ts:49`. Builtin
  namespaces live in `runtime/builtins/`; the dispatch/runtime is `runtime/context.ts`; the
  language front-end is `parser/parser.ts` + `sema/analyze.ts`; the two execution backends are
  `codegen/emit.ts` (compiled JS) and `interp/interpreter.ts`.
- **Legend:** ✅ supported · ⚠️ partial / caveat · ❌ not supported.
- Companion docs: [coverage-and-compatibility.md](./coverage-and-compatibility.md) (measured
  status + fractal mapping), [v6-coverage-gap.md](./v6-coverage-gap.md) (name-by-name diff vs the
  v6 manual), [parity-matrix.md](./parity-matrix.md) (numeric parity vs PineTS).

---

## How piner works (in brief)

```
Pine source ──► Lexer ──► Parser ──► Semantic analysis ──► ┌─ Codegen (emit.ts)  → JS via new Function ─┐
              (layout    (AST,      (name resolution,      │                                            ├─► ExecutionContext ($)
               tokens)    parser.ts) slot allocation,      └─ Interpreter (interpreter.ts) → walks AST ─┘     runtime/context.ts
                                     type inference;
                                     sema/analyze.ts)
```

1. **Lexer** (`lexer/lexer.ts`) turns source into tokens, emitting `NEWLINE/INDENT/DEDENT` layout
   tokens from indentation (block structure) and gluing continuation lines.
2. **Parser** (`parser/parser.ts`) — recursive descent for statements, Pratt for expressions →
   an AST.
3. **Semantic analysis** (`sema/analyze.ts`) resolves names, assigns **slots** (history columns,
   stateful-builtin sites, var/varip persistence — `sema/slots.ts`), and infers coarse types.
4. **Two execution backends share one runtime.** `compile(src)` produces both a **codegen** path
   (emits JavaScript executed via `new Function`, `codegen/emit.ts`) and an **interpreter** path
   (`interp/interpreter.ts`). Both call into the same `ExecutionContext` (the `$` object,
   `runtime/context.ts`), so they produce **byte-for-byte identical output by construction** —
   this invariant is enforced across the whole test suite.
5. **Runtime.** The `ExecutionContext` holds the series store (`runtime/series.ts` — a columnar,
   polymorphic history store), the TA state, the strategy broker, the drawing pool, and the
   builtin namespaces. Visual output (plots, markers, fills, drawings, alerts) is accumulated
   into a serializable **visual IR** by the `OutputCollector` (`runtime/output.ts`).
6. **Execution.** `Engine` + `Driver` + `ArrayFeed` (`engine/`) run the script bar-by-bar over a
   `Bar[]` feed. fractal-chart consumes the visual IR with its source-agnostic renderer.

`compile()` throws `ParseError` (grammar gap) or `CompileError` (semantic error, with
diagnostics); a clean compile returns `{ main, interpret, metadata, diagnostics }`.

---

## Language features

| Feature                                                        | Status | Location                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `//@version=5` / `=6`                                          | ✅     | `lexer/lexer.ts`                                                                   | v4 and older rejected/out of scope                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `var` / `varip` declarations                                   | ✅     | `parser.ts:273` (`parseVarDecl`)                                                   | persistence via var slots                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Type-annotated decls (`float x =`, `var int n =`)              | ✅     | `parser.ts:273`                                                                    | `int/float/bool/color/string`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Qualified-type decls (`var chart.point p`)                     | ✅     | `parser.ts` (`isTypeStart`)                                                        | dotted/UDT types                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tuple decls / destructuring (`[a, b] = f()`)                   | ✅     | `parser.ts:309` (`parseTupleDecl`)                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `if` / `else if` / `else` (statement + expression)             | ✅     | `parser.ts:429` (`parseIf`)                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `for` / `for...in`                                             | ✅     | `parser.ts:453` (`parseFor`)                                                       | numeric + collection iteration                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `while`                                                        | ✅     | `parser.ts:484` (`parseWhile`)                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `switch` (statement + expression)                              | ✅     | `parser.ts:492` (`parseSwitch`)                                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `break` / `continue`                                           | ✅     | `parser.ts:116` (`parseStatement`)                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Ternary `?:`, `and`/`or`/`not`                                 | ✅     | `parser.ts:523` (`parseTernary`) / `codegen`                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| User functions (`f(x) =>`) + single/multi-line                 | ✅     | `parser.ts:320` (`parseFuncDef`)                                                   | inlined per call site (`sema/inline.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `method` (UDT methods)                                         | ✅     | `parser.ts` (`method` kw)                                                          | dispatch in `context.ts:825` (`method`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| UDTs — `type` defs + fields                                    | ✅     | `parser.ts:364` (`parseTypeDef`)                                                   | incl. `T[]` array / `array<T>` fields                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `enum`                                                         | ✅     | `parser.ts:394` (`parseEnumDef`)                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| History `x[n]` (vars + builtins)                               | ✅     | `sema/analyze.ts`                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Inline / chained history `(expr)[n]`, `f(x)[1]`, `close[1][2]` | ✅     | `sema/analyze.ts`; `series.ts`                                                     | materialized into an auto-history slot at the use site                                                                                                                                                                                                                                                                                                                                                                                                    |
| Non-numeric series history (array/string/UDT `x[n]`)           | ✅     | `runtime/series.ts`                                                                | polymorphic slot store                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `na` semantics + `na()`/`nz()`/`fixnan()`                      | ✅     | `context.ts:687-690`                                                               | na propagates; comparisons with na → false                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import` / `export` (libraries)                                | ✅     | `parser.ts:415`; `sema/library.ts`, `sema/alias.ts`; wired in `engine/compiler.ts` | registry-based (no network/FS): `compile(src, { libraries })`. Exact-version match; functions/UDTs/enums/methods/constants exportable; transitive resolution (depth cap 32) with cycle rejection; export constraints enforced; inline-merged so both backends stay byte-identical. An alias equal to a builtin namespace (e.g. `ta`) is a CompileError — no builtin-namespace _extension_. See `docs/coverage-and-compatibility.md` §2.1 for parity notes |
| Multiline string literals (`"""…"""` / `'''…'''`)              | ✅     | `lexer/lexer.ts` (`scanTokens`/`findTripleClose`/`closeMlString`)                  | Pine v6 Apr-2026; source newlines → `\n`, indentation kept literally, backslash escapes still decoded                                                                                                                                                                                                                                                                                                                                                     |
| Mixed tab/space indentation in continuations                   | ❌     | `lexer/lexer.ts:83`                                                                | rejected; use consistent indentation                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## Series & built-in variables (leaves)

| Feature                                                                                              | Status | Location                        | Notes                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------ | ------------------------------- | ------------------------------------------------------------------------ |
| `open/high/low/close/volume/time`                                                                    | ✅     | `context.ts:331-336`            | `time` is ms epoch (UTC)                                                 |
| `hl2/hlc3/ohlc4/hlcc4`                                                                               | ✅     | `context.ts:338-341`            | derived                                                                  |
| `bar_index`, `last_bar_index`, `last_bar_time`, `time_close`, `timenow`                              | ✅     | `context.ts:337-349`            | `timenow` deterministic (last bar close instant)                         |
| `barstate.*` (isfirst/islast/isrealtime/isconfirmed/…)                                               | ✅     | `context.ts:344`; `barstate.ts` | full-recompute model on static history                                   |
| Date leaves — `year/month/dayofmonth/dayofweek/hour/minute/second/weekofyear`                        | ✅     | `context.ts:421-428`            | UTC                                                                      |
| Date functions — `year(t)`, `time(tf, sess, tz)`, `time_close(…)`, `timestamp(…)`, `dayofweek(t,tz)` | ✅     | `context.ts:404-460`            | session/timezone filtering supported (`na` outside the window)           |
| `syminfo.*` (tickerid/ticker/mintick/pricescale/timezone/…)                                          | ⚠️     | `context.ts:474`                | core fields synthesized; live exchange/fundamental metadata ❌ (no feed) |
| `timeframe.*` (period/multiplier/in_seconds/isintraday/isdaily/change/…)                             | ✅     | `context.ts:483`                |                                                                          |
| `chart.*` (point._, is__, bg/fg color, left/right_visible_bar_time)                                  | ✅     | `context.ts:358`                | visible-range = first/last loaded bar                                    |
| `session.isfirstbar/islastbar(_regular)`                                                             | ✅     | `context.ts:382`                | 24h dataset ⇒ one UTC trading day                                        |
| `session.ismarket/ispremarket/ispostmarket`                                                          | ❌     | —                               | no session model                                                         |
| `ask` / `bid`                                                                                        | ❌     | —                               | no L1 quote feed                                                         |

---

## `ta.*` — technical analysis (`runtime/builtins/ta.ts`)

Stateful, slot-backed. All ✅ unless noted.

| Group                      | Functions (file:line)                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Moving averages            | `sma`@49 `ema`@58 `rma`@67 `wma`@80 `vwma`@414 `swma`@392 `hma`@484 `alma`@690 `vwap`@563                                                                                                                                                                          |
| Momentum / oscillators     | `rsi`@97 `tsi`@225 `ao`@213 `mom`@330 `roc`@333 `cci`@522 `cmo`@500 `cog`@490 `wpr`@533 `mfi`@542 `macd`@438 `stoch`@462 `rci`@900                                                                                                                                 |
| Trend / bands              | `bb`@449 `bbw`@512 `kc`@611 `kcw`@620 `supertrend`@624 (TradingView −1=up / +1=down direction sign) `dmi`@645 `sar`@708 `linreg`@399                                                                                                                               |
| Volatility / range         | `tr`@134 `atr`@144 `stdev`@237 `dev`@247 `variance`@360 `range`@851                                                                                                                                                                                                |
| Highest/lowest/cross       | `highest`@160 `lowest`@169 `highestbars`@179 `lowestbars`@189 `crossover`@274 `crossunder`@281 `cross`@288 `max`@298 `min`@304                                                                                                                                     |
| Cumulative / since / when  | `cum`@309 `sum`@682 `barssince`@314 `valuewhen`@320 `rising`@342 `falling`@350 `change`@259                                                                                                                                                                        |
| Stats                      | `correlation`@199 `median`@369 `mode`@939 `percentrank`@379 `percentile_nearest_rank`@861 `percentile_linear_interpolation`@878                                                                                                                                    |
| Volume                     | `obv`@750 `accdist`@765 `iii`@775 `wvad`@784 `wad`@795 `nvi`@813 `pvi`@827 `pvt`@841                                                                                                                                                                               |
| Pivots                     | `pivothigh`@590 `pivotlow`@600 `pivot_point_levels`@961 ⚠️ (anchored variants partial)                                                                                                                                                                             |
| Library (`TradingView/ta`) | `requestUpAndDownVolume`@673 ⚠️ (a builtin — call `ta.requestUpAndDownVolume(...)` directly, with no `import TradingView/ta/12` line, whose default `ta` alias would shadow the builtin namespace; single-bar volume split by candle direction — no intrabar feed) |

---

## `math.*` (`runtime/builtins/math.ts`) — ✅ all

Constants `pi`@21 `e`@22 `phi`@23 `rphi`@24 · `max`@26 `min`@29 `abs`@32 `round`@35 `pow`@39
`sqrt`@42 `sign`@45 `avg`@48 `log`@51 `log10`@54 `exp`@57 `floor`@60 `ceil`@63 `sin`@68 `cos`@71
`tan`@74 `asin`@79 `acos`@82 `atan`@85 `atan2`@88 `todegrees`@93 `toradians`@96 `random`@107 ⚠️
(seeded/deterministic) `gcd`@114 `round_to_mintick`@125 `factorial`@130

## `str.*` (`runtime/builtins/str.ts`) — ✅ all

`tostring`@110 `length`@119 `contains`@122 `format`@134 `split`@171 `replace`@180
`replace_all`@197 `substring`@207 `upper`@212 `lower`@215 `startswith`@218 `endswith`@221
`pos`@225 `trim`@235 `repeat`@240 `match`@249 (regex) `tonumber`@255 `format_time`@270

## `array.*` (`runtime/builtins/array.ts`) — ✅ all

Constructors `new`@14 `new_float/int/bool/string/color`@15-19 `new_line/label/box/table/linefill`@22-26
`from`@27 · mutation `push`@29 `unshift`@30 `pop`@31 `shift`@32 `set`@34 `insert`@37 `remove`@38
`clear`@36 `fill`@88 `reverse`@41 `sort`@90 `sort_indices`@132 · access `get`@33 `first`@39 `last`@40
`size`@35 `slice`@85 `copy`@84 `concat`@86 `join`@87 `range`@89 `includes`@42 `indexof`@43
`lastindexof`@44 `binary_search(_leftmost/_rightmost)`@47-64 · stats `sum`@71 `avg`@72 `min`@74
`max`@79 `median`@94 `mode`@100 `variance`@109 `stdev`@118 `covariance`@120 `standardize`@139
`abs`@145 `percentile_nearest_rank`@148 `percentile_linear_interpolation`@155 `percentrank`@165
`every`@175 `some`@177

## `matrix.*` (`runtime/builtins/matrix.ts`) — ✅ all

✅ `new`@15 `get/set`@20-23 `rows/columns`@26-27 `add_row/col`@29-58 `row/col`@55-56 `sum`@36
`diff`@42 `copy`@47 `transpose`@50 `avg/max/min/median/mode`@64-89 `fill`@100 `concat`@106
`remove_row/col`@112-120 `swap_rows/columns`@129-136 `reshape`@145 `submatrix`@164 `mult`@182
`det`@203 `inv`@208 `trace`@214 `rank`@221 `pow`@241 `reverse`@254 `sort`@259
`eigenvalues`@276 (QR/Householder) `eigenvectors`@288 `pinv`@309 `kron`@423 `hessenberg`@502
`elements_count`@335 + predicates `is_square/zero/identity/diagonal/…`@339-413

## `map.*` (`runtime/builtins/map.ts`) — ✅ all

`new`@10 `put`@12 `get`@17 `contains`@18 `remove`@19 `keys`@24 `values`@25 `size`@26 `clear`@27
`copy`@28 `put_all`@29

## `color.*` (`runtime/builtins/color.ts`) — ✅ all

`new`@35 (`color.new(na)` → `na`, not a crash) `rgb`@42 `r/g/b/t`@46-58 `from_gradient`@63 · named
`red green blue orange purple yellow white black gray silver lime maroon navy olive teal aqua
fuchsia`@94-110

---

## Inputs — `input.*` (`runtime/builtins/input.ts` + schema in `sema/analyze.ts`)

| Function                                                                    | Status | Location                                                      | Notes                                                                |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `input.int/float/bool/string/color`                                         | ✅     | `input.ts:10-25`                                              | `string` honors `options=` (dropdown)                                |
| `input.source`                                                              | ✅     | `input.ts:22`; `context.ts:712` (`resolveSourceInput`)        | open/high/low/close/hl2/… picker                                     |
| `input.price/timeframe/symbol/session/text_area/time/enum` + bare `input()` | ✅     | schema in `sema/analyze.ts`; `context.ts:203` (source wiring) | schema surfaced as `metadata.inputs`; overrides via `inputOverrides` |

---

## Plots, markers, candles, fills, bar/bg color (visual IR)

| Function                                             | Status | Location                          | Notes                                                                                                      |
| ---------------------------------------------------- | ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `plot(series, …)`                                    | ✅     | `context.ts:776`                  | styles via `PlotNs` (`constants.ts:6`): line/stepline/histogram/cross/area/columns/circles/linebr/areabr/… |
| `plotshape/plotchar/plotarrow`                       | ✅     | `context.ts:782` (`marker`)       | shapes `ShapeNs` `constants.ts:20`; locations `LocationNs` `constants.ts:35`                               |
| `plotcandle` / `plotbar`                             | ✅     | `context.ts:787`                  |                                                                                                            |
| `hline`                                              | ✅     | `context.ts:792`                  | styles `HlineNs` `constants.ts:43`                                                                         |
| `fill` (plots/hlines, per-bar color)                 | ✅     | `context.ts:796`                  | gradient overload detected for **named or positional** args                                                |
| `fill` gradient (`color.from_gradient` / top/bottom) | ✅     | `context.ts:800` (`fillGradient`) |                                                                                                            |
| `bgcolor`                                            | ✅     | `context.ts:804`                  |                                                                                                            |
| `barcolor`                                           | ✅     | `context.ts:807`                  |                                                                                                            |
| `plot(..., offset=)` / Ichimoku-style shifts         | ✅     | `output.ts`                       | forward/back offset                                                                                        |

---

## Drawing objects (`runtime/builtins/drawing.ts`) — ✅

FIFO-capped at 50/type (matching Pine). Method-call form (`id.set_*`) + namespace form both work
(`context.ts:method()`).

| Object          | `.new`                         | Location                   | Setters / notes                                                                     |
| --------------- | ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------- |
| `line`          | `line.new`                     | `drawing.ts:137` (new@147) | `set_xy1/2`, `set_x*/y*`, `set_first/second_point`, `set_color`, style/width/extend |
| `label`         | `label.new`                    | `drawing.ts:197` (new@222) | text, style, color, yloc, size                                                      |
| `box`           | `box.new`                      | `drawing.ts:262` (new@265) | `set_lefttop/rightbottom`, bgcolor, border style/width                              |
| `polyline`      | `polyline.new`                 | `drawing.ts:312` (new@315) | from `array<chart.point>`, `closed`, `fill_color`                                   |
| `linefill`      | `linefill.new`                 | `drawing.ts:324` (new@327) | fill between two lines                                                              |
| `table`         | `table.new`                    | `drawing.ts:338` (new@341) | `table.cell(...)`, position/size/align                                              |
| `chart.point.*` | `from_index/from_time/now/new` | `context.ts:358`           | for polyline/line anchoring (`xloc.bar_index`/`bar_time`)                           |

Constant namespaces (all `constants.ts`): `plot.style_*`@6 `shape.*`@20 `location.*`@35
`hline.style_*`@43 `position.*`@49 `size.*`@61 `format.*`@67 `text.align/wrap*`@71
`xloc`@65/`yloc`@101/`extend`@66/`font`@70/`display`@92/`currency`@76/`barmerge`@85/`scale`@89/
`order`@90/`adjustment`@102/`dayofweek`@82/`alert`@109 (wired onto `$` in `context.ts:187-243`).

---

## `request.*` — multi-timeframe / multi-symbol

| Function                                                                         | Status | Location                                                                                                    | Notes                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.security(sym, tf, expr)` — same-symbol HTF                              | ✅     | `context.ts:527` (`security`/`computeSecurity`@596); intercepted in `emit.ts`/`interpreter.ts`/`analyze.ts` | resamples the chart's own bars; no-repaint `lookahead_off`                                                                                               |
| `request.security(...)` — cross-symbol                                           | ✅     | `context.ts:657` (`computeCrossSecurity`)                                                                   | piner is data-agnostic: declares the dep (`out.securityRequests`); the **host injects** bars via `ctx.securityBars["<sym>"]`. Without injection → `na`   |
| `request.security_lower_tf(sym, tf, expr)` — intrabar                            | ✅     | `context.ts:545` (`securityLowerTf`)                                                                        | buckets host-injected lower-TF bars per chart bar; scalar → array, tuple → tuple-of-arrays. Inject under `ctx.securityBars["<sym>@<tf>"]`; absent → `[]` |
| `request.dividends/earnings/splits/financial/economic/quandl/currency_rate/seed` | ❌     | `context.ts:274-283`                                                                                        | return `na` — no fundamental/alternative-data feed                                                                                                       |

> In fractal-chart, the host (data-acquisition) side of `request.security[_lower_tf]` is wired in
> `modules/indicators/pine/security-data.ts` + the live render path; see
> `dev-docs/piner-request-security-plan.md`.

---

## `strategy.*` — backtester broker (`runtime/builtins/strategy.ts`)

| Feature                                                                                      | Status | Location                                                                | Notes                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy(title, …)` config                                                                  | ✅     | `strategy.ts:132` (`configure`); `context.ts:328` (`configureStrategy`) | `initial_capital`, `default_qty_type` (fixed/cash/percent_of_equity), `commission_*`, `pyramiding`, `slippage`, `process_orders_on_close` |
| `strategy.entry` / `strategy.order`                                                          | ✅     | `strategy.ts:446-448`                                                   | market/limit/stop/stop-limit; reverse on opposite                                                                                         |
| `strategy.close` / `close_all`                                                               | ✅     | `strategy.ts:450-452`                                                   |                                                                                                                                           |
| `strategy.exit` (profit/loss/stop/limit/trail)                                               | ✅     | `strategy.ts:453`                                                       | tick-denominated brackets, OCA                                                                                                            |
| `strategy.cancel` / `cancel_all`                                                             | ✅     | `strategy.ts:462-463`                                                   |                                                                                                                                           |
| Constants `strategy.long/short/fixed/cash/percent_of_equity/commission.*/oca.*/direction.*`  | ✅     | `strategy.ts:437-444`                                                   |                                                                                                                                           |
| State `strategy.position_size/position_avg_price/equity/netprofit/opentrades/closedtrades/…` | ✅     | `strategy.ts` (broker getters/`tradeStat`@162)                          | report via `StrategyBroker`                                                                                                               |
| Fill timing                                                                                  | ✅     | `strategy.ts`                                                           | next-bar-open (or same-bar-close with `process_orders_on_close`)                                                                          |
| Per-trade introspection (`strategy.closedtrades.profit(i)` etc.) + performance stats         | ✅     | `strategy.ts:162` (`tradeStat`)                                         | `.profit/.entry_price/.exit_price/…` per trade; `*_percent`, averages, drawdown/run-up extremes, `position_entry_name`                    |

---

## Alerts & logging

| Function                           | Status | Location                         | Notes                                                      |
| ---------------------------------- | ------ | -------------------------------- | ---------------------------------------------------------- |
| `alert(msg, freq)`                 | ✅     | `context.ts` (`alert` namespace) | recorded to the alert IR; `alert.freq_*` constants resolve |
| `alertcondition(cond, title, msg)` | ✅     | `context.ts:816`                 |                                                            |
| `log.info/warning/error`           | ✅     | `context.ts:250`                 | tagged into the alert stream                               |

In fractal, these dispatch **live only** (newest closed bar); in a backtest/headless run they're
captured but not dispatched.

---

## Not supported / deferred (explicit)

| Feature                                                                                         | Status | Why                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Pine **v4 and older**                                                                           | ❌     | out of scope — deprecated, divergent dialect (use TradingView's converter)                                 |
| Library `import` / `export`                                                                     | ✅     | supported — in-memory library-source registry + namespace resolution (see the `import`/`export` row above) |
| Mixed tab/space indentation (continuations)                                                     | ❌     | rejected by the lexer; use consistent indentation                                                          |
| `ta.pivot_point_levels` anchored variants                                                       | ⚠️     | partial                                                                                                    |
| Fundamental/alternative data (`request.dividends/earnings/financial/…`, `syminfo` fundamentals) | ❌     | no data feed → `na`                                                                                        |
| `ask`/`bid`, `session.ismarket/ispre/ispost`                                                    | ❌     | no L1 quote feed / session model                                                                           |
| Tick-level / realtime repainting nuances                                                        | ⚠️     | static history uses a full-recompute model; `barstate.isrealtime` only meaningful with a live feed         |

---

## Verifying & extending

- **Measured coverage:** ~96% of the v6 reference-manual corpus compiles+runs; both backends agree
  byte-for-byte; numeric parity vs PineTS passes. See
  [coverage-and-compatibility.md](./coverage-and-compatibility.md) and
  [v6-coverage-gap.md](./v6-coverage-gap.md) (846/884 manual entries).
- **Real-script corpus:** `test/pinescripts/corpus/` + `test/corpus.test.ts` run real third-party
  scripts and classify each by failure stage (parse/sema/runtime/divergence/pass), excluding
  pre-v5 as `legacy`. Drop a `.pine` file in to add it.
- **Authoring examples:** `test/pinescripts/*.pine` (each verified to compile + run).

> Keep this doc in sync when adding/removing builtins or language features — it's the contract a
> script author relies on.
