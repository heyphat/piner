/**
 * Derived, risk-adjusted backtest metrics — a PURE reduction of the broker-verbatim
 * `StrategyReport` (plus bar times / timeframe for annualization). Deterministic:
 * no clock, no I/O, no market-calendar assumptions.
 *
 * These are analytics on top of the report, not Pine builtins — TradingView shows
 * Sharpe/Sortino etc. in the Strategy Tester UI, not in the Pine language, so the
 * `strategy.*` namespace is deliberately untouched.
 *
 * Method notes (kept compatible with fractal-chart's `stats.ts` so both hosts can
 * report identical numbers given the same `periodsPerYear`):
 *  - Returns are per-bar simple returns of the equity curve INCLUDING flat bars —
 *    dropping idle bars shrinks the sample, inflating Sharpe toward infinity.
 *  - Sortino uses the downside deviation over the NEGATIVE returns only (RMS with
 *    the downside count as divisor), annualized like Sharpe; no downside with a
 *    positive mean → Infinity.
 *  - Annualization: `opts.periodsPerYear` when the host has a market-calendar
 *    convention (e.g. 252×6.5h US equities); otherwise EMPIRICAL bars-per-year from
 *    real bar times (365.25-day years); otherwise derived from the timeframe as a
 *    24/7 market (crypto-style); otherwise 252.
 */
import type { StrategyReport } from '../runtime/builtins/strategy.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export interface StrategyMetricsOptions {
  /** Per-bar epoch-ms timestamps aligned with `report.equityCurve` indices
   *  (e.g. the run's bars mapped to `bar.time`). Enables real-time CAGR and
   *  empirical annualization. */
  barTimes?: ArrayLike<number>;
  /** The run's bars — enables the buy-&-hold benchmark. Entry is the second
   *  bar's open (mirroring next-bar-open fills), exit the last close. */
  bars?: ArrayLike<{ open: number; close: number }>;
  /** Seconds per bar (piner timeframe seconds) — annualization fallback when bar
   *  times are absent/synthetic, treating the market as 24/7. */
  timeframeSeconds?: number;
  /** Host override for return-annualization periods per year (e.g. 252 daily bars,
   *  252*6.5 hourly US-equity bars). Takes precedence over everything else. */
  periodsPerYear?: number;
  /** Annual risk-free rate as a fraction (e.g. 0.02). Default 0. */
  riskFreeRate?: number;
}

