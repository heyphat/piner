# TradingView strategy report metrics

A reference compiled from TradingView's [Strategy report metrics](https://www.tradingview.com/support/folders/43000599093-strategy-report-metrics/)
help-center folder (53 articles, fetched 2026-07-06). Each entry gives
TradingView's definition/formula, then a **Piner** line cross-referencing
whether/where the metric exists in this engine:

- `src/runtime/builtins/strategy.ts` — the `strategy.*` Pine namespace + broker
  (live report fields, TV-exact).
- `src/engine/strategy-metrics.ts` — `computeStrategyMetrics`, a pure
  post-hoc reduction of the report (tearsheet analytics, not Pine builtins).
- See `docs/strategy-broker.md` §7/§7.1/§11 for the broker's execution model
  and documented deviations.

This is a documentation reference, not a coverage audit — "not implemented"
below means "no field currently surfaces this," not a commitment to add it.

## 1. Capital, PnL & benchmark

### Initial capital

**Definition:** The starting account balance a strategy uses at the beginning of backtesting, simulating the funds available for trading. Differs from "Account size," the real-time balance during live execution.
**Formula:** Not explicitly formulaic. Default 1,000,000 in the chart's base currency; configurable via the Properties tab or `strategy(..., initial_capital=...)`, settings-UI overriding code.
**Notes:** Sets baseline buying power, affects percentage-return sizing/compounding, and acts as a drawdown buffer.
**Piner:** `StrategySettings.initialCapital` (default 1,000,000), `report().initialCapital`. Implemented.

### Open PnL

