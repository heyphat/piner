# Strategy Engine — Math & Running Logic

This is the authoritative internal reference for piner's Pine v6 strategy simulator: a deterministic broker that runs a compiled Pine strategy bar-by-bar, fills queued orders at next-bar open (or same-bar close), marks equity to market along an assumed intrabar path, and produces a `StrategyReport` that `computeStrategyMetrics` reduces into risk-adjusted analytics. Everything here is derived from the source under `src/runtime/builtins/strategy.ts`, `src/engine/strategy-metrics.ts`, `src/engine/portfolio-engine.ts`, `src/engine/driver.ts`, and `src/runtime/context.ts`, with file:line citations kept inline so this doc stays navigable. It is written for an engineer maintaining the engine — dense, formula-first, edge-cases surfaced.

## Table of contents

1. [Overview & execution model](#1-overview--execution-model)
2. [Strategy configuration reference](#2-strategy-configuration-reference)
3. [Position sizing](#3-position-sizing)
4. [Order lifecycle](#4-order-lifecycle)
5. [Fill engine](#5-fill-engine)
6. [Commission math](#6-commission-math)
7. [Slippage & tick rounding](#7-slippage--tick-rounding)
8. [Margin & the Account model](#8-margin--the-account-model)
9. [Position & closed-trade accounting](#9-position--closed-trade-accounting)
10. [Equity, drawdown & run-up curves](#10-equity-drawdown--run-up-curves)
11. [The broker StrategyReport](#11-the-broker-strategyreport)
12. [Trade statistics & strategy.* accessors](#12-trade-statistics--strategy-accessors)
13. [Risk management rules](#13-risk-management-rules)
14. [Derived performance metrics](#14-derived-performance-metrics)
15. [Portfolio-level aggregation](#15-portfolio-level-aggregation)
16. [TradingView parity notes & intentional deviations](#16-tradingview-parity-notes--intentional-deviations)
17. [Appendix: source map & glossary](#17-appendix-source-map--glossary)

---

## 1. Overview & execution model

The simulation lives in one shared runtime class, `StrategyBroker` (`src/runtime/builtins/strategy.ts`). Because piner is a two-backend engine, the broker is exercised **identically** by both the generated-JS backend (`codegen/emit.ts`) and the AST interpreter (`interp/interpreter.ts`) over the same runtime `$` = `ExecutionContext`; the test suite asserts byte-for-byte identical output, so any change to fill/PnL/accounting semantics is a change to this one class and needs matching tests, not a per-backend edit.

**Hooks.** The broker is reached through two `ExecutionContext` methods that just delegate (`context.ts:384-390`):

```ts
onStrategyBar(): void { this.strategyBroker.onBar(); }          // before the script body
onStrategyBarClose(): void { this.strategyBroker.onBarClose(); } // after it
```

**Historical bar** (`driver.ts:70-80`): `beginBar` sets O/H/L/C/Time slots → `$.onStrategyBar()` fills pending orders against this bar's open/range → `main($)` runs the script and queues new orders → `$.onStrategyBarClose()` runs the `process_orders_on_close` pass → `$.series.commitBar()`.

**Next-bar-open default.** Because `onStrategyBar()` for bar N runs *before* bar N's `main($)`, an order queued during bar N is not filled that bar — it sits in `this.pending`/`this.exits` and is first tested on bar **N+1**'s `onBar()` pass, filling market orders at **bar N+1's open** (`strategy.ts:2-8`).

**Realtime / rollback** (`driver.ts:86-111`): each tick does `rollback()` → `beginBar(tick, committed)` → `onStrategyBar()` → `main($)` → `onStrategyBarClose()`, committing only when `isClose`. This is the *same* fill pass run against the developing (mutable) O/H/L of the open bar, so orders fill intrabar and repaint until the bar closes. `rollback()` (`driver.ts:113-120`) truncates `SeriesStore` to committed length and calls `$.restoreMutable(this.snapshot)`, which restores `ta`, `draw`, and `strategyBroker.restore(snap.strategy)` — so pending orders and fills produced by a superseded tick are discarded before replay. Snapshot/restore taxonomy is in §15.2.

Derived analytics (Sharpe, CAGR, buy-&-hold, close-to-close phases) are **not** in the broker — they live in the pure reduction `computeStrategyMetrics` (`src/engine/strategy-metrics.ts`), which consumes the report. Multi-symbol backtests are orchestrated by `PortfolioEngine` (`src/engine/portfolio-engine.ts`), covered in §15.

---

## 2. Strategy configuration reference

All broker configuration lives in one mutable `StrategyBroker.settings: StrategySettings` object (interface `strategy.ts:50-69`), initialized to Pine-v6 defaults (`strategy.ts:239-251`) and overwritten by `configure()` (`strategy.ts:410-416`) with a `Partial<StrategySettings>` parsed from the `strategy(...)` header by `extractStrategySettings()` (`compiler.ts:247-288`).

| Setting (field) | Pine `strategy()` arg | Type | Default | Effect |
|---|---|---|---|---|
| `initialCapital` | `initial_capital` | number | `1_000_000` | Seeds the funding `Account`; sets drawdown/run-up baselines. |
| `qtyType` | `default_qty_type` | `'fixed'\|'cash'\|'percent_of_equity'` | `'fixed'` | Selects the `defaultQty()` sizing formula (§3). |
| `qtyValue` | `default_qty_value` | number | `1` | Numeric operand of the sizing formula. |
| `commissionType` | `commission_type` | `'percent'\|'cash_per_contract'\|'cash_per_order'` | `'percent'` | Selects the `commission()` fee formula (§6). |
| `commissionValue` | `commission_value` | number | `0` | Fee operand; `<= 0` short-circuits to no fee. |
| `pyramiding` | `pyramiding` | number | `1` | Max simultaneously-open `strategy.entry` lots per direction (§4). |
| `slippage` | `slippage` | number (ticks) | `0` | Adverse fill offset `= slippage * mintick` (§7). |
| `processOrdersOnClose` | `process_orders_on_close` | boolean | `false` | Adds an extra same-bar-close fill pass (§5). |
| `marginLong` | `margin_long` | number (percent) | `100` | Equity share required to hold a long; `0` disables the funds/margin check (§8). |
| `marginShort` | `margin_short` | number (percent) | `100` | Same for shorts (can still be liquidated at 100) (§8). |

**v6/v5 divergence** (`strategy.ts:248`, `compiler.ts:279-280`): `margin_long`/`margin_short` default to **100** (v6, no leverage). An explicit `0` restores the v5 no-funds-check behavior. Omitting the arg keeps 100/100. Note the `initialCapital` default is `1_000_000`, not TV's older 100000.

**`configure()`** (`strategy.ts:410-416`):

```ts
configure(s: Partial<StrategySettings>): void {
  this.active = true;
  Object.assign(this.settings, s);
  if (this.ownAccount) this.account.initial = this.settings.initialCapital;
  this.peakEquity = this.account.initial;
  this.valleyEquity = this.account.initial;
}
```

Merges the parsed partial over defaults (unspecified args keep defaults), marks the broker `active` (order-entry points are no-ops while `!active`, e.g. `entry()` at `strategy.ts:569`), syncs `account.initial = initialCapital` **only if the broker owns its account** (`ownAccount`; under a shared portfolio account the sync is skipped, `strategy.ts:256-258`), and re-seeds `peakEquity`/`valleyEquity` to the account initial. Called via `ExecutionContext.configureStrategy()` (`context.ts:391-393`).

**Arg parsing** (`extractStrategySettings`, `compiler.ts:247-288`):
- Numeric args (`initial_capital`, `default_qty_value`, `commission_value`, `pyramiding`, `slippage`, `margin_long`, `margin_short`) are read via `num()`→`numLit()`, which accepts only a numeric literal or unary-minus numeric literal (`compiler.ts:291-295`). Non-literal expressions → `undefined` → default kept.
- Enum args (`default_qty_type`, `commission_type`) are read via `enumLeaf()` (`compiler.ts:254-257`) taking the `.property` leaf of a `strategy.foo` Member expression, then validated against the allowed set (`compiler.ts:262-274`); an unrecognized leaf keeps the default.
- `process_orders_on_close` must be a `Bool` literal (`compiler.ts:285-286`).

**Options NOT implemented (silently ignored):**
- `calc_on_every_tick` — no setting; realtime recomputation is governed structurally by the driver's rollback/replay, not a toggle.
- `calc_on_order_fills` — not parsed, no effect.
- `close_entries_rule` — not parsed. Closes are **always FIFO** by lot (`closePosition`, `strategy.ts:1310-1319`); there is no `ANY` mode.
- `currency` — not parsed. `account_currency` is hardcoded `'USD'` (`strategy.ts:1518-1520`); currency conversions are identity passthroughs (`emit.ts:759`, `interpreter.ts:791`).
- `oca_name` / `oca_type`, `comment`, `alert` / `alert_message` — accepted-and-ignored order/risk parameters; see §4 (exposed constants) and §16 (parity notes).

---

## 3. Position sizing

`qtyFor(order, price)` (`strategy.ts:546-549`) uses `order.qty` when it is a valid (non-NaN) number, else falls back to `defaultQty(price)`.

`defaultQty(price)` (`strategy.ts:552-557`):

```ts
defaultQty(price: number): number {
  const { qtyType, qtyValue } = this.settings;
  if (qtyType === 'cash') return qtyValue / price;
  if (qtyType === 'percent_of_equity') return ((qtyValue / 100) * this.equity) / price;
  return qtyValue; // fixed
}
```

| `default_qty_type` | Formula | Code | Notes |
|---|---|---|---|
| `fixed` | `qty = qtyValue` | `strategy.ts:556` | Raw contract count, price-independent. |
| `cash` | `qty = qtyValue / price` | `strategy.ts:554` | Spend `qtyValue` currency units of notional at the fill price. |
| `percent_of_equity` | `qty = (qtyValue / 100) * equity / price` | `strategy.ts:555` | Allocate `qtyValue`% of live account equity as notional. `equity` is the live getter `account.equity` (`strategy.ts:419-421`), re-evaluated at call time. |

**Rounding: none.** `defaultQty()` returns fractional contracts and `openOrAdd()` (`strategy.ts:1235-1277`) consumes them unrounded. The only `Math.round`/`Math.trunc` in the file are the margin-liquidation-price tick round (`strategy.ts:464`) and a trade-index truncation (`strategy.ts:753`) — neither touches order quantity. This is a deliberate deviation from TradingView, which floors cash/percent-derived quantities to whole contracts (§16).

Exposed to scripts as `strategy.default_entry_qty(price)` (`strategy.ts:1470`), defaulting `price` to `b.host.close`.

---

## 4. Order lifecycle

All entry verbs are methods on `StrategyBroker`. They do **not** fill — they mutate two in-memory queues, `private pending: Order[]` (`strategy.ts:317`) and `private exits: ExitBracket[]` (`strategy.ts:318`); fills are deferred to the driver's per-bar passes (§5). Every broker method early-returns when inactive or halted: `if (!this.active || this.riskHaltActive) return;` (e.g. `strategy.ts:569`).

Two wrapper helpers front every public verb (`strategy.ts:1387+`):
- `gated(when, fn)` (`strategy.ts:1387-1389`): `if (when !== false) fn();` — suppresses only when `when` is **exactly** `false` (na/undefined still fire).
- `opt(x)` (`strategy.ts:34-35`): `x === undefined || isNa(x) ? undefined : Number(x)` — coerces na/undefined numeric args to "not set."

**Exposed constant enums** (`makeStrategyNs`, `strategy.ts:1391-1402`): scripts read `strategy.long`/`strategy.short` (= `DIR_LONG`/`DIR_SHORT`), the sizing enums `strategy.fixed`/`cash`/`percent_of_equity`, `strategy.commission.{percent,cash_per_contract,cash_per_order}`, `strategy.direction.{all,long,short}`, and `strategy.oca.{none,cancel,reduce}` (`strategy.ts:1401`). The `oca.*` constants **exist but OCA is not implemented** — `entry`/`order`/`exit` accept no `oca_name`/`oca_type` argument (signatures `strategy.ts:1419-1464` take only `id,dir,qty,limit,stop,when` plus the exit-bracket args), and `comment`/`alert`/`alert_message` are not modeled either; see §16.

### The Order record and order-type derivation

```ts
interface Order {
  id: string; dir: number;           // +1 long, -1 short
  qty?: number;
  kind: 'entry' | 'order' | 'close' | 'closeAll';
  otype: 'market' | 'limit' | 'stop' | 'stoplimit';
  price?: number;                    // limit/stop price; for stoplimit this is the STOP trigger
  limit?: number;                    // stoplimit only: resting limit once the stop triggers
  triggered?: boolean;               // stoplimit only: stop has fired → now a resting limit
  seq?: number;                      // submission sequence (lots inherit it for exit scoping)
}
```
(`strategy.ts:71-83`)

`orderTrigger(limit?, stop?)` (`strategy.ts:27-32`) maps the two optional price args to `{otype, price, limit}`:

| `stop` | `limit` | Result |
|---|---|---|
| set | set | `{ otype: 'stoplimit', price: stop, limit }` (stop arms a resting limit) |
| set | — | `{ otype: 'stop', price: stop }` |
| — | set | `{ otype: 'limit', price: limit }` |
| — | — | `{ otype: 'market', price: undefined }` |

### entry (reversal-aware, pyramiding-capped) vs order (raw/netting)

Both submit through `submit(o)` (`strategy.ts:561-567`), keyed by id: re-submitting an unfilled `entry`/`order` **replaces in place** rather than stacking (`findIndex(p.id===o.id && kind∈{entry,order})` → replace, else push).

- `entry(id, dir, qty?, limit?, stop?)` (`strategy.ts:568-578`) pushes `{...orderTrigger(limit,stop), kind:'entry', seq:++this.orderSeq}`.
- `order(id, dir, qty?, limit?, stop?)` (`strategy.ts:579-589`) is identical except `kind:'order'`.

The behavioral difference lives in `execute(o, price)` at fill time (`strategy.ts:1184-1232`). On an **opposite-direction** position (`size !== 0 && sign(size) !== dir`, `strategy.ts:1206`):
- `entry` → **reverses**: `closePosition(price)` closes fully flat, then falls through (no `return`) to open the full new qty (`strategy.ts:1207-1208`, `1225-1231`).
- `order` → **nets** (`strategy.ts:1210-1217`): `closable = min(qty, |size|)`, close that much; if `rem = qty - closable > 0`, `openOrAdd(o, dir, rem, price)` opens the crossing remainder as a flip.

On a **same-direction** position, `entry` is capped by pyramiding (below); `order` is uncapped (matches TradingView).

`this.orderSeq` (`strategy.ts:320`) is a monotonic submission counter; its value is stored on the Order as `seq`, then inherited by the resulting Lot as `orderSeq` (`strategy.ts:1260`) for exit-bracket scoping.

### Pyramiding

Enforced at `strategy.ts:1219-1224`: a same-direction `strategy.entry` add is blocked when `openEntryCmdCount >= settings.pyramiding` (`return`). `openEntryCmdCount` (`strategy.ts:282-286`) counts open lots with `entryCmd === true`; `entryCmd` is set only for `strategy.entry` fills (`o.kind === 'entry'`, `strategy.ts:1261`). So the cap counts **open** entry-command lots, not cumulative adds — a close frees capacity. A reversal (opposite dir) always closes-then-opens regardless of the count.

### close / close_all

- `close(id, qty?)` (`strategy.ts:590-597`): gated on an OPEN lot with this id at call time — `if (!this.entryLots.some(lt => lt.id === id)) return;` — so a same-bar `entry(id)`+`close(id)` doesn't round-trip. Pushes `{id, dir:0, qty, kind:'close', otype:'market'}`.
- `close_all()` (`strategy.ts:598-605`): no-op when flat, else pushes `{id:'', dir:0, kind:'closeAll', otype:'market'}`.

At fill: `closeAll` → `closePosition(price, o.qty)`; `close` → `closePosition(price, o.qty, o.id)` (restricts to lots opened under that id, FIFO). Closes are always market orders.

### exit brackets

`exit(id, fromEntry?, qty?, profit?, loss?, stop?, limit?, trailPrice?, trailPoints?, trailOffset?)` (`strategy.ts:606-640`) builds an `ExitBracket`, keyed by id: re-submitting the same id **updates in place while preserving the trailing ratchet** — `if (i>=0) { bracket.trailStop = this.exits[i].trailStop; this.exits[i] = bracket; } else this.exits.push(bracket);` (`strategy.ts:635-639`).

Key fields (`strategy.ts:85-102`): `profit`/`loss` in **ticks** (per-lot, from that lot's fill price), `stop`/`limit` absolute **prices**, `trailPrice` activation price, `trailPoints` activation distance (ticks), `trailOffset` trail distance (ticks), `trailStop` current ratcheting level (NaN until armed), `filled` contracts closed so far, and `maxSeq = this.orderSeq` — the **call-time scope**: only lots whose `orderSeq <= maxSeq` are eligible (`strategy.ts:633`). Bracket price computation and the trailing ratchet are done at fill time (`processExits`/`trailFill`; formulas in §5). Exit brackets are cleared entirely once the position goes flat (`strategy.ts:1131`).

**OCA-style reservation** (`strategy.ts:1023-1051`): eligibility is `(!ex.fromEntry || lt.id === ex.fromEntry) && lt.orderSeq <= ex.maxSeq` (`strategy.ts:1026-1027`). Quantity is reserved **in call order**: an `unreserved` map starts at each lot's qty; iterating brackets in order, each takes only what earlier brackets left of its eligible lots — `want = ex.qty!=null ? max(0, ex.qty - filled) : Infinity`, `take = min(unreserved, want)` (`strategy.ts:1038-1049`). This reproduces TV's reversed-exit demo (qty-19 limit + qty-20 stop on 20 shares → the stop covers exactly 1). A bracket is `spent` once `filled>0 && (no eligible lots left || filled >= qty - 1e-9)` (`strategy.ts:1127-1128`). This is *within-bracket* reservation only; there is no cross-order OCA-group cancellation (see §16).

### risk.max_position_size (clamp, not block)

`strategy.risk.max_position_size` *reduces* an entry's qty rather than blocking it: `qty = Math.min(qty, this.riskMaxPositionSize - Math.abs(this.size))` (`strategy.ts:1228-1229`); if `qty <= 0` the entry isn't placed. Applies only to `kind === 'entry'`.

### cancel / cancel_all

- `cancel(id)` (`strategy.ts:833-835`): `this.pending = this.pending.filter(o => o.id !== id || o.otype === 'market')`; `this.exits = this.exits.filter(e => e.id !== id)`. **Market orders are not cancelable.**
- `cancel_all()` (`strategy.ts:837-840`): `pending = pending.filter(o => o.otype === 'market'); exits = []`.

---

## 5. Fill engine

Slippage is computed once per pass: `const slip = this.settings.slippage * this.host.mintick;` (`strategy.ts:868`; exit path `mt = host.mintick`, `strategy.ts:1010-1011`).

### The two passes

`onBar()` (`strategy.ts:844-851`) treats the whole bar as one tick: `this.processTick(open, high, low, open)` (`strategy.ts:848`) — range `[low, high]`, **market fill price = `open`** (next-bar-open execution). Then `barsProcessed++`, and `if (size !== 0) barsInMarket++`.

`onBarClose()` (`strategy.ts:859-863`) — a no-op unless `settings.processOrdersOnClose`. When set, runs `this.processTick(close, close, close, close)` (`strategy.ts:862`) AFTER `main($)` with `o=h=l=marketPx=close`: market orders created this same bar fill at the **close**; limit/stop/exit are tested against the **close only** (the collapsed range never sees the bar's earlier high/low, which predate those orders).

### `processTick(o, h, l, marketPx)` (`strategy.ts:867-922`) — four ordered phases

**Phase 1 — pending orders, in submission order** (`strategy.ts:871-905`); survivors go to `stillPending`:

| Order | Trigger (long / short) | Fill price | Code |
|---|---|---|---|
| market | always | `marketPx + sign(or.dir \|\| -sign(size)) * slip` | `strategy.ts:874` |
| limit | `o<=p` / `o>=p` (gap) | `o` (better; no slippage) | `strategy.ts:878` |
| limit | `l<=p` / `h>=p` (touch) | `p` (no slippage) | `strategy.ts:879` |
| stop | `o>=p` / `o<=p` (gap) | `o + or.dir*slip` (adverse) | `strategy.ts:884` |
| stop | `h>=p` / `l<=p` (touch) | `p + or.dir*slip` (adverse) | `strategy.ts:885` |
| stoplimit | stop arms (`h>=price`/`l<=price`), then limit at `l<=limit`/`h>=limit` | `limit` (or `o` if resting from a **prior** tick and gapped) — no slippage | `strategy.ts:887-903` |

For a market close/closeAll order `or.dir` is 0, so `or.dir || -sign(this.size)` falls back to the direction opposite the held position. Stop-limit's open-gap-to-open branch applies only when the limit was already resting from a prior tick (`wasTriggered`); a stop armed on the current tick can only fill at its limit price within the range. After Phase 1, `this.pending = stillPending;` (`strategy.ts:905`).

**Phase 2 — exit brackets** (`strategy.ts:907-908`): `if (size !== 0 && exits.length) processExits(o, h, l)`.

**Phase 2b — max_intraday_filled_orders cap** (`strategy.ts:910-917`): if `riskDayFills >= riskMaxIntradayOrders` and not halted, `riskTrip(true)` (§13).

**Phase 3 — mark-to-market + margin** (`strategy.ts:919-921`): `markToMarket(o, h, l)` updates the equity curve and drawdown/run-up extremes along the assumed path (§10) and calls `marginCheck` (a margin call can force-close mid-bar, §8); then `this.riskBarCloseEquity = this.equity`.

### `processExits(o, h, l)` (`strategy.ts:1009-1132`)

Setup:
- Intrabar path heuristic: `const highFirst = h - o < o - l;` (`strategy.ts:1013`) — the extreme nearer the open is assumed hit first.
- `firstOf(a, b, wantHigh)` (`strategy.ts:1017-1022`): `a==null?b : b==null?a : wantHigh?Math.max(a,b):Math.min(a,b)` — when an absolute price and a tick-distance resolve the same side, pick the one nearer the market (first to trigger).

Per eligible lot, with `dir = sign(size)`, `mt = host.mintick`:

```ts
const stopPx  = firstOf(ex.stop,  ex.loss   != null ? lot.price - dir * ex.loss   * mt : undefined, dir === DIR_LONG);  // :1068-1072
const limitPx = firstOf(ex.limit, ex.profit != null ? lot.price + dir * ex.profit * mt : undefined, dir === DIR_SHORT); // :1073-1077
```

Per-lot tick levels are measured from **that lot's own fill price** (`lot.price`); absolute `ex.stop`/`ex.limit` are shared. Fill resolution, in exact order (`strategy.ts:1079-1097`):

```ts
if (stopPx  != null && (dir===LONG ? o <= stopPx  : o >= stopPx )) { book(lot, take, o - dir * slip); continue; } // open gap
if (limitPx != null && (dir===LONG ? o >= limitPx : o <= limitPx)) { book(lot, take, o);            continue; } // open gap
const stopHit  = stopPx  != null && (dir===LONG ? l <= stopPx  : h >= stopPx );  // :1089
const limitHit = limitPx != null && (dir===LONG ? h >= limitPx : l <= limitPx);  // :1090
const stopFirst = dir===LONG ? !highFirst : highFirst;                           // :1092
if (stopHit && (stopFirst || !limitHit)) { book(lot, take, stopPx! - dir * slip); continue; } // :1093
if (limitHit) book(lot, take, limitPx!);                                          // :1097
```

Long: exit stop on the low side, profit limit on the high side (swapped for short). Open gaps fill at the open (stop `o - dir*slip` adverse; limit `o`, better) and pre-empt the path. If both stop and limit are hit in the same bar, `stopFirst` (from `highFirst`) decides the winner; the loser waits for a later bar. Exit stop takes adverse slippage; exit limit takes none.

### Trailing stop — `trailFill(ex, dir, o, h, l)` (`strategy.ts:1143-1171`)

Position-aggregate. Armed only when `trailOffset != null && (trailPoints != null || trailPrice != null)`. With `off = ex.trailOffset * mt`:

```ts
const act = ex.trailPrice != null ? ex.trailPrice : this.avgPrice + dir * (ex.trailPoints ?? 0) * mt;  // :1152-1153
const path = h - o < o - l ? [o, h, l, close] : [o, l, h, close];                                      // :1154
let stop = ex.trailStop; // NaN until armed
for (const p of path) {
  if (!NaN(stop) && (dir===LONG ? p <= stop : p >= stop)) return i===0 ? p : stop;   // hit: gap→open, else stop  :1158-1161
  const cand = p - dir * off;                                                        // :1162
  if (NaN(stop)) { if (dir===LONG ? p >= act : p <= act) stop = cand; }              // arm  :1163-1164
  else stop = dir===LONG ? Math.max(stop, cand) : Math.min(stop, cand);              // ratchet  :1166
}
```

Walks `open → nearer extreme → farther extreme → close`, arms when the path reaches `act`, ratchets `trail_offset` behind favorable prices (never loosening), reports a hit the moment the path crosses the ratcheted level. Fill applies adverse slippage: `px = fillPx - sign(size) * slip` (`strategy.ts:1109`). A low occurring before arming cannot trigger; the ratchet cannot use an extreme the path has not yet reached.

### Fill dispatch

`fill(o, price)` (`strategy.ts:1175-1182`) calls `execute` then increments `riskDayFills` only when the position/lots/closed-trades actually changed. `execute` (`strategy.ts:1184-1232`) routes closeAll/close/reversal/netting/open per §4, applying the pyramiding cap and `max_position_size` clamp before `openOrAdd` (which applies the margin gate, §8).

**Edge cases.** Market fill price source differs per pass (open in `onBar`, close in `onBarClose`). `process_orders_on_close` is skipped entirely unless set. Market orders are uncancelable. Margin call can force-close mid-bar during Phase 3 but does **not** halt — pending orders and exits survive on the reduced position. Realtime rollback discards pending orders/fills from a superseded tick before replay.

---

## 6. Commission math

Single source of truth, `commission(qty, price)` (`strategy.ts:538-544`):

```ts
private commission(qty: number, price: number): number {
  const c = this.settings;
  if (c.commissionValue <= 0) return 0;
  if (c.commissionType === 'percent') return (c.commissionValue / 100) * qty * price;
  if (c.commissionType === 'cash_per_contract') return c.commissionValue * qty;
  return c.commissionValue; // cash_per_order
}
```

| `commission_type` | Formula | Code | Notes |
|---|---|---|---|
| `percent` | `(commissionValue/100) * qty * price` | `strategy.ts:541` | Percent of fill notional; `commissionValue` is a whole-number percent (`0.1` → 0.1%). Charged per side. |
| `cash_per_contract` | `commissionValue * qty` | `strategy.ts:542` | Flat cash per contract; price-independent. |
| `cash_per_order` | `commissionValue` | `strategy.ts:543` | Flat cash per order; qty- and price-independent. |
| any | `0` if `commissionValue <= 0` | `strategy.ts:540` | Default value 0 → no-arg strategies pay nothing. |

`qty` is the unsigned contracts in the fill; `price` is the caller's fill price (already slippage-adjusted for stops/trailing, `strategy.ts:1094`, `1109`), so `percent` commission is charged on the **post-slippage** notional (parity: TV's pre/post-slippage basis is not verified here — §16).

**Entry side** — `openOrAdd()` books the fee once, stores it on the lot, debits realized, accumulates the total (`strategy.ts:1236`, `1262`, `1275-1276`):
```ts
const fee = this.commission(qty, price);
this.realized -= fee;            // carried per-lot; pro-rated into each trade's profit on close
this.totalCommission += fee;
```
`Lot.fee` (`strategy.ts:113`) is the entry-side commission still carried. The entry fee also counts against the margin affordability gate (§8): `equityAtFill - fee < required - 1e-9` rejects the fill.

**Exit side** — `closeLot()` (`strategy.ts:1335-1379`), defaulting the exit fee to a standalone order's commission but accepting an explicit pro-rated share:
```ts
private closeLot(lot, take, price, exitFee = this.commission(take, price)): void {
  const dir = sign(this.size);
  const entryFee = lot.fee * (take / lot.qty);   // pro-rated entry share
  lot.fee -= entryFee;
  const profit = dir * (price - lot.price) * take - exitFee - entryFee;   // :1344 — nets BOTH sides
  this.realized += profit + entryFee;            // entryFee was already debited at open, re-add it  :1345
  this.totalCommission += exitFee;               // :1346
  // ... commission: entryFee + exitFee on the ClosedTrade row  :1366
}
```

Double-count avoidance: the entry fee was subtracted from `realized` at open (`strategy.ts:1275`); on close `realized += profit + entryFee` re-adds it, leaving realized reduced by only the exit fee this step. Net across a round trip, realized is reduced by `entryFee + exitFee` exactly once. `netProfit === realized` (`strategy.ts:443-444`) is fully commission-net both sides. `totalCommission` (`strategy.ts:160`, `312`) accumulates both sides = TradingView's "Commission Paid", reported as `StrategyReport.totalCommission` (`strategy.ts:1294`).

**Attribution.** Each `ClosedTrade` row stores `commission: entryFee + exitFee` (`strategy.ts:1366`). Partial close attributes only the pro-rated shares for `take` contracts; the remaining lot fee stays on the still-open lot (`strategy.ts:1342-1343`). Readbacks: `strategy.closedtrades.commission(k)` → `t.commission`; `strategy.opentrades.commission(k)` → `lot.fee` (remaining un-attributed entry commission, `strategy.ts:817-818`).

**Order-level fee pro-rating** (matters for `cash_per_order`, which is a single flat charge per order but piner books one row per lot):
- Market/`strategy.close`: `totalFee = commission(closeQty, price)`; per lot `closeLot(lot, take, price, totalFee * (take/closeQty))` (`strategy.ts:1318`, `1323`).
- Trailing-stop group: `book(lot, take, px, commission(group, px) * (take/group))` (`strategy.ts:1119`).
- Individual bracket fills call `book(lot, take, px)` with no fee arg → `closeLot` default `commission(take, price)` (`strategy.ts:1339`).

For `percent`/`cash_per_contract` the pro-rating is exact (linear in qty). **No rounding anywhere** in the commission path; the only nearby epsilon is the `1e-9` margin-gate comparison tolerance (`strategy.ts:1252`), not a fee rounding.

---

## 7. Slippage & tick rounding

`slippage` is expressed in **ticks** and converted to a price offset once per pass: `slip = settings.slippage * host.mintick` (`strategy.ts:868`, exit path `:1010-1011`). `mintick` lives on the context (`context.ts:369`, default `0.01`, settable per-run via `RunOptions.mintick`), surfaced as `syminfo.mintick`. `StrategyHost` (`strategy.ts:37-48`) exposes `open,high,low,close,time,idx,mintick,tradingDayKey` — **no `pointvalue`**.

**Adverse application.** Slippage is added adversely to **market and stop (incl. trailing) fills only; never to limit fills** (a limit can only improve, so none is applied — matches TV).

| Fill | Expression | Code |
|---|---|---|
| market | `marketPx + sign(or.dir \|\| -sign(size)) * slip` | `strategy.ts:874` |
| pending stop (gap / touch) | `o + or.dir*slip` / `p + or.dir*slip` | `strategy.ts:884-885` |
| pending limit | `o` / `p` (no slip) | `strategy.ts:878-879` |
| stop-limit (limit leg) | `o` / `or.limit` (no slip) | `strategy.ts:897-898` |
| exit stop (gap / touch) | `o - dir*slip` / `stopPx - dir*slip` | `strategy.ts:1082`, `1094` |
| exit limit | `o` / `limitPx` (no slip) | `strategy.ts:1086`, `1097` |
| trailing stop | `fillPx - sign(size)*slip` | `strategy.ts:1109` |

Sign convention differs by path: the pending path uses the **order** direction `or.dir` (`+dir*slip`); the exit path uses `dir = sign(size)` (**position** direction) with `-dir*slip` because an exit trades opposite. Both resolve to adverse. For a market close with no explicit dir, `or.dir || -sign(size)` picks the adverse side from the position.

**Tick-distance → price conversions** (via `mintick`, applied *before* slippage): exit loss/profit `lot.price ∓ dir * ex.loss/profit * mt` (`strategy.ts:1070`, `1075`); trailing `off = ex.trailOffset * mt`, `act = ex.trailPrice ?? avgPrice + dir*(ex.trailPoints ?? 0)*mt` (`strategy.ts:1150-1153`).

**Tick rounding of prices: none.** Executed fill prices flow straight through, never snapped to mintick. The **only** `Math.round(raw/mt)*mt` in the file is on the derived, reported `marginLiquidationPrice` (`strategy.ts:463-464`, guarded `mt > 0` else raw).

**Point value = 1 (implicit).** PnL is the raw price delta × quantity — there is no tick-value/contract-multiplier. Closed-trade profit `dir*(price - lot.price)*take` (`strategy.ts:1344`); open PnL `size*(close - avgPrice)` (`strategy.ts:423`); margin/liquidation math explicitly documented `PointValue = 1` (`strategy.ts:448`, `971`). `syminfo.pointvalue` is hardcoded `1` (`context.ts:637`) and exposed to scripts but never read by the broker. So a `slip` price offset costs exactly `slip × qty` in currency. Instruments with point value ≠ 1 are not modeled (§16).

---

## 8. Margin & the Account model

Two settings carry margin percentages as **whole-number percents**: `marginLong` (`strategy.ts:65`), `marginShort` (`strategy.ts:68`). At every use site the percent is converted to a fraction `m = pct/100`; a per-direction selector picks long vs short. Defaults 100/100 (v6); explicit `0` opts into v5 no-margin (`compiler.ts:279-284`).

### The `Account` class (`strategy.ts:184-234`)

Extracted so multiple brokers can share one pot in a portfolio run. **The account holds NO PnL state** — realized/open PnL live on the brokers; the account holds only `initial` and derives sums on demand.

| Member | Formula | Code |
|---|---|---|
| constructor | `constructor(public initial: number) {}` | `strategy.ts:186` |
| `attach(b)` | registers broker if absent; returns `this` | `strategy.ts:188-191` |
| `realized` | `Σ_b b.realized` | `strategy.ts:194-198` |
| `equity` | `initial + Σ_b b.realized + Σ_b b.accountOpenProfit` | `strategy.ts:203-208` |
| `equityExcludingOpen(x)` | `initial + Σ_b b.realized + Σ_{b≠x} b.accountOpenProfit` | `strategy.ts:216-221` |
| `requiredMarginExcluding(x)` | `Σ_{b≠x} b.accountRequiredMargin` (0 for a private account) | `strategy.ts:229-233` |

`equityExcludingOpen(x)` is the **funds base for x's margin/intrabar-marking math**, excluding x's own open PnL (endogenous, re-added along the price path). For a private (single-broker) account it reduces to `initial + realized` bit-for-bit.

### Broker-side hooks

The broker starts with a private account seeded from its own initial: `account = new Account(settings.initialCapital).attach(this)` (`strategy.ts:255`). A portfolio host calls `setAccount(a)` (`strategy.ts:262-268`) to swap in a shared pot, sets `ownAccount = false`, and re-seeds `peakEquity`/`valleyEquity` from `a.initial`.

| Getter | Formula | Code |
|---|---|---|
| `valuationPrice` | `Number.isNaN(host.close) ? lastMark : host.close` | `strategy.ts:429-432` |
| `accountOpenProfit` | `size === 0 ? 0 : size * (valuationPrice - avgPrice)` | `strategy.ts:434-436` |
| `accountRequiredMargin` | `size === 0 ? 0 : m <= 0 ? 0 : |size| * valuationPrice * m` | `strategy.ts:438-442` |
| `avgPrice` | `Σ(qty·price)/Σqty`, `NaN` while flat | `strategy.ts:481-489` |

### Margin liquidation price (`strategy.margin_liquidation_price`)

`marginLiquidationPrice` (`strategy.ts:453-465`), Help-Center formula (PointValue = 1) `P = ((initialCapital + netProfit)/|size| − D·avgPrice)/(m − D)`, generalized to the free pot:

```ts
if (this.size === 0) return NaN;
const D = sign(this.size);
const m = (D === DIR_LONG ? marginLong : marginShort) / 100;
if (m <= 0 || m === D) return NaN;
const raw = ((account.equityExcludingOpen(this) - account.requiredMarginExcluding(this)) / |size|
             - D * avgPrice) / (m - D);
return mt > 0 ? Math.round(raw / mt) * mt : raw;
```

Returns `NaN` while flat, when the direction's margin percent is 0, or for a **fully-funded long** where `m = 1 = D` (denominator 0 → no finite liquidation price). A short at 100 has `m-D = 2 ≠ 0` → finite. Rounded to nearest mintick.

### Entry-time funds gate (`openOrAdd`, `strategy.ts:1235-1253`)

An exposure-increasing fill is **rejected outright (not reduced)** if the resulting position needs more equity than is available at the fill price. Only the opening path is gated; closes and the reducing leg of a netting order always execute.

```ts
const m = (dir === DIR_LONG ? marginLong : marginShort) / 100;
if (m > 0) {
  const base = account.equityExcludingOpen(this);
  const equityAtFill = size === 0 ? base : base + size * (price - avgPrice);
  const required = price * (|size| + qty) * m + account.requiredMarginExcluding(this);
  if (equityAtFill - fee < required - 1e-9) return;   // reject
}
```

The entry `fee` counts against affordability (parity question P4 — parity questions are catalogued in §16; `strategy.ts:1242`). `m = 0` skips the block (v5). Under a shared account, the rest of the basket's margin is first-come-first-served (spec S4 — the portfolio clauses S1–S9 live in `docs/portfolio-semantics.md` and are summarized in §15; potential divergence from TV per-symbol accounting).

### Forced liquidation / margin call (`marginCheck`, `strategy.ts:983-1007`)

Runs from `markToMarket` on every processed tick. Walks the same assumed intrabar path `h-o<o-l ? [o,h,l,close] : [o,l,h,close]` and at the **first point where marked equity falls below required margin** (strictly — the exact boundary does *not* trip, guarded by the `1e-9` tolerance at `strategy.ts:996`), force-closes **four times** the quantity needed to cover the deficit, capped at the whole position.

```ts
const path = h-o < o-l ? [o,h,l,close] : [o,l,h,close];
for (const p of path) {
  if (size === 0) break;
  const equity = account.equityExcludingOpen(this) + size * (p - avgPrice);
  const required = p * |size| * m + account.requiredMarginExcluding(this);
  const deficit = required - equity;
  if (deficit <= 1e-9) continue;                     // :996 — exact boundary does NOT trip
  const qLiquidate = Math.min((4 * deficit) / (p * m), |size|);
  this.closePosition(p, qLiquidate);
  this.marginCallCount++;
}
```

Rationale (`strategy.ts:976-977`): selling `q` at `p` cuts the requirement by `p·q·m`, so `qToCover = deficit/(p·m)`; the emulator liquidates 4× that (TV's "liquidate four times the amount required" rule to avoid constant margin-call events). The walk **continues with the reduced position** — a second violation liquidates again; the loop terminates because `|size|` shrinks. **Not a halt** (unlike a risk trip): pending orders and exits survive on the smaller position. Fill price is the violating path point `p` (parity question P1, `strategy.ts:981`). Each liquidation increments `marginCallCount`, reported as `marginCalls` (`strategy.ts:1299`; always 0 with margins off). The bar's equity-curve point is re-marked with the post-call position (`strategy.ts:1006`), but drawdown/run-up extremes keep the pre-call path marks (the dip genuinely happened).

**Edge cases.** `m <= 0` short-circuits all three mechanisms (gate skipped, no walk, required-margin 0, liquidation price NaN). Fully-funded long → no finite liquidation price. Private account: `requiredMarginExcluding = 0`, `equityExcludingOpen = initial + realized` bit-for-bit. `valuationPrice` falls back to `lastMark` when `host.close` is NaN (stale-close cross-sleeve semantics, spec S5).

---

## 9. Position & closed-trade accounting

Direction constants `DIR_LONG = 1`, `DIR_SHORT = -1` (`strategy.ts:17-18`); `sign(x) = x>0?1:x<0?-1:0` (`strategy.ts:19`). The open position is a signed contract count `this.size` backed by a FIFO list of `Lot` objects.

**`Lot`** (`strategy.ts:105-120`): `qty` (unsigned remaining), `price` (this fill's price), `bar`/`time`, `orderSeq` (exit scoping), `entryCmd` (pyramiding), `fee` (carried entry commission), and **per-CONTRACT** `maxFavMove`/`maxAdvMove` favorable/adverse excursions (≥0, price units) — being per-contract they survive partial closes unscaled; a trade row multiplies by its qty.

**`ClosedTrade`** (`strategy.ts:122-142`): one ledger row per closed lot — `entryId, dir, qty, entryPrice, exitPrice, entryBar, exitBar, entryTime, exitTime, profit, cumProfit, commission` (both sides), `maxRunup`, `maxDrawdown` (money, ≥0), optional `symbol` (portfolio-merged).

### Average entry price (lot-weighted, on-demand)

```ts
get avgPrice() { let q=0,pq=0; for (const lt of entryLots){ q+=lt.qty; pq+=lt.qty*lt.price; } return q>0 ? pq/q : NaN; }
```
(`strategy.ts:481-489`) A partial FIFO close removes/shrinks lots so the remainder re-prices automatically. Returns `NaN` while flat (`position_avg_price` surfaces NaN via explicit guard, `strategy.ts:1477-1478`).

### Opening / adding (`openOrAdd`, `strategy.ts:1235-1277`)

After the margin gate (§8), pushes a `Lot`; `flat: size = dir*qty; add: size += dir*qty` (`strategy.ts:1266-1273`). Immediately after the size change it calls `recordExposure()` (`strategy.ts:1274`) to advance the peak-position maxima (§12), then debits the entry fee to realized and carries it per-lot (`strategy.ts:1275-1276`). On an add, average price is not stored — the pushed lot changes the weighted mean.

### Closing — FIFO matching

`closePosition(price, qty?, entryId?)` (`strategy.ts:1310-1326`): filters lots to `entryId` if given, computes `eligible = Σ lt.qty` (no-op if `≤ 0`), `closeQty = (qty valid) ? min(qty, eligible) : eligible`, one order-level `totalFee = commission(closeQty, price)`, then consumes lots in list order calling `closeLot(lot, take, price, totalFee * take/closeQty)`.

`closeLot` core money math (`strategy.ts:1335-1379`):
- **Realized PnL:** `profit = dir * (price - lot.price) * take - exitFee - entryFee` (`strategy.ts:1344`), `dir = sign(this.size)` (position direction at close). No point-value multiplier.
- **realized update:** `realized += profit + entryFee` (`strategy.ts:1345`) — nets to the exit side only for this step (entry fee pre-debited at open).
- **cumProfit** (`strategy.ts:1365`) = `this.realized` after the update.
- **classification** (`strategy.ts:1347-1353`): `profit>0` → `grossProfit += profit; wins++`; `profit<0` → `grossLoss += -profit` (positive magnitude); `losses++`; else `evens++`.
- **row:** `commission: entryFee + exitFee`, `maxRunup: lot.maxFavMove * take`, `maxDrawdown: lot.maxAdvMove * take`.
- **size update** (`strategy.ts:1372-1378`): `this.size = dir * (|size| - take)`; lot spliced when `lot.qty <= 1e-9`; snaps to flat and clears `entryId`/`entryLots`/`exits` when `|size| <= 1e-9` or no lots remain.

### Reversal vs netting

- **`strategy.entry`** reversal (`strategy.ts:1207-1208`, `1225-1231`): `closePosition(price)` flattens fully, then falls through to open the **full** fresh qty.
- **`strategy.order`** netting (`strategy.ts:1211-1217`): `closable = min(qty, |size|); closePosition(price, closable); rem = qty - closable; if (rem>0) openOrAdd(o, dir, rem, price)`.
- `risk.allow_entry_in` against the allowed direction (`strategy.ts:1199-1205`): closes an opposite position (no reversal), no-op when flat.

### Per-trade run-up (MFE) & drawdown (MAE)

Accrued per-lot, per-contract, in `markToMarket` (`strategy.ts:955-963`), only while `size !== 0` and only for lots still open (a lot removed by this pass's fills already ended its life at its exit fill, `strategy.ts:952-954`):

```ts
const fav = dir===DIR_LONG ? h - lot.price : lot.price - l;
const adv = dir===DIR_LONG ? lot.price - l : h - lot.price;
if (fav > lot.maxFavMove) lot.maxFavMove = fav;
if (adv > lot.maxAdvMove) lot.maxAdvMove = adv;
```

On close the ledger multiplies by the closed quantity (`maxRunup: lot.maxFavMove * take`, `strategy.ts:1367-1368`).

### openProfit / netProfit

```ts
get openProfit() { return this.size === 0 ? 0 : this.size * (this.host.close - this.avgPrice); }  // :422-424
get netProfit()  { return this.realized; }                                                        // :443-444
```

`openProfit` is signed `size × (close − avgPrice)` at bar close (no fees, no point value). `accountOpenProfit` (§8) uses `valuationPrice` for cross-sleeve aggregation.

---

## 10. Equity, drawdown & run-up curves

Written once per bar inside `markToMarket(o, h, l)` (`strategy.ts:927-967`), called from `processTick` Phase 3.

**Per-bar equity mark** (`strategy.ts:929-931`):
```ts
this.lastMark = this.host.close;   // mark FIRST so account-derived equity reads this bar's close
const eq = this.equity;            // = account.equity = initial + Σrealized + Σ open PnL
this.equityCurve[this.host.idx] = eq;
```
`equityCurve` is a sparse array indexed by global bar index (`strategy.ts:163-164`), unset before the strategy activated. A mid-bar margin call re-marks the point with the post-call position (`strategy.ts:1006`); the `process_orders_on_close` pass re-runs `processTick` and overwrites the same bar's value.

**Drawdown & run-up extremes** (intrabar, `strategy.ts:932-951`):
```ts
let pts; if (size === 0) pts = [eq];
else { const base = account.equityExcludingOpen(this);
       const path = h-o < o-l ? [o,h,l,close] : [o,l,h,close];   // :937
       pts = path.map(px => base + size * (px - avgPrice)); }
for (const v of pts) {
  if (v > peakEquity) peakEquity = v;
  if (v < valleyEquity) valleyEquity = v;
  const dd = peakEquity - v; if (dd > maxDrawdown) maxDrawdown = dd;
  if (peakEquity > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (dd/peakEquity)*100);
  const ru = v - valleyEquity; if (ru > maxRunup) maxRunup = ru;
  if (valleyEquity > 0) maxRunupPercent = Math.max(maxRunupPercent, (ru/valleyEquity)*100);
}
```

- **Path heuristic** (`strategy.ts:937`): the extreme nearer the open is assumed reached first. While flat the "path" is the single close-marked equity `[eq]`.
- **Intrabar equity at px** = `base + size·(px − avgPrice)`, `base = equityExcludingOpen(this)` = `initial + Σrealized` (own open PnL excluded because it is re-added along the path).
- `peakEquity`/`valleyEquity` are running high-/low-water marks seeded to `account.initial` by `configure()`/`setAccount()` (`strategy.ts:266-267`, `414-415`; init `strategy.ts:296-297`).
- `maxDrawdown` = max of `peakEquity − v`; `maxRunup` = max of `v − valleyEquity`; percent forms guarded `peakEquity>0` / `valleyEquity>0`.

After the excursion/extreme loop, `markToMarket` also calls `recordExposure()` (`strategy.ts:964`) — one peak-position update per mark — then `riskCheckEquity(pts)` and `marginCheck` (§8, §13). Per-bar peak/valley are updated within the extreme loop in path order, so `dd`/`ru` at a point use the peak/valley seen up to and including that point. These *equity-curve* extremes are distinct from the per-trade `maxRunup`/`maxDrawdown` on `ClosedTrade` (§9).

`onBar()` counters (`strategy.ts:849-850`): `barsProcessed++`; `if (size !== 0) barsInMarket++` (a position opened only by the `process_orders_on_close` pass counts from the next bar, `strategy.ts:307-309`).

---

## 11. The broker StrategyReport

`report()` (`strategy.ts:1280-1301`) is a **pure snapshot** — every field is a copy of running state; nothing is computed at report time. Derived analytics (Sharpe, Sortino, CAGR, buy-&-hold) live in `computeStrategyMetrics` (`strategy.ts:144-146`).

| Field | Source | Code |
|---|---|---|
| `initialCapital` | `settings.initialCapital` | `strategy.ts:1283` |
| `netProfit` | `this.netProfit` (= `realized`) | `strategy.ts:443-444` |
| `grossProfit` | `this.grossProfit` | incremental `strategy.ts:1348` |
| `grossLoss` | `this.grossLoss` (**positive magnitude**) | incremental `strategy.ts:1351` |
| `wins` / `losses` / `evens` | classification counters | `strategy.ts:1347-1353` |
| `maxDrawdown` | intrabar-path peak-to-trough cash | `strategy.ts:943-944` |
| `maxDrawdownPercent` | `(dd/peakEquity)*100` max | `strategy.ts:945-946` |
| `maxRunup` | intrabar-path trough-to-peak cash | `strategy.ts:947-948` |
| `maxRunupPercent` | `(ru/valleyEquity)*100` max | `strategy.ts:949-950` |
| `totalCommission` | both sides = TV "Commission Paid" | `strategy.ts:1276`, `1346` |
| `closedTrades` | `ClosedTrade[]`, one row per closed lot (FIFO) | `strategy.ts:1305` |
| `equityCurve` | sparse, indexed by global bar idx | `strategy.ts:929-931` |
| `barsProcessed` | active-bar count (exposure denominator) | `strategy.ts:849` |
| `barsInMarket` | bars with an open position after the open fill pass | `strategy.ts:850` |
| `marginCalls` | `marginCallCount` (0 with margins off) | `strategy.ts:1299` |

The report has **no** `openProfit`/`equity`/`buyHold` field: `openProfit`/`equity` are live getters (§10, §12), `buyHold` is a derived metric (§14). The peak-position-exposure maxima (`maxContractsAll/Long/Short`, §12) are likewise **not** on `StrategyReport` — they are report-only running scalars exposed only through the `strategy.*` accessors. Open question surfaced by readers: confirm downstream serialization captures the final-bar equity from the curve rather than expecting it in the report.

---

## 12. Trade statistics & strategy.* accessors

### `tradeStat(scope, field)` (`strategy.ts:521-528`)

- `strategy.closedtrades.first_index` → `0` if any closed trades exist, else `NaN`.
- `strategy.opentrades.capital_held` → `size===0 ? 0 : |size · avgPrice|` (open-position cost basis).
- else `NaN`.

### `tradeField(scope, field, i)` (`strategy.ts:752-830)`, `k = Math.trunc(i)`

**closedtrades** → `this.closedTrades[k]` verbatim: `profit`, `entry_price`, `exit_price`, `entry_bar_index`, `exit_bar_index`, `entry_time`, `exit_time`, `entry_id`, `commission`, `max_runup`, `max_drawdown`, `cumprofit`/`cumulative_profit` (`t.cumProfit`). Derived: `size → t.dir * t.qty`; `profit_percent`/`max_runup_percent`/`max_drawdown_percent` → `tradePct(amount, t.entryPrice, t.qty)`.

**opentrades** → `this.entryLots[k]` marked against the live close: `profit → dir*(host.close - lot.price)*lot.qty`; `entry_price → lot.price`; `size → dir*lot.qty`; `commission → lot.fee` (remaining carried entry commission); `max_runup → lot.maxFavMove*lot.qty`; `_percent` variants via `tradePct(..., lot.price, lot.qty)`.

Both return `NaN` for an out-of-range index or an untracked field (`entry_comment`/`exit_comment`/`exit_id` are not tracked, `strategy.ts:792`).

`tradePct(amount, entryPrice, qty)` (`strategy.ts:746-749`): `basis = |entryPrice*qty|; return basis>0 ? (amount/basis)*100 : 0`.

### The strategy.* accessor namespace (`makeStrategyNs`, `strategy.ts:1386-1580`)

| Pine variable | Getter body | Line |
|---|---|---|
| `strategy.position_size` | `b.size` (signed) | 1474-1476 |
| `strategy.position_avg_price` | `b.size === 0 ? NaN : b.avgPrice` | 1477-1479 |
| `strategy.equity` | `b.equity` (= `account.equity`) | 1480-1482 |
| `strategy.openprofit` | `b.openProfit` | 1483-1485 |
| `strategy.netprofit` | `b.netProfit` (= `realized`) | 1486-1488 |
| `strategy.grossprofit` | `b.grossProfit` | 1489-1491 |
| `strategy.grossloss` | `b.grossLoss` (positive magnitude) | 1492-1494 |
| `strategy.wintrades` | `b.wins` | 1495-1497 |
| `strategy.losstrades` | `b.losses` | 1498-1500 |
| `strategy.eventrades` | `b.evens` | 1501-1503 |
| `strategy.closedtrades` | `b.closedTrades.length` | 1504-1506 |
| `strategy.opentrades` | `b.openTradeCount` (= `entryLots.length`) | 1507-1509 |
| `strategy.initial_capital` | `b.account.initial` | 1512-1514 |
| `strategy.max_drawdown` | `b.maxDrawdown` | 1515-1517 |
| `strategy.max_drawdown_percent` | `b.maxDrawdownPercent` | 1535-1537 |
| `strategy.max_runup` | `b.maxRunup` | 1538-1540 |
| `strategy.max_runup_percent` | `b.maxRunupPercent` | 1541-1543 |
| `strategy.max_contracts_held_all` | `b.maxContractsAll` | 1562-1564 |
| `strategy.max_contracts_held_long` | `b.maxContractsLong` | 1565-1567 |
| `strategy.max_contracts_held_short` | `b.maxContractsShort` | 1568-1570 |
| `strategy.position_entry_name` | `b.positionEntryName` | 1571-1573 |
| `strategy.margin_liquidation_price` | `b.marginLiquidationPrice` | 1576-1578 |
| `strategy.account_currency` | `'USD'` (constant) | 1518-1520 |

**Peak-position exposure** (`recordExposure`, `strategy.ts:530-536`) tracks three running maxima seeded to 0 (`strategy.ts:304-306`) and in `SNAP_SCALARS` (`strategy.ts:370-372`, so they roll back cleanly on a superseded realtime tick):
```ts
const abs = Math.abs(this.size);
if (abs > this.maxContractsAll)   this.maxContractsAll   = abs;      // peak absolute exposure
if (this.size > this.maxContractsLong)   this.maxContractsLong  = this.size;   // peak long
if (-this.size > this.maxContractsShort) this.maxContractsShort = -this.size;  // peak short (positive)
```
It is invoked after **every** size change — once per fill in `openOrAdd` (`strategy.ts:1274`) and once per mark in `markToMarket` (`strategy.ts:964`) — so intrabar peaks reached by a margin-call-reduced position are still captured. These are **report-only** scalars (TV's "Max contracts held"): they are surfaced only through the three `strategy.max_contracts_held_*` accessors above and are **not** part of `StrategyReport` (§11) nor `computeStrategyMetrics` (§14).

**Percent-of-initial-capital getters** (`strategy.ts:1523-1534`), all guarded on `b.account.initial` truthiness else 0: `netprofit_percent`, `openprofit_percent`, `grossprofit_percent`, `grossloss_percent` = `(metric / account.initial) * 100`.

**Cash averages** (`strategy.ts:1544-1561`): `avg_trade = closedTrades.length ? netProfit/closedTrades.length : 0`; `avg_winning_trade = wins ? grossProfit/wins : 0`; `avg_losing_trade = losses ? grossLoss/losses : 0`.

**Percent averages** delegate to `pct()`/`meanPct()` (`strategy.ts:500-517`):
```ts
pct(t) { const basis = |t.entryPrice*t.qty|; return basis>0 ? (t.profit/basis)*100 : 0; }
meanPct(filter, signFactor=1) { const xs = closedTrades.filter(filter); return xs.length ? (signFactor*xs.reduce((a,t)=>a+pct(t),0))/xs.length : 0; }
avgTradePercent()        = meanPct(() => true)
avgWinningTradePercent() = meanPct(t => t.profit > 0)
avgLosingTradePercent()  = meanPct(t => t.profit < 0, -1)   // reported positive
```
Each is the equal-weight arithmetic mean of per-trade return ratios (differs from the cash `avg_trade`, which divides total cash by count). Open question: verify this matches TV's "Avg Trade %" (some TV metrics weight by capital).

**Convenience metrics** (not Pine builtins): `profitFactor` (`strategy.ts:466-472`): `gl = |grossLoss|; gl>0 ? grossProfit/gl : grossProfit>0 ? Infinity : 0`. `winRate` (`strategy.ts:473-478`): `decided = wins+losses; decided>0 ? wins/decided : 0`.

---

## 13. Risk management rules

Six `strategy.risk.*` rules, configured by setters (`strategy.ts:648-675`, each early-returns if `!this.active`) and enforced at two kinds of point: (a) entry/quantity gates inside `execute()` at fill time, and (b) "halt" rules that call `riskTrip()`.

**Most-restrictive merge** — all numeric rules funnel through `riskMin` (`strategy.ts:644-647`): `v==null||NaN(v) ? cur : (cur==null ? v : Math.min(cur, v))`. `allow_entry_in` is the exception: last-valid-value assignment (only `'all'|'long'|'short'` accepted). Namespace wiring `strategy.ts:1406-1416`.

**Halt machinery.** `riskHaltActive` (`strategy.ts:678-680`): `this.riskHalted || this.riskHaltedDay === this.riskDay`. `riskTrip(untilDayEnd)` (`strategy.ts:688-693`): sets the halt flag (permanent or day-scoped), **cancels every pending order and exit bracket**, and submits **one emergency `closeAll` market order** (only if a position is open, fills next tick pass). While halted, every public verb (`entry`/`order`/`close`/`close_all`/`exit`) early-returns at submit time.

**Trading-day rollover** (`riskRollDay`, `strategy.ts:698-714`), called at the start of every `onBar()`: on a new `tradingDayKey`, score the day that just closed (loss day = `riskBarCloseEquity < riskDayStartEquity - 1e-9`; any non-loss day resets the streak), then reset day baselines and `riskDayFills`. The new day's baselines are seeded from the last bar-close equity **when finite, else from the account initial** — this matters for the very first trading day, when `riskBarCloseEquity` is still NaN before any bar has closed: `eq = Number.isFinite(riskBarCloseEquity) ? riskBarCloseEquity : account.initial; riskDayStartEquity = riskDayMaxEquity = eq; riskDayFills = 0` (`strategy.ts:707-713`). `tradingDayKey` (`context.ts:456-460`): bar index `idx` for timeframes > 1 day, else `tradingDayMs(time)`.

**Equity-based rules** run in `riskCheckEquity(pts)` (`strategy.ts:720-743`) at the end of `markToMarket`, over the bar's intrabar equity path points.

| Rule | Baseline / trigger metric | Comparison | Action | Code |
|---|---|---|---|---|
| `allow_entry_in` | order direction vs allowed | `dir !== allowed` | block entry; close opposite if held, else no-op | `strategy.ts:1199-1205` |
| `max_position_size` | resulting `|size|` | `qty = min(qty, cap - |size|)`; drop if ≤0 | clamp entry qty | `strategy.ts:1228-1229` |
| `max_cons_loss_days` | consecutive loss days | `riskConsLossDays >= cap` | `riskTrip(false)` — **permanent** | `strategy.ts:704-705` |
| `max_drawdown` (cash) | strategy peak-to-trough | `maxDrawdown >= cap - 1e-9` | `riskTrip(false)` — **permanent** | `strategy.ts:722-723` |
| `max_drawdown` (%) | `dd / peakEquity * 100` | `maxDrawdownPercent >= cap - 1e-9` | `riskTrip(false)` — **permanent** | `strategy.ts:724` |
| `max_intraday_loss` (cash) | `dayStartEquity - v` | `loss >= cap - 1e-9` | `riskTrip(true)` — **day halt** | `strategy.ts:733-735` |
| `max_intraday_loss` (%) | `loss` vs % of `dayMaxEquity` | `loss >= (cap/100)*riskDayMaxEquity - 1e-9` | `riskTrip(true)` — **day halt** | `strategy.ts:736-737` |
| `max_intraday_filled_orders` | `riskDayFills` | `riskDayFills >= cap` (and not halted) | `riskTrip(true)` — **day halt** | `strategy.ts:912-917` |

Notes: `max_drawdown` uses the **strategy-wide** peak-to-trough (§10), not the day's; percent is a share of running peak (max) equity. `riskCheckEquity` walks the intrabar `pts` in path order, and at each point it **first** raises `riskDayMaxEquity` (`if (v > riskDayMaxEquity) riskDayMaxEquity = v`, `strategy.ts:731`) and **then** — unless the day is already halted (`dayHalted = riskHaltedDay === riskDay`, `strategy.ts:729`; `if (dayHalted) continue`, `strategy.ts:732`) — tests the same point's `loss = riskDayStartEquity - v` against the cash cap and against `(pct/100)*riskDayMaxEquity` (`strategy.ts:733-737`). So `max_intraday_loss`'s percent basis is the day's **maximum** equity (`riskDayMaxEquity`), while the loss reference is the day's **opening** equity (`riskDayStartEquity`) — an intentional v6-reference detail (`strategy.ts:716-719`); open question whether this exactly matches TV. Crucially, the max-equity ratchet **keeps advancing even during a day halt** (only the loss trip-tests are gated by `dayHalted`), so a later un-halted bar in the same day compares against the correct running max. `allow_entry_in` closes an opposite position without reversing. `riskDayFills` (`fill()`, `strategy.ts:1175-1182`) counts only orders that actually trade (position/lots/closed-trades changed) and each lot's exit on a multi-lot close. Forced **margin liquidation** (§8) is a separate mechanism, explicitly **NOT** a halt.

**Snapshot note (realtime):** all `risk*` fields are in `SNAP_SCALARS` (§15.2), so a halt tripped on a speculative tick rolls back cleanly when the real closing tick arrives.

---

## 14. Derived performance metrics

`computeStrategyMetrics(report, opts)` (`strategy-metrics.ts:228`) is a **pure**, deterministic reduction — no clock, no I/O, no market-calendar assumptions. Constants: `MS_PER_YEAR = 365.25*24*60*60*1000` (`strategy-metrics.ts:24`), `MS_PER_DAY = 24*60*60*1000` (`strategy-metrics.ts:140`). Returns are **per-bar simple returns of the equity curve INCLUDING flat bars** (dropping idle bars inflates Sharpe). This per-bar convention (with `riskFreeRate` default 0) is an intentional deviation from TradingView's monthly-return / 2%-RFR basis — see §16.

**Preprocessing.** `finitePoints` (`strategy-metrics.ts:116-130`) compacts the sparse curve, keeping index-aligned `equity[]`/`time[]` (missing time → NaN, equity kept). `spanYears` (`strategy-metrics.ts:133-138`) = `(last-first)/MS_PER_YEAR`, `NaN` unless finite `first`, finite `last`, and `last > first` strictly.

**Annualization — four-tier fallback**, each guarded `!(periodsPerYear > 0)` (catches NaN/0/negative):

| Tier | Formula | Code |
|---|---|---|
| host override | `opts.periodsPerYear` | `strategy-metrics.ts:236` |
| empirical | `(equity.length - 1) / years` | `strategy-metrics.ts:238` |
| 24/7 timeframe | `(365.25 * 86400) / opts.timeframeSeconds` | `strategy-metrics.ts:240` |
| default | `252` | `strategy-metrics.ts:241` |

**Return stats** (`strategy-metrics.ts:244-257`): `r = (equity[i]-equity[i-1])/equity[i-1]` (skip `prev===0` and non-finite `r`); `mean` (0 on empty); **population** `variance` (÷n); `std = √variance`; `annualize = √periodsPerYear`; `rfPerPeriod = (opts.riskFreeRate ?? 0)/periodsPerYear`; `excess = mean - rfPerPeriod`.

| Metric | Formula | Guard | Code |
|---|---|---|---|
| Sharpe | `(excess/std) * annualize` | `std>0` else 0 | `strategy-metrics.ts:259` |
| downside dev | `√(Σ_{r<0} r² / count(r<0))` | 0 if no downside | `strategy-metrics.ts:261` |
| Sortino | `(excess/downsideDev) * annualize` | `downsideDev==0`: `Infinity` if `excess>0` else 0 | `strategy-metrics.ts:264` |
| cagrYears | `years>0 ? years : equity.length>1 ? equity.length/periodsPerYear : 0` | — | `strategy-metrics.ts:269` |
| CAGR % | `(pow(final/initial, 1/cagrYears) - 1) * 100` | `cagrYears>0 && initial>0 && final>0` else 0 | `strategy-metrics.ts:270` |
| Calmar | `cagrPercent / report.maxDrawdownPercent` | `maxDrawdownPercent>0` else 0 | `strategy-metrics.ts:274` |
| expectancy (TV "avg trade") | `report.netProfit / trades.length` | empty → 0 | `strategy-metrics.ts:278` |
| avgWin / avgLoss | `winSum/winCount` / `lossSum/lossCount` (loss = positive magnitude) | count>0 else 0 | `strategy-metrics.ts:316` |
| avgBarsInTrade | `barsHeld / trades.length` | `trades.length>0` else 0 | `strategy-metrics.ts:358` |
| avgBarsInWinners | `winBars / winCount` | `winCount>0` else 0 | `strategy-metrics.ts:359` |
| avgBarsInLosers | `lossBars / lossCount` | `lossCount>0` else 0 | `strategy-metrics.ts:360` |
| avgWinLossRatio | `avgWin / avgLoss` | `avgLoss>0` else 0 | `strategy-metrics.ts:361` |
| volatility % | `std * annualize * 100` | — | `strategy-metrics.ts:348` |
| exposure % | `(barsInMarket/barsProcessed)*100` | `barsProcessed>0` else 0 | `strategy-metrics.ts:351` |
| largestWin % of grossProfit | `(largestWin/grossProfit)*100` | `grossProfit>0` else 0 | `strategy-metrics.ts:362` |
| largestLoss % of grossLoss | `(-largestLoss/grossLoss)*100` | `grossLoss>0` else 0 | `strategy-metrics.ts:364` |
| netProfit % of largestLoss | `(netProfit / -largestLoss)*100` | `largestLoss<0` else 0 | `strategy-metrics.ts:366` |
| returnOnInitialCapital % | `(netProfit/initial)*100` | `initial>0` else 0 | `strategy-metrics.ts:367` |
| maxRunup % of initial | `((report.maxRunup ?? 0)/initial)*100` | `initial>0` else 0 | `strategy-metrics.ts:372` |
| maxDrawdown % of initial | `(report.maxDrawdown/initial)*100` | `initial>0` else 0 | `strategy-metrics.ts:373` |

`avgBarsInTrade`/`avgBarsInWinners`/`avgBarsInLosers` are TV's "Avg # bars in trades / winning trades / losing trades" (interface `strategy-metrics.ts:64-69`).

**Trade-ledger loop** (`strategy-metrics.ts:292-315`), `held = t.exitBar - t.entryBar`: win/loss branches accumulate streaks, counts, sums, and bars; **an even (`profit===0`) trade resets BOTH streaks** and counts toward neither bucket; `maxConsecutiveWins`/`Losses` track running maxima; `largestWin` starts 0 and only rises (≥0), `largestLoss` starts 0 and only falls (≤0). The bar accumulators feed the avg-bars metrics: `barsHeld += held` every trade (`:314`), `winBars += held` on a winner (`:299`), `lossBars += held` on a loser (`:305`).

**Buy-&-hold** (`strategy-metrics.ts:319-340`): `base` = first closed trade's entry fill price (min `entryBar`, only if `entryPrice>0`), falling back to `bars[1].open` (first possible next-bar-open fill), or `bars[0].close` for a single bar; `last` = final bar's close. Guarded `base>0 && finite(last)` else all 0. `ret = last/base - 1`; `buyHoldReturnPercent = ret*100`; `buyHoldPnL = initial*ret`; `outperformance = report.netProfit - buyHoldPnL`. Note the entry-fill base **includes configured slippage**, whereas TV's "asset price" benchmark basis may exclude it — a documented parity caveat (`tradingview-strategy-report-metrics.md §1`); see §16.

**Close-to-close phases** (`closeToClosePhases`, `strategy-metrics.ts:155-226`) — single forward pass over `equity[]`/`time[]` (all-zero `out` when `length < 2`):
- **Per-bar MAX** (no phase completion): `maxRunup = max(maxRunup, v - runMin)`; `maxDrawdown = max(maxDrawdown, peak - v)` (`strategy-metrics.ts:189-191`).
- **Drawdown phase** completes on recovery to the previous peak: push `peak - ddTrough` to `ddMag` (`strategy-metrics.ts:197`), and `(time[i]-peakT)/MS_PER_DAY` to `ddDays` when finite (`strategy-metrics.ts:198-199`); next run-up origin = the trough (`:200`).
- **Run-up phase** (`pushRunup`, `strategy-metrics.ts:179-185`): only when `peak > runStart`, push `peak - runStart` and `(peakT - runStartT)/MS_PER_DAY`.
- **Trailing:** `if (!inDD) pushRunup()`. A trailing drawdown that never recovers is **excluded from averages** (only its MAX contribution counts).
- Averages = `mean(a) = a.length ? Σ/len : 0`. Durations are calendar days; non-finite duration boundaries are skipped for duration averaging only (phase still counts toward magnitude averages).

**Options** (`strategy-metrics.ts:26-42`): `barTimes`, `bars`, `timeframeSeconds`, `periodsPerYear` (host override, precedence), `riskFreeRate` (annual fraction, default 0).

**Not in this file:** `profitFactor` and `winRate`/percent-profitable are getters on the report (§12). Open questions surfaced by readers: the `cagrYears` fallback uses `equity.length/periodsPerYear` while empirical `periodsPerYear` uses `(equity.length-1)/years` (bar-count vs interval-count off-by-one — confirm intentional); Sharpe returns 0 at zero variance but Sortino returns Infinity (asymmetric — confirm contract); `riskFreeRate` feeds Sharpe/Sortino but NOT CAGR/Calmar (confirm intended).

---

## 15. Portfolio-level aggregation

`PortfolioEngine` (`src/engine/portfolio-engine.ts`) runs one compiled strategy over N symbols as a single backtest by driving N independent per-symbol `Engine` instances (each with its own `ExecutionContext` and `StrategyBroker`) bar-by-bar on the sorted-deduped union of all sleeves' bar times. **TradingView has no multi-symbol strategy; `docs/portfolio-semantics.md` (v1) is the authoritative spec** — per-sleeve behavior stays TV-faithful, portfolio composition follows that spec's clauses S1–S9 (referenced inline throughout §5/§8 and here).

### 15.1 Capital models, funding, alignment

Two models (module header `portfolio-engine.ts:6-16`):
- **isolated** (default, `:95`): each sleeve keeps its private `Account`, funded `wᵢ·P` via the `EngineOptions.strategy` override (`initialCapital: weights[i]*capital`, `:117`). Reproduces equal-/weighted models; gate V3 asserts the portfolio curve equals the forward-fill-and-sum oracle bit-for-bit.
- **shared**: one `Account(P)` swapped into every broker (`new Account(capital)` `:120`; `for (e) e.ctx.strategyBroker.setAccount(shared)` `:121`) so sizing, funds checks, margin, and risk read portfolio equity.

Pot: `capital = opts.capital ?? n * (script.metadata.strategy?.initialCapital ?? 1_000_000)` (`:103-104`; rejected if not finite or ≤ 0). `normalizedWeights(weights, n)` (`:242-252`): `undefined` → equal weight `1/n`; length mismatch or non-finite/≤0 weight throws; else `w/total`. Weights are **isolated-only**.

**Per-sleeve `request.security` injection** (`portfolio-engine.ts:122-127`): before each engine's `prepare()`, the run copies that sleeve's host-fetched security bars into the engine's context — `if (s.securityBars) for (const [key, bars] of Object.entries(s.securityBars)) engines[i].ctx.securityBars.set(key, bars)`. Keys are `SYMBOL@TF` (`PortfolioSleeveSpec.securityBars`, a `Record<string, Bar[]>`, `portfolio-engine.ts:41-43`), injected exactly as a single-symbol host does — so `request.security(...)` resolves correctly inside a portfolio run.

Master clock: `unionTimes` (`:256-260`) = `Array.from(new Set(all sleeve bar times)).sort((a,b)=>a-b)`. The loop (`:142-173`) walks the master axis with a per-sleeve `cursor`; at each master time `t`, every sleeve whose current bar's `time === t` is `step()`ed **in basket order** (spec S4 — earlier sleeves' fills settle before later sleeves size), advancing its cursor and recording `lastStepped`. Sleeves execute only on their own bars (spec S8).

### Portfolio equity curve (`:156-166`)

Read from **recorded** equity marks, never live getters (between bars the series pointer sits past the committed bar, so live `host.close`/`openProfit` is NaN, `:133-141`):

- **shared** (`:157-158`): `equityCurve[k] = engines[lastStepped].ctx.strategyBroker.equityCurve[cursor[lastStepped]-1]` — every broker's mark under the shared account IS portfolio equity; the last-stepped mark is most complete.
- **isolated** (`:161-165`): `eq += cursor[i] > 0 ? b.equityCurve[cursor[i]-1] : weights[i]*capital` — Σ of each sleeve's last recorded mark, using funding `weights[i]*capital` before its first bar (pre-activation cash), last mark after data ends (ragged tail). This is the forward-fill-and-sum oracle evaluated at run time.

`barsInMarket` (`:167-172`) increments once per master bar if ANY sleeve's broker `size !== 0` after the fill pass.

### Portfolio StrategyReport (`:176-217`)

Plain sums via `const sum = (f) => reports.reduce((a,r)=>a+f(r),0)` (`:183`) for `netProfit`, `grossProfit`, `grossLoss`, `wins`, `losses`, `evens`, `totalCommission`, `marginCalls`. Merged ledger (`:187-192`): each sleeve's `closedTrades` copied `{...t, symbol: s.symbol}`, sorted `(a,b) => a.exitTime - b.exitTime` (stable → basket order on ties), then `cumProfit` re-accumulated portfolio-wide (`for (t) t.cumProfit = cum += t.profit`). `barsProcessed: times.length`.

**Combined drawdown/run-up** — `closeToCloseExtremes(equityCurve, capital)` (`:265-284`), peak/valley seeded at the pot, NaN skipped:
```ts
if (v > peak) peak = v; if (v < valley) valley = v;
const dd = peak - v; if (dd > maxDrawdown) maxDrawdown = dd;
if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (dd/peak)*100);
const ru = v - valley; if (ru > maxRunup) maxRunup = ru;
if (valley > 0) maxRunupPercent = Math.max(maxRunupPercent, (ru/valley)*100);
```
This is the close-to-close analogue of the broker's intrabar `markToMarket` extremes (§10) but over bar-close portfolio equity only. Rationale (`portfolio-semantics.md:87-91`): per-sleeve `maxDrawdown` is an intrabar-path extreme; sleeves' worst intrabar moments don't coincide and cross-symbol intrabar paths are unknowable (spec S5), so close-to-close is the honest portfolio number.

**Derived metrics** (`metrics`, `:227-237`): `computeStrategyMetrics(r.report, { barTimes: r.times, timeframeSeconds: tfSeconds(this.lastTf), ...opts })`. All sleeves share one timeframe by contract; **no `bars` benchmark** (buy-&-hold is meaningless for a basket).

### 15.2 Realtime / rollback interaction & the snapshot taxonomy

`markToMarket` records bar-close equity (`equityCurve[host.idx] = eq`, `:931`) which the portfolio aggregation reads by cursor; the driver rolls back `equityCurve` via a `SNAP_APPEND` slice, so an uncommitted realtime tick's mark is discarded on the next rollback — portfolio aggregation never sees speculative equity.

`rollback()` (`driver.ts:113-120`) truncates `SeriesStore` to `committed` and calls `$.restoreMutable(this.snapshot)` (`context.ts:1178-1183`), which restores `ta`, `draw`, and `strategyBroker.restore(snap.strategy)`. `$.snapshotMutable()` (`context.ts:1166-1174`) calls `strategyBroker.snapshot()`.

Broker `snapshot()`/`restore()` (`strategy.ts:395-408`) use a three-way field taxonomy (declared `:352-394`) so rollback stays correct without deep-cloning the ever-growing history arrays each tick:

| Class | Fields | Copy | Why |
|---|---|---|---|
| `SNAP_DEEP` | `pending`, `exits`, `entryLots` | `structuredClone` | element objects mutate in place (`triggered`, `trailStop`/`filled`, lot `qty`/`fee`) |
| `SNAP_APPEND` | `closedTrades`, `equityCurve` | `slice` | append-only, rows never mutated after booking |
| `SNAP_SCALARS` | position/PnL/extremes scalars (incl. `maxContractsAll/Long/Short`) + **all `risk*` fields** | assign | primitives |

Invariant (`strategy-broker.md:568-570`): any new mutable broker field MUST join one of the three `SNAP_*` lists or realtime replays leak it.

**Edge cases.** Constructor throws if the script is not a strategy (`:93-94`); `run()` throws on empty basket (`:101`). Invalid capital/weights throw. `setAccount` flips `ownAccount=false` so `configure()` stops syncing `settings.initialCapital` into the shared account. Driver rollback lazily captures a baseline on the first realtime tick when no historical run occurred (`driver.ts:117`).

**Explicitly out of scope** (`portfolio-semantics.md:97-103`): cross-symbol margin netting, FX conversion, rebalancing, per-sleeve scripts/timeframes. Open question: under shared mode margin liquidation only ever closes the violating sleeve's own position — which sleeve to cut in a true cross-symbol margin call is unspecifiable.

---

## 16. TradingView parity notes & intentional deviations

**Intentional deviations from TradingView:**

- **No contract flooring.** `cash` and `percent_of_equity` sizing return fractional contracts (`defaultQty`, `strategy.ts:552-557`). TV floors to whole contracts. Known deviation.
- **Point value = 1.** PnL is price delta × contracts; `syminfo.pointvalue` is decorative (hardcoded 1). Instruments with point value ≠ 1 (futures/FX) are not modeled — both slippage-cost-in-currency and PnL would need a multiplier for parity.
- **`close_entries_rule` not implemented** — closes are always FIFO by lot (`strategy.ts:1310-1319`); TV also supports `'ANY'`.
- **Single-currency build** — `account_currency` hardcoded `'USD'` (`strategy.ts:1518-1520`); currency conversions are identity passthroughs.
- **`calc_on_every_tick` / `calc_on_order_fills`** are parsed away (no setting field); realtime recomputation is governed structurally by the driver's rollback/replay, not these toggles.
- **OCA not implemented.** The `strategy.oca.{none,cancel,reduce}` constants exist (`strategy.ts:1401`) but `entry`/`order`/`exit` accept no `oca_name`/`oca_type` argument (`strategy.ts:1419-1464`); exit brackets self-reserve within a single bracket per §4, but there is **no cross-order OCA-group cancellation**.
- **`comment` / `alert` / `alert_message` not modeled.** These order and `strategy.risk.*` parameters are accepted and silently ignored — there is no alert feed in piner (`risk.*` `alert_message` args are explicitly discarded, `strategy.ts:1405`, `1408-1415`).
- **Sharpe / Sortino basis.** Both use **per-bar simple equity returns (including flat bars)** with a default `riskFreeRate = 0` and a configurable annualization basis (`periodsPerYear` → empirical → 24/7 → 252, §14), versus TV's **monthly** returns with a **2%/year** default RFR and a fixed monthly convention. Pass `opts.riskFreeRate` to narrow the gap. See `tradingview-strategy-report-metrics.md §2`.

**Behaviors validated against TV:**

- Next-bar-open default execution and `process_orders_on_close` close-fill timing match TV's broker-emulator model (`strategy.ts:2-13`).
- Intrabar path heuristic (extreme nearer the open assumed first) mirrors TV's bar-magnifier-off assumption; used for exit stop/limit ordering, equity drawdown/run-up, and the margin-call walk (`strategy.ts:1013`, `937`, `988`).
- Exit reservation validated against TV's reversed-exit demo (qty-19 limit + qty-20 stop on 20 shares → stop covers exactly 1, `strategy.ts:1029-1032`); exit-persist scoping (`maxSeq`, an exit does not affect subsequent same-id entries) follows Pine's exit-persist demo.
- Pyramiding cap applies only to `strategy.entry`, not `strategy.order` (`strategy.ts:1219-1223`); cap-frees-on-close matches TV.
- Limit fills get no slippage (slippage can only improve a limit); only market and stop/trailing fills are adjusted adversely.
- Margin math cites the Help-Center leverage article (PointValue = 1); forced liquidation uses TV's "4× the amount required" rule; `marginLiquidationPrice` tick-rounding per `dev-docs/margin-plan.md §4`. **Doc-reconciliation note:** this margin coverage (forced 4× liquidation, finite `strategy.margin_liquidation_price`, `report().marginCalls` = `marginCallCount`) is the current, correct behavior per `docs/strategy-broker.md §9`, and **supersedes** the now-stale `docs/tradingview-strategy-report-metrics.md §5/§9` (which still claims margin calls are "Not implemented" and that `margin_liquidation_price` "always reads na"). Do not treat that section as authoritative.
- One `ClosedTrade` row per entry lot touched (FIFO) mirrors TV's ledger shape; `totalCommission` = TV "Commission Paid"; `marginCalls` = TV "Margin Calls"; `max_contracts_held_*` = TV "Max contracts held".
- Buy-&-hold benchmark enters at the first closed trade's entry fill (TV's stated basis). Caveat: the entry-fill base **includes configured slippage**; TV's asset-price basis may not — a documented parity caveat (`tradingview-strategy-report-metrics.md §1`).
- Close-to-close phase definitions follow `docs/tradingview-strategy-report-metrics.md` (drawdown = peak → recovery to previous peak, incomplete trailing phases excluded from averages; run-up = local minimum → last new peak).

**Flagged parity questions (open, from source comments):** *(P3 was retired during review; the P-series is intentionally non-contiguous — P1, P2, P4.)*
- **P1** — margin-call fill price uses the violating intrabar path point `p` (`strategy.ts:981`).
- **P2** — `marginLiquidationPrice` tick-rounding (`strategy.ts:452`).
- **P4** — the margin affordability gate counts the entry fee against available equity (`strategy.ts:1242-1243`).
- **S4** — under a shared account the opening margin gate treats the rest of the basket's margin as first-come-first-served (`strategy.ts:1248-1251`), possibly differing from TV per-symbol accounting.

**Open questions / caveats surfaced by readers (verify, don't assume):**
- Whether the intrabar-path heuristic for the margin-call walk exactly reproduces TV's internal tick ordering, and whether the exact-boundary (`equity == required` not tripping, via `1e-9`) matches TV's boundary semantics.
- Whether `avg_*_percent` (equal-weight mean of per-trade return ratios) matches TV's "Avg Trade %" (some TV metrics weight by capital).
- Whether `percent` commission should be charged on the pre- or post-slippage price (piner uses post-slippage for stops/trailing).
- Whether the `max_intraday_loss` percent denominator (day's max equity) exactly matches TV's documented behavior; whether `allow_entry_in` and `max_position_size` are applied identically by TV (reversal blocking; whether the size cap also applies to raw `strategy.order`).
- The `cagrYears` bar-count vs interval-count off-by-one (`strategy-metrics.ts:238` vs `:269`); asymmetric zero-variance handling of Sharpe (0) vs Sortino (Infinity); `riskFreeRate` applied to Sharpe/Sortino but not CAGR/Calmar.
- Confirm downstream serialization captures the final-bar equity from the curve rather than expecting it in the report.

---

## 17. Appendix: source map & glossary

### Source map

| Subsystem | File:line |
|---|---|
| Broker class, settings, defaults | `src/runtime/builtins/strategy.ts:50-69`, `239-251` |
| `configure()` | `strategy.ts:410-416` |
| Header-arg parsing (`extractStrategySettings`) | `src/engine/compiler.ts:247-295` |
| Position sizing (`defaultQty`, `qtyFor`) | `strategy.ts:546-557` |
| Order record & `orderTrigger` | `strategy.ts:27-32`, `71-83` |
| `entry`/`order`/`close`/`close_all`/`exit`/`submit` | `strategy.ts:561-640` |
| `cancel`/`cancel_all` | `strategy.ts:833-840` |
| Fill passes (`onBar`/`onBarClose`/`processTick`) | `strategy.ts:844-922` |
| Exit brackets (`processExits`) / trailing (`trailFill`) | `strategy.ts:1009-1132`, `1143-1171` |
| Fill dispatch (`fill`/`execute`/`openOrAdd`) | `strategy.ts:1175-1277` |
| Closing (`closePosition`/`closeLot`) | `strategy.ts:1310-1379` |
| Commission | `strategy.ts:538-544` |
| `Account` class | `strategy.ts:184-234` |
| Margin (gate/liquidation/marginCheck) | `strategy.ts:437-465`, `983-1007`, `1244-1252` |
| Avg price / open PnL / net profit / equity getters | `strategy.ts:419-489` |
| Mark-to-market, equity curve, extremes | `strategy.ts:927-967` |
| Peak-position exposure (`recordExposure`) | `strategy.ts:304-306`, `530-536`, `964`, `1274` |
| `report()` / `StrategyReport` | `strategy.ts:147-172`, `1280-1301` |
| Trade introspection (`tradeStat`/`tradeField`/`tradePct`/`pct`/`meanPct`) | `strategy.ts:500-528`, `746-830` |
| `strategy.*` namespace (`makeStrategyNs`) | `strategy.ts:1386-1580` |
| Risk rules (setters/riskMin/riskTrip/riskRollDay/riskCheckEquity) | `strategy.ts:644-743`, `910-917`, `1196-1230` |
| `profitFactor`/`winRate` | `strategy.ts:466-478` |
| snapshot/restore taxonomy | `strategy.ts:352-408` |
| Derived metrics | `src/engine/strategy-metrics.ts` (whole file; entry `:228`) |
| Portfolio engine | `src/engine/portfolio-engine.ts` |
| Driver (bar loop, rollback, onTick) | `src/engine/driver.ts:37-120` |
| Context hooks / snapshotMutable / restoreMutable / mintick / tradingDayKey | `src/runtime/context.ts:361-393`, `456-460`, `1166-1183` |
| Specs / references | `docs/portfolio-semantics.md`, `docs/strategy-broker.md`, `docs/tradingview-strategy-report-metrics.md` |

### Glossary of symbols

- **`size`** — signed open position (contracts): `>0` long, `<0` short, `0` flat.
- **`dir`** — direction: `DIR_LONG = +1`, `DIR_SHORT = -1`; `sign(x)` = +1/-1/0.
- **`m`** — margin fraction `= (long ? marginLong : marginShort) / 100`.
- **`mt` / `mintick`** — minimum price increment (default 0.01); ticks × mintick = price offset.
- **`slip`** — slippage price offset `= settings.slippage * mintick`, applied adversely.
- **`avgPrice`** — lot-weighted mean fill price of open lots; `NaN` while flat.
- **`realized` / `netProfit`** — closed-trade PnL net of both commission sides.
- **`openProfit`** — `size × (close − avgPrice)`; unrealized, point value 1.
- **`equity`** — `initial + Σrealized + Σ open PnL` (account-derived).
- **`base` (funds)** — `equityExcludingOpen(this)` = `initial + Σrealized (+ others' open PnL)`.
- **`peakEquity` / `valleyEquity`** — running high-/low-water equity marks, seeded at `account.initial`.
- **`maxFavMove` / `maxAdvMove`** — per-contract favorable/adverse price excursion on a lot (feeds per-trade run-up/drawdown).
- **`maxContractsAll/Long/Short`** — report-only running peak position exposure (TV "Max contracts held"), advanced by `recordExposure` after every size change.
- **`orderSeq` / `maxSeq`** — monotonic submission counter; exit brackets cover lots with `orderSeq <= maxSeq`.
- **`riskDayFills`** — genuinely-traded orders in the current trading day (feeds `max_intraday_filled_orders`).
- **`P` (portfolio)** — the total capital pot; `wᵢ` — sleeve funding fractions (sum 1, isolated only).
- **`periodsPerYear` / `annualize`** — bars per year and `√periodsPerYear` for volatility annualization.
- **`1e-9`** — the standard floating-point comparison tolerance (margin gate, risk thresholds, lot/size zeroing).
