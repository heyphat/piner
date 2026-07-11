/**
 * PortfolioEngine — one Pine strategy over N symbols as ONE backtest
 * (pinestack portfolio-aggregation-plan §7; semantics: docs/portfolio-semantics.md).
 *
 * N per-symbol Engine instances (same compiled script, independent contexts and
 * brokers) are driven bar-by-bar on the union clock of all sleeves' bar times via
 * the historical stepper (Engine.prepare/step — gate G1). The allocation policy
 * decides the capital model:
 *
 *  - `isolated` — each sleeve keeps its private Account, funded wᵢ·P through the
 *    EngineOptions.strategy override (gate G2). Reproduces the equal-weight and
 *    weighted sleeve models (plan Models A/B) exactly: gate V3 asserts the
 *    portfolio curve equals the post-hoc forward-fill-and-sum oracle bit-for-bit.
 *  - `shared`  — one Account(P) swapped into every broker (gate G3): sizing,
 *    funds checks, margin, and risk rules all read portfolio equity. Trades can
 *    differ from any per-symbol run; that is the point.
 *
 * Per-sleeve behavior stays TV-faithful; only the account is shared. Sleeves
 * execute only on their own bars (spec S8), in basket order at equal timestamps
 * (spec S4).
 */

import { Engine } from './engine.js';
import { ArrayFeed, type Bar } from './feed.js';
import type { CompiledScript } from './compiler.js';
import { Account, type StrategyReport, type ClosedTrade } from '../runtime/builtins/strategy.js';
import { tfSeconds } from '../runtime/context.js';
import {
  computeStrategyMetrics,
  type StrategyMetrics,
  type StrategyMetricsOptions,
} from './strategy-metrics.js';

/** Engines get their bars via prepare(); run()/feed.history() is never called. */
const INERT_FEED = new ArrayFeed([]);

export interface PortfolioSleeveSpec {
  symbol: string;
  timeframe: string;
  /** Instrument tick size (defaults to 0.01), as RunOptions.mintick. */
  mintick?: number;
  /** The sleeve's full historical dataset (host-fetched and injected). */
  bars: Bar[];
  /** Host-fetched request.security bars, keyed `SYMBOL@TF` — injected into the
   *  sleeve's context before the run, exactly as a single-symbol host does. */
  securityBars?: Record<string, Bar[]>;
}

export interface PortfolioEngineOptions {
  /** Capital model — see module doc. Default 'isolated'. */
  mode?: 'isolated' | 'shared';
  /** Total pot P. Default N × the script's initial_capital (spec S1). */
  capital?: number;
  /** Per-sleeve funding fractions, basket order; normalized to sum 1. Default
   *  equal. Isolated mode only — one shared pot has no per-sleeve split. */
  weights?: number[];
  backend?: 'js' | 'interp';
  /** Input overrides, applied to every sleeve. */
  inputs?: Record<string, unknown>;
}

export interface PortfolioSleeveResult {
  symbol: string;
  /** This sleeve's funding: wᵢ·P (isolated) — the pot is shared, so 0 (shared). */
  funding: number;
  /** Broker-verbatim per-sleeve report. Its equityCurve is indexed by the
   *  sleeve's own bar sequence; under shared mode those values sample
   *  PORTFOLIO equity at the sleeve's bars (spec S2). */
  report: StrategyReport;
  /** The sleeve's bar times (ms), ascending — the index for report.equityCurve. */
  barTimes: number[];
}

export interface PortfolioReport {
  mode: 'isolated' | 'shared';
  symbols: string[];
  /** Master clock: sorted, deduped union of all sleeves' bar times (ms). */
  times: number[];
  /** Portfolio-level report in the StrategyReport shape so computeStrategyMetrics
   *  consumes it unchanged. equityCurve is indexed by `times`; drawdown/run-up
   *  are CLOSE-TO-CLOSE on that curve (cross-symbol intrabar interleaving is not
   *  modeled — plan §7); closedTrades is the merged, symbol-tagged, exit-time
   *  sorted ledger with cumProfit re-accumulated portfolio-wide. */
  report: StrategyReport;
  sleeves: PortfolioSleeveResult[];
}

export class PortfolioEngine {
  private readonly mode: 'isolated' | 'shared';
  private result: PortfolioReport | null = null;