export interface StrategyMetrics {
  /** Annualized Sharpe ratio of per-bar equity returns (0 when undefined). */
  sharpe: number;
  /** Annualized Sortino ratio (Infinity when there is no downside and mean > 0). */
  sortino: number;
  /** Annualized return volatility, percent. */
  volatilityPercent: number;
  /** Compound annual growth rate, percent (real bar-time span when available). */
  cagrPercent: number;
  /** Calmar ratio: CAGR % / max drawdown % (the broker's intrabar-path drawdown). */
  calmar: number;
  /** Market exposure: bars with an open position / bars processed, percent. */
  exposurePercent: number;
  /** Expectancy: mean closed-trade profit (TradingView's "avg trade"). */
  expectancy: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  /** Largest single-trade profit (≥ 0) and loss (≤ 0). */
  largestWin: number;
  largestLoss: number;
  /** Mean bars held per closed trade (TradingView's "avg # bars in trades"). */
  avgBarsInTrade: number;
  /** Mean bars held per winning / losing closed trade (TV "avg # bars in
   *  winning/losing trades"; 0 when there are none). */
  avgBarsInWinners: number;
  avgBarsInLosers: number;
  /** TV "Average profit / average loss": mean winning-trade profit divided by the
   *  mean losing-trade loss magnitude (0 when there are no losers). */
  avgWinLossRatio: number;
  /** TV "Largest profit as % of gross profit" (0 when gross profit is 0). */
  largestWinPercentOfGrossProfit: number;
  /** TV "Largest loss as % of gross loss", positive percent (0 when gross loss is 0). */
  largestLossPercentOfGrossLoss: number;
  /** TV "Net profit as % of largest loss": net profit over the largest single
   *  loss magnitude, percent (0 when there is no losing trade). */
  netProfitPercentOfLargestLoss: number;
  /** TV "Return on initial capital": net profit as % of initial capital. */
  returnOnInitialCapitalPercent: number;
  /** Buy-&-hold benchmark return over the same bars, percent (0 without `bars`).
   *  Basis: the first closed trade's entry fill (TV: "from when the strategy's
   *  first position was opened"), falling back to the second bar's open when the
   *  run produced no closed trades. */
  buyHoldReturnPercent: number;
  /** TV "Buy and hold PnL" ($): initial capital × the buy-&-hold return. */
  buyHoldPnL: number;
  /** Net profit minus the buy-&-hold PnL on the same capital (0 without `bars`). */
  outperformance: number;
  /** TV "Max run-up / drawdown as % of initial capital (intrabar)": the broker's
   *  intrabar-path extremes rebased onto initial capital (the Pine builtins'
   *  `_percent` fields use the running valley/peak instead). */
  maxRunupPercentOfInitialCapital: number;
  maxDrawdownPercentOfInitialCapital: number;
  /** Close-to-close (bar-close equity only) extremes, currency. TV: "the largest
   *  increase/drop in account equity measured using only bar closing prices". */
  maxRunupCloseToClose: number;
  maxDrawdownCloseToClose: number;
  /** TV "Average run-up/drawdown (close-to-close)": mean phase magnitude, currency.
   *  A drawdown phase spans a peak → recovery to that peak (incomplete trailing
   *  phases are excluded); a run-up phase spans a local minimum → the last new
   *  peak it produces. */
  avgRunupCloseToClose: number;
  avgDrawdownCloseToClose: number;
  /** TV "Average run-up/drawdown duration (close-to-close)": mean phase length in
   *  calendar days (0 without `barTimes`). */
  avgRunupDurationDays: number;
  avgDrawdownDurationDays: number;
  /** The annualization actually used (for reproducibility/debugging). */
  periodsPerYear: number;
}

/** Equity points that actually exist (the curve is sparse before activation),
 *  paired with their bar time when the caller supplied one. */
function finitePoints(
  curve: readonly number[],
  times?: ArrayLike<number>,
): { equity: number[]; time: number[] } {
  const equity: number[] = [];
  const time: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i];
    if (!Number.isFinite(v)) continue;
    equity.push(v);
    const t = times?.[i];
    time.push(typeof t === 'number' && Number.isFinite(t) ? t : NaN);
  }
  return { equity, time };
}

/** Years spanned by the finite equity points' real timestamps, else NaN. */
function spanYears(time: number[]): number {
  const first = time.find((t) => Number.isFinite(t));
  const last = [...time].reverse().find((t) => Number.isFinite(t));
  if (first == null || last == null || !(last > first)) return NaN;
  return (last - first) / MS_PER_YEAR;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Close-to-close run-up/drawdown decomposition of the bar-close equity curve,
 *  per the TradingView report definitions (docs/tradingview-strategy-report-metrics.md):
 *  - a DRAWDOWN phase runs "from a peak to the recovery to the previous peak";
 *    magnitude = peak − lowest trough within the phase. A trailing drawdown that
 *    never recovers is not a completed phase → excluded from the averages.
 *  - a RUN-UP phase runs "from a local minimum to a new peak": from the previous
 *    drawdown's trough (or the curve's start) to the last new equity high made
 *    before the next decline.
 *  - the MAX extremes need no phase completion: the largest rise above the
 *    running minimum / largest drop below the running maximum.
 *  Durations are calendar days between the phase's boundary bar times; phases
 *  with non-finite times are skipped for duration averaging only.
 */
