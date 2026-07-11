/**
 * Engine — wires a compiled script body to a data feed and drives execution.
 *
 * Accepts either a raw `ScriptFn` (hand-written, Phase-1 style) or a
 * `CompiledScript` produced by `compile()`. When given a CompiledScript it also
 * declares the history columns the analyzer assigned and can run either backend.
 */

import { ExecutionContext, tfSeconds } from '../runtime/context.js';
import { Driver, type ScriptFn } from './driver.js';
import type { DataFeed, Bar } from './feed.js';
import type { CompiledScript } from './compiler.js';
import type { StrategySettings } from '../runtime/builtins/strategy.js';
import {
  computeStrategyMetrics,
  type StrategyMetrics,
  type StrategyMetricsOptions,
} from './strategy-metrics.js';

export interface RunOptions {
  symbol: string;
  timeframe: string;
  /** Instrument tick size (defaults to 0.01). Drives slippage + tick-denominated exits. */
  mintick?: number;
}

export interface EngineOptions {
  /** History columns to declare (from CompiledScript.metadata.historySlotCount). */
  historySlotCount?: number;
  /** Which backend to run when given a CompiledScript. */
  backend?: 'js' | 'interp';
  /** Input overrides keyed by input title (drives the settings panel). */
  inputs?: Record<string, unknown>;
  /** Maximum user-loop iterations allowed per bar/tick. Defaults to 1,000,000. */
  loopIterationBudget?: number;
  /**
   * Host override of `strategy()` header settings (initial_capital, commission,
   * slippage, margin, …), applied after the header so overrides win. This is the
   * funding primitive: weighted/portfolio runs re-fund a script externally, and
   * sensitivity tests override commission/slippage, without editing the source.
   * Ignored for compiled non-strategy scripts (an indicator's broker stays inactive).
   */
  strategy?: Partial<StrategySettings>;
}

export class Engine {
  readonly ctx = new ExecutionContext();
  private readonly driver: Driver;

  constructor(
    script: ScriptFn | CompiledScript,
    private readonly feed: DataFeed,
    opts: EngineOptions = {},
  ) {
    let main: ScriptFn;
    if (typeof script === 'function') {
      main = script;
      if (opts.historySlotCount) this.ctx.ensureHistorySlots(opts.historySlotCount);
    } else {
      main = opts.backend === 'interp' ? script.interpret : script.main;
      this.ctx.ensureHistorySlots(script.metadata.historySlotCount);
      if (script.metadata.isStrategy) this.ctx.configureStrategy(script.metadata.strategy ?? {});
      // Per-type drawing caps (indicator()'s max_*_count) — TradingView keeps only the
      // most recent N of each type; without this the pool grows unbounded over history.
      this.ctx.drawPool.setCaps({
        line: script.metadata.maxLinesCount,
        label: script.metadata.maxLabelsCount,
        box: script.metadata.maxBoxesCount,
        polyline: script.metadata.maxPolylinesCount,
      });
    }
    if (opts.inputs) this.ctx.inputOverrides = opts.inputs;
    if (opts.loopIterationBudget != null) this.ctx.loopIterationBudget = opts.loopIterationBudget;
    // Applied after the header's configureStrategy so the override wins. Gated so a
    // compiled indicator's broker is not activated; raw ScriptFns are the caller's call.
    if (opts.strategy && (typeof script === 'function' || script.metadata.isStrategy))
      this.ctx.configureStrategy(opts.strategy);
    this.driver = new Driver(main, this.ctx);
  }

  async run(opts: RunOptions): Promise<void> {
    this.ctx.symbol = opts.symbol;
    this.ctx.tfStr = opts.timeframe;
    if (opts.mintick != null && Number.isFinite(opts.mintick) && opts.mintick > 0)
      this.ctx.mintick = opts.mintick;
    const bars = await this.feed.history(opts.symbol, opts.timeframe);
    this.ctx.allBars = bars; // for request.security resampling
    this.driver.runHistorical(bars);
  }

  /**
   * Bind a run's identity and its full bar array without executing — the
   * external-clock half of run(). Drive the bars one at a time with step();
   * used by hosts that interleave several engines on one shared clock
   * (PortfolioEngine). Unlike tick(), stepped bars keep exact historical
   * semantics: `barstate.ishistory`, `barstate.islast`, and `last_bar_index`
   * match run() bit-for-bit, with none of the realtime rollback overhead.
   */
  prepare(opts: RunOptions, bars: Bar[]): void {
    this.ctx.symbol = opts.symbol;
    this.ctx.tfStr = opts.timeframe;
    if (opts.mintick != null && Number.isFinite(opts.mintick) && opts.mintick > 0)
      this.ctx.mintick = opts.mintick;
    this.ctx.allBars = bars; // for request.security resampling
    this.driver.prepareHistorical(bars);
  }

  /** Execute the next prepared historical bar. Returns false when exhausted. */
  step(): boolean {
    return this.driver.stepHistorical();
  }

  tick(bar: Bar, isClose: boolean): void {
    this.driver.onTick(bar, isClose);
  }

  get outputs() {
    return this.ctx.out;
  }

  /** Live drawing objects (line/label/box/table) for rendering. */
  get drawings() {
    return this.ctx.drawings;
  }

  /** Strategy backtest report (net/gross PnL, trade list, equity curve). */
  get strategy() {
    return this.ctx.strategyBroker.report();
  }

  /** Derived risk-adjusted metrics (Sharpe, Sortino, CAGR, Calmar, exposure, …) over
   *  the strategy report, annualized from the run's bar times + timeframe. Pass
   *  `periodsPerYear`/`riskFreeRate` to apply a host market-calendar convention. */
  strategyMetrics(
    opts: Omit<StrategyMetricsOptions, 'barTimes' | 'timeframeSeconds' | 'bars'> = {},
  ): StrategyMetrics {
    return computeStrategyMetrics(this.ctx.strategyBroker.report(), {
      barTimes: this.ctx.allBars.map((b) => b.time),
      bars: this.ctx.allBars,
      timeframeSeconds: tfSeconds(this.ctx.tfStr),
      ...opts,
    });
  }
}