  constructor(
    private readonly script: CompiledScript,
    private readonly opts: PortfolioEngineOptions = {},
  ) {
    if (!script.metadata.isStrategy)
      throw new Error('PortfolioEngine requires a strategy script (got an indicator)');
    this.mode = opts.mode ?? 'isolated';
  }

  /** Run the whole basket. Synchronous: bars are injected, nothing is fetched. */
  run(sleeves: PortfolioSleeveSpec[]): PortfolioReport {
    const n = sleeves.length;
    if (n === 0) throw new Error('PortfolioEngine: empty basket');

    const headerCapital = this.script.metadata.strategy?.initialCapital ?? 1_000_000;
    const capital = this.opts.capital ?? n * headerCapital;
    if (!Number.isFinite(capital) || capital <= 0)
      throw new Error(`PortfolioEngine: invalid capital ${capital}`);
    const weights = normalizedWeights(this.opts.weights, n);
    this.lastTf = sleeves[0].timeframe; // one timeframe per basket (plan §1)

    // One engine per sleeve. Isolated: fund the private account via the settings
    // override. Shared: leave header funding in place, then swap in the pot.
    // The feed is inert: bars are injected via prepare(), and the stepper never
    // calls feed.history() — one shared empty feed serves every engine.
    const engines = sleeves.map(
      (_s, i) =>
        new Engine(this.script, INERT_FEED, {
          backend: this.opts.backend,
          inputs: this.opts.inputs,
          strategy: this.mode === 'isolated' ? { initialCapital: weights[i] * capital } : undefined,
        }),
    );
    const shared = this.mode === 'shared' ? new Account(capital) : null;
    if (shared) for (const e of engines) e.ctx.strategyBroker.setAccount(shared);
    for (let i = 0; i < n; i++) {
      const s = sleeves[i];
      if (s.securityBars)
        for (const [key, bars] of Object.entries(s.securityBars))
          engines[i].ctx.securityBars.set(key, bars);
      engines[i].prepare({ symbol: s.symbol, timeframe: s.timeframe, mintick: s.mintick }, s.bars);
    }

    // Union clock: walk the merged time axis; at each master time, step every
    // sleeve that has a bar there, in basket order (spec S4 — earlier sleeves'
    // fills settle into the account before later sleeves size).
    //
    // Portfolio equity per master bar is read from the brokers' RECORDED
    // equity marks, not live getters: between bars the series pointer sits past
    // the committed bar, so live `host.close` (hence openProfit) is NaN.
    //  - isolated: Σ (sleeve's last recorded mark; its funding before activation)
    //    — literally the §6 forward-fill-and-sum oracle, evaluated at run time.
    //  - shared:   every broker's mark under a shared account IS portfolio
    //    equity, so take the master bar's last-stepped mark (basket order makes
    //    it the most complete: all of this timestamp's fills have settled).
    const times = unionTimes(sleeves);
    const cursor = new Array<number>(n).fill(0);
    const equityCurve = new Array<number>(times.length);
    let barsInMarket = 0;
    for (let k = 0; k < times.length; k++) {
      const t = times[k];
      let lastStepped = -1;
      for (let i = 0; i < n; i++) {
        if (cursor[i] < sleeves[i].bars.length && sleeves[i].bars[cursor[i]].time === t) {
          engines[i].step();
          cursor[i]++;
          lastStepped = i;
        }
      }
      if (shared) {
        const b = engines[lastStepped].ctx.strategyBroker;
        equityCurve[k] = b.equityCurve[cursor[lastStepped] - 1];
      } else {
        let eq = 0;
        for (let i = 0; i < n; i++) {
          const b = engines[i].ctx.strategyBroker;
          eq += cursor[i] > 0 ? b.equityCurve[cursor[i] - 1] : weights[i] * capital;
        }
        equityCurve[k] = eq;
      }
      for (let i = 0; i < n; i++) {
        if (engines[i].ctx.strategyBroker.size !== 0) {
          barsInMarket++;
          break;
        }
      }
    }

    // Assemble: per-sleeve verbatim reports + the portfolio-level StrategyReport.
    const sleeveResults: PortfolioSleeveResult[] = sleeves.map((s, i) => ({
      symbol: s.symbol,
      funding: shared ? 0 : weights[i] * capital,
      report: engines[i].strategy,
      barTimes: s.bars.map((b) => b.time),
    }));
    const reports = sleeveResults.map((s) => s.report);
    const sum = (f: (r: StrategyReport) => number) => reports.reduce((a, r) => a + f(r), 0);

    // Merged ledger: symbol-tagged, exit-time sorted (stable → basket order on
    // ties), cumProfit re-accumulated portfolio-wide.
    const merged: ClosedTrade[] = [];
    for (const s of sleeveResults)
      for (const t of s.report.closedTrades) merged.push({ ...t, symbol: s.symbol });
    merged.sort((a, b) => a.exitTime - b.exitTime);
    let cum = 0;
    for (const t of merged) t.cumProfit = cum += t.profit;

    const dd = closeToCloseExtremes(equityCurve, capital);
    const report: StrategyReport = {
      initialCapital: capital,
      netProfit: sum((r) => r.netProfit),
      grossProfit: sum((r) => r.grossProfit),
      grossLoss: sum((r) => r.grossLoss),
      wins: sum((r) => r.wins),
      losses: sum((r) => r.losses),
      evens: sum((r) => r.evens),
      maxDrawdown: dd.maxDrawdown,
      maxDrawdownPercent: dd.maxDrawdownPercent,
      maxRunup: dd.maxRunup,
      maxRunupPercent: dd.maxRunupPercent,
      totalCommission: sum((r) => r.totalCommission),
      closedTrades: merged,
      equityCurve,
      barsProcessed: times.length,
      barsInMarket,
      marginCalls: sum((r) => r.marginCalls),
    };

    this.result = {
      mode: this.mode,
      symbols: sleeves.map((s) => s.symbol),
      times,
      report,
      sleeves: sleeveResults,
    };
    return this.result;
  }

