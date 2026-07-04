# The strategy broker — `src/runtime/builtins/strategy.ts`

How piner's `strategy.*` backtesting engine works: a **deterministic broker
simulator** that lives entirely in the shared runtime, so the codegen and
interpreter backends drive the exact same trading logic (the two-backend
byte-for-byte invariant holds for strategies by construction).

Everything here is implemented clean-room from the public TradingView v6
reference + [Strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/)
docs. The v6 semantics being targeted are summarized in
[pine-semantics.md](./pine-semantics.md) (§9.1 for the risk rules); the
per-feature status table is in
[pine-v6-feature-support.md](./pine-v6-feature-support.md).

---

## 1. Where it sits

```
Pine script            strategy.entry("L", strategy.long, qty = 2)
                                        │
codegen (emit.ts) ── strategyCall() ────┤   both backends bind args by name w/
interp (interpreter.ts) ─ strategyCall()┤   positional fallback + `when` gate
                                        ▼
makeStrategyNs($.strategy)   ← facade: coercion (na→undefined), constants,
                                        live read-back getters, risk namespace
                                        ▼
StrategyBroker ($.strategyBroker)  ← ALL trading state & logic (this file)
        ▲                    ▲
        │ onStrategyBar()    │ report(), snapshot()/restore()
   Driver (engine/driver.ts) — per-bar hooks + realtime rollback
```

- **One broker per `ExecutionContext`** (`context.ts` constructor wires
  `strategyBroker.host = this` and builds the facade). The broker reads market
  data only through the tiny `StrategyHost` interface — the current bar's
  `open/high/low/close/time/idx`, the instrument `mintick`, and `tradingDayKey`
  (the risk rules' trading-day bucket). No other engine coupling.
- **Activation.** The broker starts `active = false` (every entry point no-ops,
  so `strategy.*` calls in an `indicator()` script are inert). At run start the
  engine reads the compiled script's metadata — the `strategy(...)` declaration
  args resolved at compile time — and calls `configureStrategy(settings)`
  (`engine.ts`), which flips `active` and seeds the equity extremes.
- **Both backends, one broker.** `emit.ts` emits `$.strategy.entry(...)` calls;
  the interpreter calls the same facade functions. Two-level calls
  (`strategy.closedtrades.profit(i)`, `strategy.risk.max_drawdown(...)`) are
  routed by both backends through shared tables in `codegen/intrinsics.ts`
  (`STRATEGY_RISK_PARAMS` for risk-rule arg binding), so argument slotting can't
  diverge.

## 2. Execution model — when things fill

Pine's default model: the script body runs once per bar (conceptually at bar
close) and **queues** orders; the broker emulator fills them afterwards. piner
reproduces that with two driver hooks around the script body:

```
for each bar i:
    beginBar(i)
    $.onStrategyBar()        ← riskRollDay() + processTick(open, high, low, open)
    main($)                  ← script body queues/updates orders & brackets
    $.onStrategyBarClose()   ← only with process_orders_on_close:
                               processTick(close, close, close, close)
    commitBar()
```

- **`onBar()` — the main fill pass.** Runs BEFORE the script body, against the
  new bar's full range, with market orders filling at the bar's **open**. An
  order queued on bar *N* therefore fills at bar *N+1*'s open — TradingView's
  "fills at next bar open" rule.
- **`onBarClose()` — `process_orders_on_close`.** An extra fill pass AFTER the
  script body, treating the bar's close as a one-price tick (`o=h=l=c`). Market
  orders created this bar fill at the same bar's close. Limit/stop orders and
  brackets are checked against the close price ONLY — the bar's earlier range
  predates those orders and must not fill them.
- **Realtime ticks** run the same sequence (`Driver.onTick`), so orders can fill
  intrabar on live ticks; correctness across speculative ticks comes from
  rollback (§9).

Within one `processTick(o, h, l, marketPx)` pass, the steps are ordered:

1. **Pending orders** — fill or keep each queued order (§4).
2. **Exit brackets** — walk the tick's range against every armed bracket (§5).
3. **Risk: filled-orders cap** — `max_intraday_filled_orders` check (§8).
4. **Mark-to-market** — equity curve + drawdown/run-up extremes along the
   intrabar path, then the equity-based risk rules (§7, §8).

## 3. Data model

