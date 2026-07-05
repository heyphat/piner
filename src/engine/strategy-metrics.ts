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
  /** Buy-&-hold benchmark return over the same bars, percent (0 without `bars`). */
  buyHoldReturnPercent: number;
  /** Net profit minus the buy-&-hold PnL on the same capital (0 without `bars`). */
  outperformance: number;
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
    barsHeld = 0;
  for (const t of trades) {
    if (t.profit > 0) {
      winStreak++;
      lossStreak = 0;
    } else if (t.profit < 0) {
      lossStreak++;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0; // an even trade breaks both streaks
    }
    if (winStreak > maxConsecutiveWins) maxConsecutiveWins = winStreak;
    if (lossStreak > maxConsecutiveLosses) maxConsecutiveLosses = lossStreak;
    if (t.profit > largestWin) largestWin = t.profit;
    if (t.profit < largestLoss) largestLoss = t.profit;
    barsHeld += t.exitBar - t.entryBar;
  }

  // ── buy-&-hold benchmark: enter at the second bar's open (the first possible
  //    next-bar-open fill), exit at the last close ─
  let buyHoldReturnPercent = 0;
  let outperformance = 0;
  const bars = opts.bars;
  if (bars && bars.length > 0) {
    const base = bars.length > 1 ? bars[1].open : bars[0].close;
    const last = bars[bars.length - 1].close;
    if (base > 0 && Number.isFinite(last)) {
      const ret = last / base - 1;
      buyHoldReturnPercent = ret * 100;
      outperformance = report.netProfit - initial * ret;
    }
  }

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
    buyHoldReturnPercent,
    outperformance,
    periodsPerYear,
  };
}
