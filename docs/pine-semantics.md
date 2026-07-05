# Pine Script v6 — Semantics Reference

The behaviors the engine must reproduce, distilled from the official v6 docs and
fact-checked during research. This is the **specification** the runtime targets;
every item maps to a mechanism in [`architecture.md`](./architecture.md) §13.

> Confidence tags reflect adversarial verification. `[verified]` = corroborated by
> primary docs; `[OPEN]` = a claim that was refuted or unsettled and must be
> re-checked against the live docs before the corresponding code path is locked.

## 1. Execution model

- **Bar-by-bar execution.** `[verified]` The entire script runs start-to-end
  **once per bar**, from the earliest available bar to the most recent — not once
  over the whole dataset. This is the central loop.
  → [execution-model](https://www.tradingview.com/pine-script-docs/language/execution-model/)
- **Realtime re-execution.** `[verified]` On the realtime (open) bar the script
  runs **repeatedly, once per tick**. Indicators/libraries run on every update;
  strategies without `calc_on_every_tick` run only on bar close.
  → [bar-states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/)

## 2. Series & history

- **The `[]` operator.** `[verified]` `close[0] == close` (current bar),
  `close[1]` is one bar back. A _constant_ offset references **different bars on
  each execution** as the series grows — this is why Pine series ≠ arrays.
  → [execution-model](https://www.tradingview.com/pine-script-docs/language/execution-model/),
  [operators](https://www.tradingview.com/pine-script-docs/language/operators/)
- **Out-of-range = `na`.** `[verified]` Referencing before the first bar returns
  `na`, never an error.
- **Built-in series.** `open/high/low/close/volume/time` (and `hl2`, `hlc3`, …)
  are series filled by the feed each bar.

## 3. `na` (not-available)

- **Arithmetic propagation.** `[verified]` If any operand is `na`, the result is
  `na`. Represented as JS `NaN` (numeric) / an `NA` sentinel (non-numeric).
  Handled explicitly with `na()` / `nz()`.
  → [operators](https://www.tradingview.com/pine-script-docs/language/operators/)
- **Comparisons → `false`.** `[verified]` In v6 `bool` is never `na`, so any
  comparison with an `na` operand (`na < x`, `x == na`, …) yields `false`. piner
  funnels all comparisons through `$.lt/$.le/$.gt/$.ge/$.eq/$.ne` (one place) and
  lints `x == na` / `x != na` (always false → use `na(x)` / `not na(x)`). Pinned by
  the conformance suite.

## 4. Variable persistence

- **Ordinary variables** re-declare every bar. `[verified]`
- **`var`** initializes **once** (globals on first bar; local blocks on first
  execution of that block) and persists across bars until reassigned.
  → [variable-declarations](https://www.tradingview.com/pine-script-docs/language/variable-declarations/)
- **`varip`** additionally persists **within the realtime bar** and **escapes the
  per-tick rollback** that resets `var`.
  → [execution-model](https://www.tradingview.com/pine-script-docs/language/execution-model/)

## 5. Realtime rollback

- `[verified]` Before each realtime tick recalculation, the script's variables,
  expressions, and outputs are **cleared/reset (rollback)**. `varip` variables are
  exempt. (Engine: truncate the series store to the committed length, restore
  built-in state and the `var` store, then replay.)

## 6. Repainting

- `[verified]` On realtime bars, **high/low/close mutate** many times before close
  (only `open` is fixed); historical bars store only **final OHLC** with no
  intrabar tick history. This asymmetry is the root cause of repainting — replay
  the open bar with live tick values and it falls out naturally.
  → [repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/)

## 7. Bar state

- `[verified]` `barstate.isnew` — true on all historical bars + the realtime bar's
  opening tick. `barstate.isconfirmed` — true on all historical bars + the
  realtime bar's **closing** tick (the standard repaint-avoidance discriminator;
  does **not** work inside `request.security()`).
  → [bar-states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/)

## 8. `request.security()` & multi-timeframe

- `[verified]` Returns **confirmed** values on historical bars but possibly
  **unconfirmed** (developing) values on realtime bars — the source of HTF repaint.
- `[verified]` `barmerge.lookahead_on` _without_ an offset leaks future data on
  historical bars (returns the first intrabar of the HTF period); `lookahead_on` +
  `[1]` offset is the **non-repainting** idiom (always last confirmed value).
- **Default lookahead = `barmerge.lookahead_off`** `[verified]` — confirmed against
  the v6 reference (default since v3; v1/v2 defaulted to `lookahead_on`). On
  historical bars `lookahead_off` returns the _last confirmed_ HTF value (no future
  leak); no effect on realtime. piner implements this default (Phase 7).
  → [other-timeframes-and-data](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/),
  [repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/)

## 9. Language surface (coverage scope)

Not individually verified in research — treat as implementation scope, not settled
semantics: `ta.*` library, `plot/plotshape/plotchar/hline/fill/bgcolor`, drawing
objects (`line/label/box/table/polyline/linefill`), `array/matrix/map`
collections, user-defined types & methods, `import`/libraries, the `strategy.*`
backtesting/order model, and `alert`/`alertcondition`.
→ [reference](https://www.tradingview.com/pine-script-reference/v6/),
[built-ins](https://www.tradingview.com/pine-script-docs/language/built-ins/)

### 9.1 `strategy.risk.*` rules

Per the v6 reference + the [Strategies § Risk management](https://www.tradingview.com/pine-script-docs/concepts/strategies/#risk-management)
doc: risk rules apply to the whole strategy, run on every tick/order event, and
cannot be deactivated per-execution. Semantics implemented (broker halt logic in
`runtime/builtins/strategy.ts`):

- **`allow_entry_in(value)`** — `strategy.entry` opens positions only in the
  allowed direction; an entry against it **closes** an open opposite position
  (market order, no reversal) and is a no-op while flat.
- **`max_position_size(contracts)`** — entry quantity is reduced so the resulting
  position never exceeds the cap; an entry with no room is not placed.
- **`max_drawdown(value, type)`** — when peak-to-trough equity drawdown reaches
  `value` (`strategy.cash`, or `strategy.percent_of_equity` = % of maximum
  equity): cancel all pending orders, close the position, halt **permanently**.
- **`max_intraday_loss(value, type)`** — loss measured from the trading day's
  opening equity (the percent form is a share of the day's **maximum** equity, per
  the reference); on breach: cancel, close, halt **until the day ends**.
- **`max_intraday_filled_orders(count)`** — after `count` filled orders in a
  trading day: cancel, close, halt until the day ends.
- **`max_cons_loss_days(count)`** — after `count` consecutive trading days whose
  closing equity finished below their opening equity: cancel, close, halt
  **permanently**.

piner specifics: a "trading day" is the UTC calendar day of bar time (one bucket
per bar above the daily timeframe, per the reference); the emergency close is a
market order filling on the next tick pass (next bar open, or the same-bar close
pass under `process_orders_on_close`); repeated calls to the same rule keep the
most restrictive value; `alert_message` args are accepted and ignored.

## Resolved & remaining

The two semantics that were once `[OPEN]` are **resolved and pinned by tests**:

1. ✅ `request.security()` default lookahead = `barmerge.lookahead_off`
   (non-repainting since v3) — §8; `test/security.test.ts`.
2. ✅ `na` through comparisons → `false` (`bool` never `na` in v6) — §3;
   conformance suite.

Remaining (reference-only, not blocking any code path):

3. PineTS's full language-surface coverage gaps (cross-check reference only; AGPL —
   do not copy code). See [`parity-matrix.md`](./parity-matrix.md).
4. Whether WASM / AST-interpreter back-ends ever beat transpile-to-JS for this
   workload (no benchmark evidence either way).