| Type | Role |
| --- | --- |
| `StrategySettings` | `strategy()` declaration args: `initialCapital`, sizing (`qtyType`: fixed / cash / percent_of_equity + `qtyValue`), commission (percent / cash_per_contract / cash_per_order), `pyramiding`, `slippage` (ticks), `processOrdersOnClose`. |
| `Order` (private) | One queued order: `id`, `dir` (+1/−1), optional `qty`, `kind` (`entry` \| `order` \| `close` \| `closeAll`), `otype` (`market` \| `limit` \| `stop` \| `stoplimit`), trigger `price`, stop-limit's resting `limit`, and the stop-limit `triggered` latch. |
| `ExitBracket` (private) | One `strategy.exit()` call: `id`, `fromEntry` (`''` = every entry, current and future), qty cap, tick-denominated `profit`/`loss`, absolute `stop`/`limit`, trailing `trailPrice`/`trailPoints`/`trailOffset` + the ratcheting `trailStop`, and `filled` progress. |
| `Lot` (private) | One open entry: `id`, remaining unsigned `qty`, its own fill `price`, fill `bar`, and the carried entry-side commission `fee`. **The position is the list of lots**; `size` is the signed aggregate. |
| `ClosedTrade` | One ledger row per entry→exit pair: ids, direction, qty, both prices/bars, net `profit`, running `cumProfit`. |

**Why lots?** TradingView books one trade row per *entry*, closes FIFO, and
measures per-entry exit levels (`profit`/`loss` ticks) from each entry's own
fill price. Keeping the position as per-entry lots makes `strategy.close(id)`,
`strategy.exit(from_entry=…)`, partial closes, and per-trade introspection all
resolve against the right entry with one mechanism.

### Order construction

`orderTrigger(limit?, stop?)` maps `strategy.entry/order` args to the order
type: both → **stop-limit** (the stop arms a resting limit), stop only →
**stop**, limit only → **limit**, neither → **market**.

## 4. Order lifecycle

### Submission (script-side, via the facade)

- Every order function is **`when`-gated** (the deprecated-but-supported `when`
  arg: anything but `false` submits) and coerces `na` numeric args to "not set".