  get report(): PortfolioReport {
    if (!this.result) throw new Error('PortfolioEngine: run() has not been called');
    return this.result;
  }

  /** Derived portfolio metrics — computeStrategyMetrics over the portfolio report
   *  on the master clock. No `bars` benchmark: buy-&-hold is meaningless for a
   *  basket (plan §7). */
  metrics(
    opts: Omit<StrategyMetricsOptions, 'barTimes' | 'timeframeSeconds' | 'bars'> = {},
  ): StrategyMetrics {
    const r = this.report;
    // All sleeves share one timeframe by contract (plan §1); use the first.
    return computeStrategyMetrics(r.report, {
      barTimes: r.times,
      timeframeSeconds: this.lastTf ? tfSeconds(this.lastTf) : undefined,
      ...opts,
    });
  }

  private lastTf: string | null = null;
}

function normalizedWeights(weights: number[] | undefined, n: number): number[] {
  if (!weights) return new Array<number>(n).fill(1 / n);
  if (weights.length !== n)
    throw new Error(`PortfolioEngine: ${weights.length} weights for ${n} sleeves`);
  let total = 0;
  for (const w of weights) {
    if (!Number.isFinite(w) || w <= 0) throw new Error(`PortfolioEngine: invalid weight ${w}`);
    total += w;
  }
  return weights.map((w) => w / total);
}

/** Sorted, deduped union of every sleeve's bar times (two-pointer-free simple set —
 *  basket sizes are small; per-sleeve arrays are already ascending). */
function unionTimes(sleeves: PortfolioSleeveSpec[]): number[] {
  const set = new Set<number>();
  for (const s of sleeves) for (const b of s.bars) set.add(b.time);
  return Array.from(set).sort((a, b) => a - b);
}

/** Close-to-close drawdown/run-up over the portfolio curve (plan §7: the honest
 *  portfolio extremes — cross-symbol intrabar paths are unknowable). Peak/valley
 *  seed at the pot, mirroring the broker's configure() seeding. */
function closeToCloseExtremes(curve: number[], initial: number) {
  let peak = initial;
  let valley = initial;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let maxRunup = 0;
  let maxRunupPercent = 0;
  for (const v of curve) {
    if (Number.isNaN(v)) continue;
    if (v > peak) peak = v;
    if (v < valley) valley = v;
    const dd = peak - v;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (dd / peak) * 100);
    const ru = v - valley;
    if (ru > maxRunup) maxRunup = ru;
    if (valley > 0) maxRunupPercent = Math.max(maxRunupPercent, (ru / valley) * 100);
  }
  return { maxDrawdown, maxDrawdownPercent, maxRunup, maxRunupPercent };
}
