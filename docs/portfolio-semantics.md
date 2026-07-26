# Portfolio semantics (PortfolioEngine)

**Status: v1.1** — v1 shipped with the `PortfolioEngine` (0.8.0); v1.1
(2026-07-10) hardened S7 with the Account mark broadcast (disjoint-clock halts,
found by the pinestack audit) and made per-sleeve `report().initialCapital`
read the account (the pot under shared mode), matching S2.

TradingView has no multi-symbol strategy, so nothing in Pine specifies what a
shared account means across symbols. This document IS that specification for
piner. The fidelity contract is scoped accordingly:

> **Per-sleeve behavior matches TradingView; portfolio composition follows this
> spec.** A sleeve's script sees its own symbol's bars, series, `barstate`, and
> position exactly as a single-symbol run — except where account state is
> explicitly portfolio-level below.

Fixtures: `test/portfolio-engine.test.ts` (gate V3 — isolated mode ≡ the
per-sleeve arithmetic oracle, bit-for-bit) and `test/portfolio-shared.test.ts`
(gate V4 — one fixture per clause).

## The allocation policy

| Mode                 | Meaning                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isolated` (default) | N private accounts funded `wᵢ·P`. Reproduces per-symbol runs exactly — equal-weight and weighted sleeve models are configurations of this mode.                          |
| `shared`             | One `Account(P)` behind every broker: sizing, funds checks, margin, and risk rules read portfolio equity. Trades can differ from any per-symbol run — that is the point. |

## Clauses

- **S1 — Funding.** The pot `P` defaults to `N ×` the script's
  `initial_capital`. Isolated mode splits it `wᵢ·P` (weights normalized,
  default equal) via the `EngineOptions.strategy` override; shared mode funds
  one `Account(P)`. _Degenerate identity:_ with no equity-referencing logic, no
  funds contention, and margins off, shared ≡ isolated.
- **S2 — Account read-backs are portfolio-level.** Inside any sleeve's script,
  `strategy.initial_capital`, `strategy.equity`, and the `*_percent`
  denominators read the account (the pot under shared mode). Divergence from
  single-symbol TV values under shared mode is intended and documented, not
  hidden.
- **S3 — Sizing draws on account equity.** `percent_of_equity` sizes against
  portfolio equity at the sleeve's fill moment — one sleeve's gains inflate
  another's next entry. `fixed`/`cash` sizing and explicit per-order `qty=` are
  unchanged.
- **S4 — Funds are first-come-first-served in clock order.** At each master
  timestamp, sleeves with a bar execute in **basket order**, whole-bar each
  (fills → body → close), so earlier sleeves' fills settle into the account
  before later sleeves size or pass funds checks. A funds check counts the rest
  of the basket's margin requirement as spoken for; an order that fails is
  rejected exactly as single-symbol TV rejects it — no queueing, no partials.
- **S5 — Valuation and intrabar convention.** Cross-sleeve reads value a
  position at its **last mark-to-market close** (its own live close while its
  bar is in progress). Each sleeve walks its own bar's assumed intrabar path
  (TV's open → nearer extreme → farther extreme → close), sequentially in
  basket order; cross-symbol intrabar interleaving is **not modeled**.
- **S6 — Margin is per-sleeve against the shared pot.** Each sleeve's
  `margin_long/short` gates its own orders and drives its own truncate-then-4×
  liquidation, with the account as funds base: other sleeves' open PnL cushions
  a call, other sleeves' margin requirements shrink the base. Liquidation only
  ever closes the violating sleeve's own position, at most once per sleeve/bar;
  under COOF the forced event recalculates that sleeve without increasing its
  filled-order risk count. There is **no cross-symbol
  netting** and no choosing which sleeve to cut.
- **S7 — Risk rules read portfolio equity and halt every sleeve.**
  `strategy.risk.max_drawdown` / `max_intraday_loss` evaluate on account
  equity, and **every mark of the pot is broadcast to every attached broker's
  peak/valley/day-max trackers** (`Account.broadcastMarks` →
  `foldEquityMarks`) — so a sleeve whose clock has no bar at the pot's peak
  still observes it (disjoint calendars, listing gaps). Each sleeve's rule
  then trips at its own next mark, force-closing and halting it — the
  portfolio halts within one bar per sleeve. Contract-denominated rules
  (`max_position_size`) stay per-sleeve. _(The 2026-07-09 audit found the
  original per-sleeve-sampling implementation under-measured shared drawdown
  on disjoint clocks; fixed 2026-07-10, pinned by the V4 disjoint-clock
  fixture.)_
- **S8 — Sleeves execute only on their own bars.** No phantom bars at master
  times where a sleeve has no bar: `barstate.*`, `bar_index`, series history,
  and session/day boundaries (for S7's intraday rules) are per-sleeve and
  identical to a single-symbol run — guaranteed by the historical stepper
  (`Engine.prepare`/`step`), which preserves `barstate.islast` /
  `last_bar_index` semantics the realtime `tick()` path cannot.
- **S9 — One quote currency.** All symbols are assumed to settle in the same
  currency. Asserted by convention, not converted.

Orders always target the sleeve's own symbol — Pine has no syntax for anything
else, so this is structural.

## Portfolio report conventions

- The portfolio `StrategyReport` (consumable by `computeStrategyMetrics`
  unchanged): plain sums for PnL/counters/commission/`marginCalls`; the merged
  ledger is symbol-tagged (`ClosedTrade.symbol`), exit-time sorted (ties keep
  basket order), `cumProfit` re-accumulated portfolio-wide.
- A per-sleeve `report().initialCapital` states the **account's** capital —
  the sleeve's `wᵢ·P` funding under isolated mode, the POT under shared mode —
  matching what `strategy.initial_capital` reads inside the script (S2). Do
  not sum it across sleeves under shared mode (it is the same pot N times);
  the portfolio report's own `initialCapital` is `P`.
- The portfolio equity curve is indexed by the **master clock** (sorted union
  of sleeve bar times). Isolated: Σ of sleeve marks, funding before a sleeve's
  first bar (pre-activation cash), last mark after its data ends (ragged
  tails). Shared: the master bar's last-stepped mark — the most complete state
  of the pot at that timestamp.
- **Drawdown/run-up are close-to-close on that curve** in both modes.
  Per-sleeve `maxDrawdown` is an intrabar-path extreme; sleeves' worst intrabar
  moments don't coincide and cross-symbol intrabar paths are unknowable (S5),
  so close-to-close is the honest portfolio number. Per-sleeve intrabar
  extremes remain available in each sleeve's own report.
- Exposure: `barsProcessed` = master-axis length; `barsInMarket` counts master
  bars where **any** sleeve holds a position after its fill pass.
- No buy-&-hold benchmark: `computeStrategyMetrics`' `bars` option takes one
  OHLC series and is meaningless for a basket — leave it unset.

## Explicitly out of scope

Cross-symbol margin netting (no reference semantics anywhere; liquidation
choosing which sleeve to cut is unspecifiable), FX conversion between quote
currencies, rebalancing between isolated sleeves over time, per-sleeve scripts
or timeframes. See the pinestack plan (`portfolio-aggregation-plan.md`) §11 for
the extension list.