function closeToClosePhases(equity: number[], time: number[]) {
  const out = {
    maxRunup: 0,
    maxDrawdown: 0,
    avgRunup: 0,
    avgDrawdown: 0,
    avgRunupDays: 0,
    avgDrawdownDays: 0,
  };
  if (equity.length < 2) return out;

  let runMin = equity[0];
  let peak = equity[0];
  let peakT = time[0];
  let runStart = equity[0]; // current run-up's origin (a local minimum)
  let runStartT = time[0];
  let inDD = false;
  let ddTrough = 0;
  let ddTroughT = NaN;
  const ruMag: number[] = [];
  const ruDays: number[] = [];
  const ddMag: number[] = [];
  const ddDays: number[] = [];

  const pushRunup = () => {
    if (peak > runStart) {
      ruMag.push(peak - runStart);
      const d = (peakT - runStartT) / MS_PER_DAY;
      if (Number.isFinite(d)) ruDays.push(d);
    }
  };

  for (let i = 1; i < equity.length; i++) {
    const v = equity[i];
    if (v < runMin) runMin = v;
    if (v - runMin > out.maxRunup) out.maxRunup = v - runMin;
    if (peak - v > out.maxDrawdown) out.maxDrawdown = peak - v;

    if (v >= peak) {
      if (inDD) {
        // recovery to the previous peak: the drawdown phase completes, and the
        // next run-up phase originates at its trough.
        ddMag.push(peak - ddTrough);
        const d = (time[i] - peakT) / MS_PER_DAY;
        if (Number.isFinite(d)) ddDays.push(d);
        runStart = ddTrough;
        runStartT = ddTroughT;
        inDD = false;
      }
      peak = v;
      peakT = time[i];
    } else if (!inDD) {
      // decline below the running peak: the run-up that ended at that peak is
      // complete; a drawdown phase begins.
      pushRunup();
      inDD = true;
      ddTrough = v;
      ddTroughT = time[i];
    } else if (v < ddTrough) {
      ddTrough = v;
      ddTroughT = time[i];
    }
  }
  if (!inDD) pushRunup(); // curve ended at/above water: the final run-up completed

  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  out.avgRunup = mean(ruMag);
  out.avgDrawdown = mean(ddMag);
  out.avgRunupDays = mean(ruDays);
  out.avgDrawdownDays = mean(ddDays);
  return out;
}