- `entry`/`order` are **keyed by id**: re-submitting an id replaces the unfilled
  pending order in place (Pine's order-modify semantics). `close`/`close_all`
  append (market orders, can't be modified).
- `exit` is keyed by id too — re-submitting updates the bracket in place while
  **preserving the trailing-stop ratchet** (`trailStop` carries over).
- `cancel(id)` removes pending orders *and* brackets with that id — but never
  market orders (they execute on the next tick regardless, per Pine).
  `cancel_all()` likewise spares in-flight market orders.
- Submissions are rejected while a **risk halt** is active (§8).

### The fill pass (`processTick` step 1)

For each pending order, against the tick's range `[l, h]` starting at `o`:

| Type | Fill rule |
| --- | --- |
| market | Fills at `marketPx` (the pass's open) ± adverse slippage. |
| limit (buy) | Gap through the price (`o <= p`) fills at the **better** open; else fills at `p` when `l <= p`. Sell mirrored. No slippage (limits fill at their price or better). |
| stop (buy) | Gap through (`o >= p`) fills at the open **plus adverse slippage**; else at `p` + slippage when `h >= p`. Sell mirrored. |
| stop-limit | The stop trigger arms a resting limit (`triggered = true`) — which may still fill on the SAME tick at the limit price. A limit resting since a *prior* tick also gets the open-gap improvement, like any limit order. |

Slippage is `settings.slippage × mintick`, always applied in the adverse
direction of the *taker* (for a close, the direction that exits the position).

### Execution semantics (`execute`, wrapped by `fill`)

Once an order fills at `price`:

- **`closeAll`** → close the whole position (optionally capped at `qty`).
- **`close`** → close only the quantity opened under that entry id (FIFO within
  the id); a no-op if the id holds nothing open — including pyramided adds whose
  id isn't the first entry's.
- **`entry`** —
  1. `strategy.risk.allow_entry_in` check: a disallowed-direction entry never
     opens; against an open opposite position it *closes* it (no reversal),
     while flat it's a no-op (§8).
  2. Opposite direction → **reverse**: flatten first, then open the full
     quantity.
  3. Same direction → **pyramiding cap**: at most `settings.pyramiding`
     same-side entry adds per position (`entryCount` is a real count, so
     `pyramiding = N` admits exactly N adds). `strategy.order` is uncapped,
     matching TradingView.
  4. `strategy.risk.max_position_size` clamps the quantity to the remaining
     room; no room → the order is dropped (§8).
- **`order`** — **nets**: an opposite-direction fill reduces the position; a
  crossing remainder opens the flip. No pyramiding cap, no reverse shortcut.

Quantity defaults to the sizing settings when the order didn't specify one
(`defaultQty`): `fixed` → `qtyValue` contracts; `cash` → `qtyValue / price`;
`percent_of_equity` → `qtyValue% × equity / price`.

### Commission

`commission(qty, price)`: `percent` → `value% × qty × price`;
`cash_per_contract` → `value × qty`; `cash_per_order` → flat `value`.

- The **entry-side** fee is charged to `realized` at fill time and carried on
  the lot (`Lot.fee`), then pro-rated back into each trade row's profit as the
  lot closes — so per-trade `profit` nets both sides' commission without
  double-charging `realized`.
- The **exit-side** fee is one order-level fee per closing order, pro-rated
  across the trade rows it books (a `close_all` over three lots books three
  rows but pays one order's fee).

## 5. Exit brackets (`strategy.exit`)

Checked each pass against the tick's range (`processExits`), only while a
position is open.

- **Per-lot exits.** Each eligible lot (`fromEntry` filter, `''` = all) gets its
  own exit order: tick-denominated levels are measured from *that lot's* fill
  price — `stop = lot.price − dir·loss·mintick`, `limit = lot.price +
  dir·profit·mintick`. Absolute `stop`/`limit` prices are shared across lots.
- **Relative + absolute on the same side** (`loss`+`stop`, `profit`+`limit`):
  the level expected to trigger FIRST wins — the one nearer the market (long
  stop: the higher of the two; long limit: the lower). This is `firstOf`.
- **Gap fills pre-empt the path.** If the tick *opens* through a level, the fill
  happens at the open (stop: worse, plus slippage; limit: better) before any
  intrabar logic.
- **Intrabar ordering heuristic.** When both the stop and limit levels are
  inside the bar's range, the extreme **nearer the open is assumed hit first**
  (`highFirst = h − o < o − l`): for a long, the stop lives on the low side, so
  the stop fires first exactly when the low is nearer the open.
- **Quantity cap.** `qty` caps the bracket's total fills across lots
  (`filled` accumulates). A bracket is *spent* once it has filled its cap or
  exhausted its eligible lots; one with no matching lots yet (its `from_entry`
  hasn't filled) stays armed and waits for the entry.

### Trailing stops (`trail_price` / `trail_points` + `trail_offset`)

`trailFill` walks the tick's assumed intrabar path — **open → nearer extreme →
farther extreme → close** — with three interleaved steps at each path point:

1. **Hit check first**: if armed and the point crosses the ratcheted stop, fill
   at the stop level (or at the open on an opening gap-through).
2. **Arm**: un-armed brackets arm when the path reaches the activation level
   (`trail_price`, or entry avg ± `trail_points`·mintick).
3. **Ratchet**: once armed, the stop trails `trail_offset` ticks behind each
   favorable price, monotonically.

Because the walk is ordered, a low that occurs *before* arming can't trigger,
and the ratchet can't use an extreme the path hasn't reached yet. The ratchet
(`trailStop`) persists across bars and across `strategy.exit` re-submissions.

> Deviation: the trailing stop is evaluated against the **position-aggregate**
> average price for activation, and its fill closes eligible lots as one group
> order (one order-level fee, pro-rated) — TradingView models trailing per
> entry.

## 6. Position accounting

`closePosition(price, qty?, entryId?)` consumes lots FIFO (optionally
restricted to one entry id), booking one `ClosedTrade` row per lot touched via
`closeLot`:

- `profit = dir·(price − lot.price)·take − exitFee − entryFeeShare` — both
  commission sides netted into the row.
- Win/loss/even counters, `grossProfit`/`grossLoss`, and `realized` update as
  rows book; `cumProfit` snapshots running realized PnL.
- A partially-closed lot keeps its remaining `qty` (and remaining carried fee);
  `avgPrice` is derived from the surviving lots, so a partial FIFO close
  re-prices the remainder exactly as TradingView does.
- When the position empties (float-tolerant, `≤ 1e-9`), everything resets:
  `size`, `entryId`, `entryCount`, lots — **and all exit brackets are dropped**
  (they belong to the closed position).

## 7. Mark-to-market, equity & statistics

Equity is always `initialCapital + realized + openProfit`, where `openProfit`
marks the open position against the current bar's close.

`markToMarket` runs at the end of every fill pass:

- Writes `equityCurve[barIndex]`.
- Computes the bar's **intrabar equity path** — the position marked at each of
  open → nearer extreme → farther extreme → close — because TradingView derives
  drawdown/run-up extremes from intrabar equity, not just closes.
- Updates `peakEquity`/`valleyEquity` and the four extremes (`maxDrawdown`,
  `maxDrawdownPercent` — % of the running peak, `maxRunup`,
  `maxRunupPercent` — % of the running valley) at every path point.
- Records peak exposure (`maxContracts*`), then hands the path to the risk
  rules (§8).

**Read-backs & stats** (facade getters → broker):

- Live: `position_size`, `position_avg_price` (na while flat), `equity`,
  `openprofit`, `netprofit`, `grossprofit`/`grossloss`,
  `wintrades`/`losstrades`/`eventrades`, `opentrades` (one per lot),
  `closedtrades`, `position_entry_name` (the entry that *initially* opened the
  position; survives partial closes).
- Performance: the `*_percent` family (basis: initial capital),
  `max_drawdown(_percent)`, `max_runup(_percent)`, `avg_trade(_percent)`,
  `avg_winning_trade(_percent)`, `avg_losing_trade(_percent)` (per-trade %
  basis: `|entryPrice × qty|`), `max_contracts_held_all/long/short`.
- Per-trade introspection: `tradeField('closedtrades'|'opentrades', field, i)`
  serves `strategy.closedtrades.profit(i)` / `.profit_percent(i)`,
  `.entry_price(i)` / `.exit_price(i)`, `.entry_bar_index(i)` /
  `.exit_bar_index(i)`, `.entry_time(i)` / `.exit_time(i)` (fill-bar times
  stamped at fill), `.size(i)` (signed), `.entry_id(i)`, `.commission(i)` (both
  sides' fees on the row; open trades report the carried entry fee),
  `.max_runup(i)` / `.max_drawdown(i)` (+`_percent`) — per-lot intrabar
  favorable/adverse excursions tracked each mark-to-market as per-contract price
  moves (so partial closes scale correctly), the lot's life ending at its exit
  fill — and `.cumprofit(i)`. Open trades mark `profit` against the current
  close. Still na: `entry_comment`/`exit_comment`/`exit_id` (order comments not
  plumbed).
- Bare collection stats: `tradeStat` serves `closedtrades.first_index` (0 once
  any trade closed) and `opentrades.capital_held` (open cost basis).
- Convenience (not Pine builtins, used by the engine report/hosts):
  `profitFactor`, `winRate`, `defaultQty`, `report()` — the typed
  `StrategyReport`: initial capital, PnL aggregates, win/loss/even counts, max
  drawdown (+%), `totalCommission` (both sides, TradingView's "Commission
  Paid"), the trade list (each row carries fill times, its commission, and its
  trade-life run-up/drawdown), the equity curve, and the exposure counters
  (`barsProcessed` / `barsInMarket` — a bar is *in market* when a position is
  open after its `onBar` fill pass).

### 7.1 Derived risk-adjusted metrics (`computeStrategyMetrics`)

`src/engine/strategy-metrics.ts` — a **pure reduction of the `StrategyReport`**
(plus bar times / timeframe for annualization) computing the tearsheet family:
**Sharpe, Sortino, annualized volatility, CAGR, Calmar, exposure %, expectancy,
max consecutive wins/losses, largest win/loss, avg bars per trade, and the
buy-&-hold benchmark** (`buyHoldReturnPercent` + `outperformance`, entering at
the second bar's open to mirror next-bar-open fills — pass `bars`). Exposed as
`Engine.strategyMetrics(opts?)` and exported standalone for hosts that persist
reports (pinestack's pinerun, fractal-chart's adapter).

Deliberate boundaries:

- **Not Pine builtins.** TradingView shows these in the Strategy Tester UI, not
  in the Pine language — the `strategy.*` namespace stays TV-exact.
- **Report analytics, not broker state.** Only the exposure *counters* live in
  the broker (they need per-bar observation); everything else derives from the
  report at call time. `report()` stays broker-verbatim.
- **No market-calendar policy.** Annualization resolves as: the host's
  `periodsPerYear` override (e.g. fractal-chart's 252×6.5h US-equity table) →
  empirical bars-per-year from real bar times (365.25-day years) → the
  timeframe treated as a 24/7 market → 252. `riskFreeRate` (annual, default 0)
  is subtracted per period.

Method (kept compatible with fractal-chart's `stats.ts` given the same
`periodsPerYear`): per-bar simple equity returns *including flat bars* (dropping
idle bars inflates Sharpe); Sortino's downside deviation is the RMS of negative
returns over the downside count, `Infinity` when there's no downside and the
mean is positive; CAGR prefers the real bar-time span; Calmar = CAGR % / the
broker's intrabar-path `maxDrawdownPercent`; expectancy = mean closed-trade
profit; an even trade breaks both win and loss streaks.

## 8. `strategy.risk.*` — risk-management rules

All six documented rules are implemented as broker halt logic. Rules are
declared with `simple` args, so the script re-calls the setters every bar —
setters are **idempotent**, and repeated calls to the same rule keep the **most
restrictive** value (`riskMin`). `alert_message` args are accepted and ignored.
Per the v6 docs: rules apply to the whole strategy, run on every tick/order
event, and cannot be deactivated per-execution.

**The trading-day bucket** comes from `StrategyHost.tradingDayKey`: the UTC
calendar day of bar time on daily-or-faster timeframes, **one bucket per bar**
above daily ("per 1 bar, if chart resolution is higher than 1 day").
`riskRollDay()` runs at each `onBar` before the fill pass: on a day change it
resets the intraday counters/baselines (day-start equity, day-max equity, fill
count) and scores the day that just closed for `max_cons_loss_days`.

**Halts.** Two flavors, one gate (`riskHaltActive`):

- *Permanent* (`riskHalted`) — `max_drawdown`, `max_cons_loss_days`.
- *Until day end* (`riskHaltedDay` = the current day key; expires when the day
  rolls) — `max_intraday_loss`, `max_intraday_filled_orders`.

While a halt is active every submission (`entry`/`order`/`close`/`close_all`/
`exit`) is rejected at the facade→broker boundary.

**Tripping** (`riskTrip`): cancel *every* pending order and exit bracket, and —
if a position is open — queue one emergency `closeAll` **market order**, which
fills on the next tick pass like any market order (next bar's open, or the
same-bar close pass under `process_orders_on_close`). The emergency close
itself bypasses the submission gate (it's created inside the broker).

Per rule:

| Rule | Trigger | Halt |
| --- | --- | --- |
| `allow_entry_in(value)` | Not a halt — an execution-time filter on `entry` fills: disallowed direction closes an open opposite position (market, **no reversal**) and is a no-op while flat. `strategy.order` is unaffected. | — |
| `max_position_size(contracts)` | Not a halt — clamps each `entry` fill's qty to the remaining room (`cap − |size|`); no room → order dropped. Reversals flatten first, so the flip gets the full cap. | — |
| `max_drawdown(value, type)` | `maxDrawdown ≥ value` (cash) or `maxDrawdownPercent ≥ value` (% of maximum equity) — checked after every mark-to-market, i.e. against the intrabar equity path. | permanent |
| `max_intraday_loss(value, type)` | Loss measured from the **day's opening equity** along the intrabar path; the percent form's threshold is `value%` of the **day's maximum equity** (both per the v6 reference). | day |
| `max_intraday_filled_orders(count)` | `riskDayFills ≥ count`, checked after each pass's fills. Fill counting: one per executed order (`fill` wraps `execute` and counts only when state actually changed — a blocked/no-op order is not a fill), plus one per exit-bracket lot close (each lot's exit is its own order). | day |
| `max_cons_loss_days(count)` | At day rollover: a day whose closing equity (`riskBarCloseEquity`) finished below its opening equity extends the streak; otherwise the streak resets. Streak reaching `count` trips. | permanent |

**Check ordering inside a pass** (§2): fills happen first, then the
filled-orders cap, then mark-to-market runs the equity rules while updating the
day-max equity point-by-point along the path (so a percent-loss breach earlier
in the bar can't see a day-max the path hasn't reached yet).

Known approximations (documented deviations from TradingView's tick engine):

- Breaches detected at bar *N*'s mark-to-market close the position at bar
  *N+1*'s open (piner's standing next-tick fill rule); TV's 4-tick OHLC walk can
  close at a later tick of the same bar.
- Orders already in the same pass's queue can still fill after the
  filled-orders cap is crossed mid-pass (TV has the same property for same-tick
  price-triggered orders).
- Trailing-group exits count one fill per lot closed.

## 9. Realtime rollback

The driver snapshots all mutable engine state after each committed bar and
**restores it before every realtime tick** (`Driver.onTick` → `rollback()`), so
replaying/replacing the open bar's ticks can never double-fill or leak state.
The broker participates via `snapshot()`/`restore()` with a three-way field
taxonomy chosen so rollback stays correct *without* deep-cloning the
ever-growing history arrays on every tick:

| Class | Fields | Copy strategy |
| --- | --- | --- |
| `SNAP_DEEP` | `pending`, `exits`, `entryLots` | `structuredClone` — element objects mutate in place (orders latch `triggered`, brackets ratchet `trailStop`/`filled`, lots shed `qty`/`fee`). |
| `SNAP_APPEND` | `closedTrades`, `equityCurve` | shallow `slice` — append-only, rows never mutated after booking. |
| `SNAP_SCALARS` | position/PnL/extremes scalars **and all `risk*` settings + runtime state** | direct assignment. |

The risk state being in the snapshot is what makes a halt tripped on a
*speculative* tick roll back cleanly when the real closing tick arrives
(covered by `test/strategy-risk.test.ts`).

> Adding a mutable field to the broker? It MUST go into one of the three
> `SNAP_*` lists (deep if its objects mutate in place), or realtime replays will
> leak it.

## 10. The facade (`makeStrategyNs`)

The object exposed as `$.strategy` to both backends:

- **Constants**: `long`/`short` (±1), sizing tags (`fixed`, `cash`,
  `percent_of_equity`), `commission.*`, `oca.*` (accepted; OCA groups are not
  yet modeled), `direction.*` (feeds `allow_entry_in`).
- **Order functions** with `when`-gating and na-coercion (§4).
- **`risk.*`** — the six rule setters (§8).
- **Read-back getters** and stats (§7), plus `account_currency` (fixed `'USD'`;
  piner is single-currency — `strategy.convert_to_account/symbol` are identity
  passthroughs in the backends) and `margin_liquidation_price` (na — margin is
  not modeled, matching Pine when no `margin_long/short` is declared).

Backend routing specifics (`emit.ts` / `interpreter.ts`, kept mirror-identical):

- `strategy.<fn>(...)` → `strategyCall`: binds each documented arg by name with
  a positional fallback at Pine's documented index.
- `strategy.closedtrades.X(i)` / `strategy.opentrades.X(i)` → `tradeField`;
  the bare `first_index`/`capital_held` members → `tradeStat`.
- `strategy.risk.X(...)` → `$.strategy.risk.X(...)` with args slotted through
  the shared `STRATEGY_RISK_PARAMS` table; unknown risk fns evaluate to na.
- Any other unmodeled `strategy.*` helper evaluates to na (never a JS error).

## 11. Known deviations & not-yet-modeled

| Area | Status |
| --- | --- |
| OCA groups (`oca_name`/`oca_type`) | constants accepted, grouping not enforced |
| `calc_on_every_tick` / `calc_on_order_fills` | driver runs the Pine default (bar close); realtime ticks do run fill passes |
| Margin (`margin_long/short`, liquidation) | not modeled; `margin_liquidation_price` = na |
| Currency conversion | single-currency identity; `account_currency` = `'USD'` |
| `closedtrades.*` comments / `exit_id` | na (order comments not plumbed; commissions, times, and per-trade run-up/drawdown ARE tracked) |
| Trailing stop | position-aggregate activation + group fill (TV: per entry) |
| Risk emergency close | fills next tick pass (TV: next tick of its 4-tick bar walk) |
| `alert_message` on risk rules & orders | accepted, ignored (no alert routing in the engine core) |

## 12. Where it's tested

| File | Covers |
| --- | --- |
| `test/strategy.test.ts` | fills & timing, reverse/netting, pyramiding, close-by-id, exits (brackets, trailing, qty caps), sizing/commission/slippage, `process_orders_on_close`, stats, introspection |
| `test/strategy-risk.test.ts` | all six risk rules (behavioral, multi-day feeds), most-restrictive merging, speculative-tick halt rollback, indicator inertness |
| `test/strategy-metrics.test.ts` | derived metrics: hand-computed Sharpe/Sortino/volatility/CAGR/Calmar, annualization resolution, exposure counters, streaks, report backward-compat, two-backend metric equality |
| `test/cross-check.test.ts` / `parity.test.ts` | two-backend identical outputs incl. strategy scripts |
| `test/ontick-equivalence.test.ts` | incremental tick processing vs full recompute (broker rollback contract) |

Every fill/PnL expectation in those tests is hand-computed from the rules in
this document — if you change a rule here, a test should break.