**Definition:** The real-time valuation of active (open) positions at current market prices — unrealized gain/loss if closed immediately.
**Formula:** Not explicitly formulaic.
**Notes:** Displays 0 when no positions are active.
**Piner:** `strategy.openprofit` (marks the open position against the current bar's close). Implemented.

### Net PnL

**Definition:** Cumulative realized profit/loss from all closed trades over the period.
**Formula:** Sum of all closed trades' Net PnL.
**Notes:** Excludes open positions.
**Piner:** `strategy.netprofit`, `report().netProfit`. Implemented.

### Gross profit

**Definition:** Total realized profit from all winning trades.
**Formula:** Cumulative sum of positive Net PnL entries.
**Notes:** Excludes open positions; commission is deducted per winning trade before summing.
**Piner:** `strategy.grossprofit`, `report().grossProfit`. Implemented.

### Gross loss

**Definition:** Total realized loss from all losing trades.
**Formula:** Cumulative sum of negative Net PnL entries.
**Notes:** Excludes open positions; commission increases loss magnitude.
**Piner:** `strategy.grossloss`, `report().grossLoss`. Implemented.

### Profit factor

**Definition:** Profit generated per unit of loss incurred.
**Formula:** `|sum of winning trades| / |sum of losing trades|` (Gross profit ÷ |Gross loss|).
**Notes:** > 1.0 profitable, < 1.0 losing. Realized figures only.
**Piner:** `StrategyBroker.profitFactor` convenience getter (not a Pine builtin — matches how TV's Strategy Tester UI surfaces it, not `strategy.*`). Implemented.

### Commission paid

**Definition:** Total cumulative transaction fees charged for executing trades.
**Formula:** Cumulative sum of documented fees.
**Notes:** Excludes slippage; already deducted from Net PnL, not additional on top.
**Piner:** `report().totalCommission` — both sides' fees, matches TV's "Commission Paid." Implemented.

### Expected payoff

**Definition:** Average profit/loss per closed position — statistical expectancy per trade.
**Formula:** Net PnL ÷ number of closed trades.
**Notes:** Positive → long-term profitability potential; based only on closed trades.
**Piner:** `strategy.avg_trade` / `StrategyMetrics.expectancy` (`src/engine/strategy-metrics.ts`, documented as "mean closed-trade profit (TradingView's avg trade)"). Implemented.

### Buy and hold PnL

**Definition:** Theoretical PnL from investing all initial capital at the first trade and holding, unmanaged, to the end.
**Formula:** Not explicitly formulaic.
**Notes:** Passive benchmark; ignores transaction costs and timing.
**Piner:** `StrategyMetrics.buyHoldPnL` = initial capital × the buy-&-hold return (same basis as the % gain below). Implemented.

### Buy and hold % gain

**Definition:** Percentage price change from the strategy's first position to the final bar — the market's raw return.
**Formula:** `(end price − start price) / start price` (exact TV formula given as an image, not transcribed).
**Notes:** Percentage-based so it's comparable across different starting capitals; the main benchmark for "Alpha."
**Piner:** `StrategyMetrics.buyHoldReturnPercent` — enters at the first closed trade's entry fill (TV: "from when the strategy's first position was opened"), exits at the last close; falls back to the second bar's open when the run produced no closed trades. Needs `bars` passed to `computeStrategyMetrics`; 0 without it. Note: the entry fill price includes configured slippage, which TV's "asset price" basis may not. Implemented.

### Strategy outperformance

**Definition:** "Alpha" — excess return of the strategy vs. buy-and-hold over the same period.
**Formula:** Net Profit − Buy & Hold Return ($).
**Notes:** Absolute excess return only; does not risk-adjust.
**Piner:** `StrategyMetrics.outperformance`. Implemented.

## 2. Risk-adjusted ratios

### Sharpe Ratio

**Definition:** Risk-adjusted performance — return earned per unit of return-variability risk. Higher → smoother equity curve.
**Formula:** `(MR − RFR) / SD` where MR = average monthly return, RFR = risk-free rate (TV default 2% annually, configurable), SD = standard deviation of returns.
**Notes:** TV's default risk-free rate is 2%/year; "risk" is defined as total variability (up + down).
**Piner:** `StrategyMetrics.sharpe`. **Method deviation:** piner uses per-bar simple equity returns (including flat bars) rather than monthly returns, and defaults `riskFreeRate` to **0** (not TV's 2%) — pass `opts.riskFreeRate` to match. Annualization basis is configurable (`periodsPerYear` → empirical bars/year → timeframe-as-24/7 → 252) rather than TV's fixed monthly convention. See `strategy-metrics.ts` header comment and `docs/strategy-broker.md` §7.1.

### Sortino Ratio

**Definition:** Like Sharpe, but penalizes only downside volatility (returns below a target), not total volatility.
**Formula:** Same as Sharpe but SD replaced by downside deviation (DD) — RMS of returns below target, divided by total return count.
**Notes:** `risk_free_rate` is a `strategy()` parameter in Pine.
**Piner:** `StrategyMetrics.sortino`. Downside deviation is RMS of **negative** returns divided by the **downside count** (not total count — a documented method choice, see `strategy-metrics.ts`); `Infinity` when there's no downside and the mean is positive. Same risk-free-rate/annualization deviations as Sharpe above.

## 3. Trade counts & statistics

### Total trades

**Definition:** Count of all completed (opened + closed) trade cycles.
**Formula:** Not explicitly formulaic.
**Notes:** Excludes open positions and unfilled orders; TV flags <30 trades as an overfitting risk signal.
**Piner:** `report().closedTrades.length`, `strategy.closedtrades`. Implemented.

### Total open trades

**Definition:** Count of currently active, unclosed entries.
**Formula:** Not explicitly formulaic.
**Notes:** Defaults to 0 when flat.
**Piner:** `strategy.opentrades` (one per lot). Implemented.

### Total winners

**Definition:** Count of closed positions with strictly positive PnL.
**Formula:** Not explicitly formulaic.
**Notes:** Excludes losers, even trades, and open positions.
**Piner:** `strategy.wintrades`, `report().wins`. Implemented.

### Total losers

**Definition:** Count of closed positions with strictly negative PnL.
**Formula:** Not explicitly formulaic.
**Notes:** Excludes winners, even trades, and open positions.
**Piner:** `strategy.losstrades`, `report().losses`. Implemented.

### Percent profitable

**Definition:** Share of closed trades that were winners.
**Formula:** Winning trades ÷ total closed trades.
**Notes:** Even trades excluded from the winning-trade numerator but included in the total. High win rate ≠ profitable in isolation.
**Piner:** `StrategyBroker.winRate` convenience getter. Implemented.

### Average PnL

**Definition:** Mean result per closed position.
**Formula:** Net PnL ÷ total closed trades.
**Notes:** Same formula as Expected payoff — TV documents it as a distinct report row but the calculation is identical.
**Piner:** Same field as Expected payoff: `strategy.avg_trade` / `StrategyMetrics.expectancy`. Implemented.

### Average profit

**Definition:** Mean profit across winning trades.
**Formula:** Total profit from winners ÷ number of winners.
**Notes:** Excludes open trades, losers, and even trades.
**Piner:** `strategy.avg_winning_trade` (+`_percent`, basis `|entryPrice × qty|`). Implemented.

### Average loss

**Definition:** Mean loss across losing trades.
**Formula:** Total loss from losers ÷ number of losers.
**Notes:** "The most direct way to control total risk."
**Piner:** `strategy.avg_losing_trade` (+`_percent`). Implemented.

### Average profit / average loss

**Definition:** Ratio of average win size to average loss size — the reward:risk lever independent of win rate.
**Formula:** Average profit ÷ average loss.
**Notes:** High ratio tolerates a low win rate; low ratio demands a high win rate.
**Piner:** `StrategyMetrics.avgWinLossRatio` (0 when there are no losers). Implemented.

### Largest profit

**Definition:** The single most profitable closed position.
**Formula:** Not explicitly formulaic.
**Notes:** Excludes open trades; a disproportionate share of Net PnL here signals reliance on an outlier.
**Piner:** `StrategyMetrics.largestWin` (≥ 0). Implemented.

### Largest profit as % of gross profit

**Definition:** How much the single best winner contributes to total gross profit.
**Formula:** Largest winning trade ÷ Gross profit × 100.
**Notes:** >30% suggests fragility; <10% suggests consistency.
**Piner:** `StrategyMetrics.largestWinPercentOfGrossProfit`. Implemented.

### Largest loss

**Definition:** The single greatest realized loss.
**Formula:** Not explicitly formulaic.
**Notes:** Excludes open (unrealized) losses even if currently deeper.
**Piner:** `StrategyMetrics.largestLoss` (≤ 0). Implemented.

### Largest loss as % of gross loss

**Definition:** Concentration of risk within losing trades.
**Formula:** Largest losing trade ÷ Gross loss × 100.
**Notes:** >30% ("Fat Tail" risk) vs. <10% ("Controlled Risk").
**Piner:** `StrategyMetrics.largestLossPercentOfGrossLoss` (positive percent). Implemented.

### Average bars in trades

**Definition:** Mean bar-count duration across all closed trades.
**Formula:** Not explicitly formulaic.
**Notes:** Closed trades only.
**Piner:** `StrategyMetrics.avgBarsInTrade` ("TradingView's avg # bars in trades"). Implemented.

### Average bars in winners

**Definition:** Mean bar-count duration for winning trades only.
**Formula:** Not explicitly formulaic.
**Piner:** `StrategyMetrics.avgBarsInWinners`. Implemented.

### Average bars in losers

**Definition:** Mean bar-count duration for losing trades only.
**Formula:** Not explicitly formulaic.
**Piner:** `StrategyMetrics.avgBarsInLosers`. Implemented.

## 4. Annualized & capital-efficiency returns

### Annualized return (CAGR)

**Definition:** Rate of return of all trades, based on initial capital, annualized — how much capital would grow per year if the measured-period performance continued.
**Formula:** Not explicitly formulaic (conceptual: extrapolate measured-period performance to a full year). Re-verified 2026-07-06: the article publishes no equation, time-span convention, or day-count basis.
**Piner:** `StrategyMetrics.cagrPercent`. Prefers the real bar-time span (`opts.barTimes`); falls back to `equity.length / periodsPerYear`. Implemented (piner's convention documented in `strategy-metrics.ts`; TV's exact convention unpublished).

### Return on initial capital

**Definition:** Profit/loss as a percentage of starting capital over the period.
**Formula:** Not explicitly formulaic.
**Piner:** `StrategyMetrics.returnOnInitialCapitalPercent` = net profit ÷ initial capital × 100. Implemented.

### Account size required

**Definition:** Minimum capital to safely trade the strategy — covers the max simultaneous position count (with intrabar drawdown on them) and survives the worst historical drawdown at the worst possible entry timing.
**Formula:** Not explicitly formulaic. Re-verified 2026-07-06: the article gives only the conceptual framework, no calculation steps or worked example.
**Piner:** Not implemented — deliberately, since TV publishes no formula and inventing one would break parity claims.

### Return on account size required

**Definition:** Profit relative to "Account size required" rather than initial capital — net return on the real capital cost of trading the strategy.
**Formula:** Not explicitly formulaic; denominator is "Account size required." Re-verified 2026-07-06: no formula published.
**Piner:** Not implemented (depends on Account size required, above).

### Net profit as % of largest loss

**Definition:** How far total net profit exceeds the single largest losing trade.
**Formula:** Net profit ÷ |largest losing trade| × 100 (implied, not stated explicitly by TV).
**Piner:** `StrategyMetrics.netProfitPercentOfLargestLoss`. Implemented.

## 5. Margin

**None of this section is modeled in piner.** Per `docs/strategy-broker.md` §11: margin (`margin_long`/`margin_short`, liquidation) is not modeled; `margin_liquidation_price` always reads `na`, matching Pine's behavior when a strategy declares no `margin_long`/`margin_short`.

### Average margin used

**Definition:** Average per-bar used-margin value (sampled at bar close) across the tested period.
**Formula:** Sum of per-bar-close used margin ÷ number of bars.
**Piner:** Not implemented — no margin model.

### Max margin used

**Definition:** Peak margin required at any point in the tested period.
**Formula:** Not explicitly formulaic.
**Piner:** Not implemented.

### Margin efficiency

**Definition:** Profit generated per dollar of margin committed.
**Formula:** Not explicitly formulaic. Re-verified 2026-07-06: the article does not specify the denominator (average vs. max margin) or units.
**Piner:** Not implemented.

### Margin calls

**Definition:** Count of margin calls triggered over the tested period.
**Formula:** Not explicitly formulaic.
**Piner:** Not implemented.

## 6. Run-up

**Basis note:** the Pine builtins `strategy.max_runup`/`strategy.max_drawdown` track the **intrabar** equity path (open → nearer extreme → farther extreme → close per bar; `docs/strategy-broker.md` §7) and correspond to TV's _intrabar_ variants. The _close-to-close_ family is computed separately by `computeStrategyMetrics` from the bar-close equity curve. TV publishes the phase definitions in prose but the formulas only as images (re-verified 2026-07-06), so piner implements the quoted prose: a run-up phase runs "from a local minimum to a new peak"; a drawdown phase "from a peak to the recovery to the previous peak" (an unrecovered trailing drawdown is not a completed phase and is excluded from the _averages_, while the _max_ variants require no recovery).

### Average run-up duration (close-to-close)

**Definition:** Average number of calendar days equity spends rising from a local minimum to a new peak, using close-only equity.
**Formula:** Per-run-up-period duration in calendar days, averaged across all run-up periods.
**Piner:** `StrategyMetrics.avgRunupDurationDays` (calendar days; 0 without `barTimes`). Implemented per the prose above.

### Average run-up (close-to-close)

**Definition:** Average equity growth across all close-to-close upward phases (local min → new peak).
**Formula:** Not explicitly formulaic (average of all individual close-to-close run-ups; formula published only as an image).
**Piner:** `StrategyMetrics.avgRunupCloseToClose` (currency). Implemented per the prose above.

### Max run-up (close-to-close)

**Definition:** Largest single equity increase over the backtest, using bar closes only.
**Formula:** Not explicitly formulaic.
**Notes:** More conservative than the intrabar variant since it ignores intrabar highs.
**Piner:** `StrategyMetrics.maxRunupCloseToClose` — the largest rise of bar-close equity above its running minimum. Implemented.

### Max run-up (intrabar)

**Definition:** Largest possible win the strategy could have achieved on any single trade, using the best intrabar price reached while a position was open.
**Formula:** Per bar while a position is open — Long: `Equity_on_Entry − Min_Equity + Contracts × (Current_High − Entry_Price)`; Short: `Equity_on_Entry − Min_Equity + Contracts × (Entry_Price − Current_Low)`. Take the max across all bars/trades.
**Notes:** On a trade's closing bar the full intrabar path (Open→High/Low→Close) must be walked; on reversals the closed position's equity becomes the next trade's `Min_Equity` baseline.
**Piner:** `strategy.max_runup` (aggregate) and per-trade `.max_runup(i)` (+`_percent`, tracked as per-contract price moves each mark-to-market so partial closes scale correctly). Implemented — this is exactly the intrabar mark-to-market walk `docs/strategy-broker.md` §7 describes.

### Max run-up as % of initial capital (intrabar)

**Definition:** Largest unrealized equity gain above initial capital, as a percentage of initial capital, measured intrabar.
**Formula:** Not explicitly formulaic (basis = initial capital).
**Piner:** `StrategyMetrics.maxRunupPercentOfInitialCapital` — the broker's intrabar `maxRunup` rebased onto initial capital. Implemented. (The Pine builtin `strategy.max_runup_percent` keeps its running-valley basis — a different TV surface, left TV-exact.)

## 7. Drawdown

### Average drawdown duration (close-to-close)

**Definition:** Average calendar days from an equity peak, through decline, to recovery back to that peak, using close-only equity.
**Formula:** Not explicitly formulaic (per-drawdown duration, averaged).
**Piner:** `StrategyMetrics.avgDrawdownDurationDays` (calendar days, peak → recovery; 0 without `barTimes`). Implemented per the §6 basis note.

### Average drawdown (close-to-close)

**Definition:** Average equity decline across all close-to-close drawdown phases (peak → low → recovery).
**Formula:** Not explicitly formulaic (average of all individual close-to-close drawdowns).
**Piner:** `StrategyMetrics.avgDrawdownCloseToClose` (currency; completed phases only). Implemented.

### Max drawdown (close-to-close)

**Definition:** Largest equity drop from a prior closing high to a subsequent closing low.
**Formula:** Not explicitly formulaic.
**Notes:** Less sensitive to intraday swings than the intrabar variant.
**Piner:** `StrategyMetrics.maxDrawdownCloseToClose` — the largest drop of bar-close equity below its running maximum (recovery not required, per TV's wording). Implemented.

### Max drawdown (intrabar)

**Definition:** Largest possible drawdown across all trades, evaluated on every bar a position was open (intrabar highs/lows, not just closes).
**Formula:** Per bar while a position is open — Long: `Max_Equity − Equity_on_Entry + Contracts × (Entry_Price − Current_Low)`; Short: `Max_Equity − Equity_on_Entry + Contracts × (Current_High − Entry_Price)`. Take the max across all bars/trades.
**Piner:** `strategy.max_drawdown` (aggregate) and per-trade `.max_drawdown(i)` (+`_percent`). Also used by `strategy.risk.max_drawdown(...)` halt logic (`docs/strategy-broker.md` §8). Implemented — matches the intrabar walk exactly.

### Max drawdown as % of initial capital (intrabar)

**Definition:** Max intrabar drawdown as a percentage of initial capital.
**Formula:** Not explicitly formulaic (basis = initial capital).
**Piner:** `StrategyMetrics.maxDrawdownPercentOfInitialCapital` — the broker's intrabar `maxDrawdown` rebased onto initial capital. Implemented. (The Pine builtin `strategy.max_drawdown_percent` keeps its running-peak basis, and `strategy.risk.max_drawdown(value, 'percent', ...)` likewise — both left TV-exact per `docs/strategy-broker.md` §7–8.)

### Return of max drawdown

**Definition:** Profit earned relative to the largest equity drawdown — return per unit of maximum risk taken.
**Formula:** Not explicitly formulaic. Re-verified 2026-07-06: the article gives neither the exact numerator/denominator nor whether it is a ratio or percent.
**Piner:** Not implemented as such (formula unpublished). Close cousin exists: `StrategyMetrics.calmar` = CAGR % ÷ `maxDrawdownPercent` (the broker's intrabar-path drawdown) — an annualized-return version of the same idea.

## 8. Exposure & other

### Max contracts held

**Definition:** Peak simultaneous position size (contracts/shares/units) held at any point.
**Formula:** Not explicitly formulaic.
**Piner:** `strategy.max_contracts_held_all` / `_long` / `_short`. Implemented.

### Even trades

**Definition:** Count of closed trades with exactly zero profit after costs (commissions, slippage).
**Formula:** Profit == 0 net of costs.
**Notes:** A trade breaking even on price but paying commission is NOT an even trade.
**Piner:** `strategy.eventrades`, `report().evens`. An even trade also breaks both win/loss streaks in `StrategyMetrics` consecutive-count tracking. Implemented.

## 9. Liquidation

**Not modeled in piner** — consistent with no margin model (§5); liquidation is a margin-account concept.

### Total liquidated volume

**Definition:** Total notional value of all liquidated (forced-closure) trades over the period.
**Formula:** Per-trade: quantity × trade close price, summed across liquidated trades.
**Piner:** Not implemented.

### Largest liquidated volume

**Definition:** Maximum volume executed within a single liquidation event.
**Formula:** Not explicitly formulaic.
**Notes:** A single liquidation event can span multiple simultaneous trade fills when size exceeds one counterparty's liquidity — these must be aggregated.
**Piner:** Not implemented.

## Summary: gaps vs. TradingView

Updated 2026-07-06 after a gap-closing pass (every remaining gap was re-checked
against the original TradingView article; nothing below is implementable from
what TV publishes without inventing semantics):

**Remaining gaps — no piner equivalent (9 of 53):**

- **Margin/liquidation model absent** (6): Average/Max margin used, Margin
  efficiency, Margin calls, Total/Largest liquidated volume. Piner models no
  margin (`docs/strategy-broker.md` §11); TV additionally publishes no formula
  for Margin efficiency, and Margin calls / liquidation require simulating
  TV's forced-liquidation walk.
- **Formula unpublished by TradingView** (3): Account size required, Return on
  account size required, Return of max drawdown — the articles are conceptual
  prose only (verified against each article). Not implemented rather than
  guessed. (`calmar` remains the documented cousin of Return of max drawdown.)

**Everything else (44 of 53) has a direct piner field**, split across:

- Pine builtins / broker report (`src/runtime/builtins/strategy.ts`) — the
  `strategy.*` family, TV-exact.
- `computeStrategyMetrics` (`src/engine/strategy-metrics.ts`) — the tearsheet,
  including (added in the gap-closing pass): `avgWinLossRatio`,
  `largestWinPercentOfGrossProfit`, `largestLossPercentOfGrossLoss`,
  `netProfitPercentOfLargestLoss`, `avgBarsInWinners`/`avgBarsInLosers`,
  `returnOnInitialCapitalPercent`, `buyHoldPnL`,
  `maxRunupPercentOfInitialCapital`/`maxDrawdownPercentOfInitialCapital`, and
  the close-to-close family `maxRunupCloseToClose`/`maxDrawdownCloseToClose`/
  `avgRunupCloseToClose`/`avgDrawdownCloseToClose`/`avgRunupDurationDays`/
  `avgDrawdownDurationDays`.

**Known method deviations (documented, deliberate):**

- Sharpe/Sortino use per-bar returns with a 0% default risk-free rate
  (fractal-chart-compatible) vs. TV's monthly returns with a 2% default —
  pass `riskFreeRate` to narrow the gap (§2).
- CAGR/annualization conventions are piner's own since TV publishes none (§4).
- Buy & hold uses the first closed trade's entry **fill** (slippage included)
  as its price basis; TV's "asset price" basis may exclude slippage (§1).