export function computeStrategyMetrics(
  report: StrategyReport,
  opts: StrategyMetricsOptions = {},
): StrategyMetrics {
  const { equity, time } = finitePoints(report.equityCurve, opts.barTimes);
  const years = spanYears(time);

  // ── annualization basis ─
  let periodsPerYear = opts.periodsPerYear ?? NaN;
  if (!(periodsPerYear > 0) && years > 0 && equity.length > 1)
    periodsPerYear = (equity.length - 1) / years; // empirical bars/year
  if (!(periodsPerYear > 0) && opts.timeframeSeconds && opts.timeframeSeconds > 0)
    periodsPerYear = (365.25 * 86400) / opts.timeframeSeconds; // 24/7 market
  if (!(periodsPerYear > 0)) periodsPerYear = 252;

  // ── per-bar returns (flat bars included) ─
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev === 0) continue;
    const r = (equity[i] - prev) / prev;
    if (Number.isFinite(r)) returns.push(r);
  }
  const n = returns.length;
  const mean = n ? returns.reduce((s, r) => s + r, 0) / n : 0;
  const variance = n ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const annualize = Math.sqrt(periodsPerYear);
  const rfPerPeriod = (opts.riskFreeRate ?? 0) / periodsPerYear;
  const excess = mean - rfPerPeriod;

  const sharpe = std > 0 ? (excess / std) * annualize : 0;
  const downside = returns.filter((r) => r < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0;
  const sortino = downsideDev > 0 ? (excess / downsideDev) * annualize : excess > 0 ? Infinity : 0;

  // ── CAGR / Calmar ─
  const initial = report.initialCapital;
  const final = equity.length ? equity[equity.length - 1] : initial;
  const cagrYears = years > 0 ? years : equity.length > 1 ? equity.length / periodsPerYear : 0;
  const cagrPercent =
    cagrYears > 0 && initial > 0 && final > 0
      ? (Math.pow(final / initial, 1 / cagrYears) - 1) * 100
      : 0;
  const calmar = report.maxDrawdownPercent > 0 ? cagrPercent / report.maxDrawdownPercent : 0;

  // ── trade-ledger stats ─
  const trades = report.closedTrades;
  const expectancy = trades.length ? report.netProfit / trades.length : 0;
  let maxConsecutiveWins = 0,
    maxConsecutiveLosses = 0,
    winStreak = 0,
    lossStreak = 0,
    largestWin = 0,
    largestLoss = 0,
    barsHeld = 0,
    winCount = 0,
    lossCount = 0,
    winSum = 0,
    lossSum = 0, // magnitude (≥ 0)
    winBars = 0,
    lossBars = 0;
  for (const t of trades) {
    const held = t.exitBar - t.entryBar;
    if (t.profit > 0) {
      winStreak++;
      lossStreak = 0;
      winCount++;
      winSum += t.profit;
      winBars += held;
    } else if (t.profit < 0) {
      lossStreak++;
      winStreak = 0;
      lossCount++;
      lossSum += -t.profit;
      lossBars += held;
    } else {
      winStreak = 0;
      lossStreak = 0; // an even trade breaks both streaks
    }
    if (winStreak > maxConsecutiveWins) maxConsecutiveWins = winStreak;
    if (lossStreak > maxConsecutiveLosses) maxConsecutiveLosses = lossStreak;
    if (t.profit > largestWin) largestWin = t.profit;
    if (t.profit < largestLoss) largestLoss = t.profit;
    barsHeld += held;
  }
  const avgWin = winCount ? winSum / winCount : 0;
  const avgLoss = lossCount ? lossSum / lossCount : 0;

  // ── buy-&-hold benchmark: enter when the strategy's first position was opened
  //    (TV's stated basis — the first closed trade's entry fill), exit at the
  //    last close. Falls back to the second bar's open (the first possible
  //    next-bar-open fill) when the run produced no closed trades. ─
  let buyHoldReturnPercent = 0;
  let buyHoldPnL = 0;
  let outperformance = 0;
  const bars = opts.bars;
  if (bars && bars.length > 0) {
    let base = bars.length > 1 ? bars[1].open : bars[0].close;
    if (trades.length) {
      const first = trades.reduce((a, t) => (t.entryBar < a.entryBar ? t : a));
      if (first.entryPrice > 0) base = first.entryPrice;
    }
    const last = bars[bars.length - 1].close;
    if (base > 0 && Number.isFinite(last)) {
      const ret = last / base - 1;
      buyHoldReturnPercent = ret * 100;
      buyHoldPnL = initial * ret;
      outperformance = report.netProfit - buyHoldPnL;
    }
  }

  // ── close-to-close run-up/drawdown phases over the bar-close equity curve ─
  const c2c = closeToClosePhases(equity, time);

  return {
    sharpe,
    sortino,
    volatilityPercent: std * annualize * 100,
    cagrPercent,
    calmar,
    exposurePercent:
      report.barsProcessed > 0 ? (report.barsInMarket / report.barsProcessed) * 100 : 0,
    expectancy,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    largestWin,
    largestLoss,
    avgBarsInTrade: trades.length ? barsHeld / trades.length : 0,
    avgBarsInWinners: winCount ? winBars / winCount : 0,
    avgBarsInLosers: lossCount ? lossBars / lossCount : 0,
    avgWinLossRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    largestWinPercentOfGrossProfit:
      report.grossProfit > 0 ? (largestWin / report.grossProfit) * 100 : 0,
    largestLossPercentOfGrossLoss:
      report.grossLoss > 0 ? (-largestLoss / report.grossLoss) * 100 : 0,
    netProfitPercentOfLargestLoss:
      largestLoss < 0 ? (report.netProfit / -largestLoss) * 100 : 0,
    returnOnInitialCapitalPercent: initial > 0 ? (report.netProfit / initial) * 100 : 0,
    buyHoldReturnPercent,
    buyHoldPnL,
    outperformance,
    // ?? 0: tolerate reports persisted before maxRunup existed on StrategyReport
    maxRunupPercentOfInitialCapital: initial > 0 ? ((report.maxRunup ?? 0) / initial) * 100 : 0,
    maxDrawdownPercentOfInitialCapital: initial > 0 ? (report.maxDrawdown / initial) * 100 : 0,
    maxRunupCloseToClose: c2c.maxRunup,
    maxDrawdownCloseToClose: c2c.maxDrawdown,
    avgRunupCloseToClose: c2c.avgRunup,
    avgDrawdownCloseToClose: c2c.avgDrawdown,
    avgRunupDurationDays: c2c.avgRunupDays,
    avgDrawdownDurationDays: c2c.avgDrawdownDays,
    periodsPerYear,
  };
}
