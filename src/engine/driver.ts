/**
 * Driver — the bar-by-bar execution loop and realtime rollback
 * (docs/architecture.md §6). This is the engine's central contract:
 *
 *  - historical: run the script once per closed bar, then commit.
 *  - realtime:   on each tick, ROLL BACK to the last committed length, replay the
 *                open bar with the tick's (mutable) OHLC, and commit only on close.
 *
 * Replaying the open bar with live high/low/close — while historical bars hold
 * only final OHLC — is exactly what produces repainting, with no special-casing.
 */

import type { ExecutionContext, RollbackSnapshot } from '../runtime/context.js';
import { BuiltinSlot } from '../runtime/context.js';
import { historicalBarState, realtimeBarState } from '../runtime/barstate.js';
import { emulatorTickPath } from '../runtime/builtins/strategy.js';
import type { Bar } from './feed.js';

/** A compiled script body: runs once for the current bar against `$`. */
export type ScriptFn = ($: ExecutionContext) => void;

export class Driver {
  /** Number of confirmed bars; the realtime bar rolls back to this length. */
  private committed = 0;
  private snapshot: RollbackSnapshot | null = null;
  /** True once the open realtime bar has received its first tick. */
  private realtimeBarOpen = false;
  /** Bars bound by prepareHistorical(), consumed one at a time by stepHistorical(). */
  private pending: Bar[] | null = null;
  private stepIdx = 0;

  constructor(
    private readonly main: ScriptFn,
    private readonly $: ExecutionContext,
  ) {}

  /** Run the full historical dataset, committing each bar. */
  runHistorical(bars: Bar[]): void {
    this.$.lastBarIndex = bars.length - 1;
    for (let i = 0; i < bars.length; i++) this.historicalBar(bars, i);
    // Capture state as of the last confirmed bar so realtime ticks can roll back.
    this.snapshot = this.$.snapshotMutable();
  }

  /**
   * Bind the full historical dataset without executing — the external-clock half
   * of runHistorical(). A host that interleaves several engines on one clock
   * (PortfolioEngine) prepares each with its complete per-symbol bars, then
   * drives them bar-by-bar with stepHistorical(). Knowing the array up front is
   * what keeps `last_bar_index`/`barstate.islast` identical to runHistorical() —
   * the realtime onTick() path cannot provide that.
   */
  prepareHistorical(bars: Bar[]): void {
    this.pending = bars;
    this.stepIdx = 0;
    this.$.lastBarIndex = bars.length - 1;
  }

  /** Execute the next prepared historical bar. Returns false when exhausted. */
  stepHistorical(): boolean {
    const bars = this.pending;
    if (!bars || this.stepIdx >= bars.length) return false;
    this.historicalBar(bars, this.stepIdx++);
    // After the last bar, capture the rollback baseline exactly as runHistorical()
    // does, so a switch to realtime ticks behaves identically.
    if (this.stepIdx === bars.length) this.snapshot = this.$.snapshotMutable();
    return true;
  }

  /** One committed historical bar — the shared physics of runHistorical/stepHistorical. */
  private historicalBar(bars: Bar[], i: number): void {
    const $ = this.$;
    const isLast = i === bars.length - 1;
    const broker = $.strategyBroker;
    if (broker.active && broker.settings.calcOnOrderFills) {
      this.historicalBarOnFills(bars, i, isLast); // runs the close pass itself (POC × coof)
    } else {
      this.beginBar(bars[i], i);
      $.bar = historicalBarState(isLast, i === 0);
      $.onStrategyBar(); // fill pending strategy orders against this bar's open/range
      this.main($);
      $.onStrategyBarClose(); // process_orders_on_close: fill this bar's market orders at close
    }
    $.series.commitBar();
    this.committed = $.series.committedBars;
  }

  /**
   * calc_on_order_fills historical bar — the PATH-POINT model, pinned against a
   * 55-trade TV ledger (dev-docs/calc-parity-findings.md). The bar has four
   * fill points: A (arrival at the open — carried orders gap-fill), W (walk
   * start, also the open — why the open can fill twice), E1 and E2 (extremes,
   * nearer-first). The close is NOT a fill point — leftovers carry to the next
   * bar's A. Points E1/E2 are preceded by a continuous sweep of their segment
   * (orders past their discrete point fill at their own levels). Every pass
   * that filled at least one order triggers a script execution; the standard
   * once-per-bar execution runs only when the whole bar filled NOTHING (the
   * docs' "or once per bar when there is no order to fill" — the counts are
   * exclusive, which is what makes the doc demo read 4 × bar_index exactly).
   *
   * Executions see the FULL bar OHLC (historical bars have no tick data);
   * between executions series/`var`/ta/drawing state rolls back exactly like a
   * realtime tick while `varip` and the broker persist. Pending-logs
   * assumptions (barstate flags, full-view executions) are flagged in the
   * findings ledger.
   */
  private historicalBarOnFills(bars: Bar[], i: number, isLast: boolean): void {
    const $ = this.$;
    const bar = bars[i];
    const broker = $.strategyBroker;
    const path = emulatorTickPath(bar.open, bar.high, bar.low, bar.close);
    const P = [bar.open, bar.open, path[1], path[2]]; // A, W, E1, E2
    this.beginBar(bar, i);
    try {
      broker.coofBegin(); // inside the try: a day-roll throw must not leak coof mode
      let snap: RollbackSnapshot | null = null;
      let executed = false;
      // `finalUnlessPoc`: this exec can only be followed by another via a
      // process_orders_on_close fill — skip the rollback snapshot when POC is off
      // (no-fill bars then stay snapshot-free, the common case).
      const runExec = (finalUnlessPoc = false) => {
        if (!finalUnlessPoc || broker.settings.processOrdersOnClose) snap ??= $.snapshotMutable(); // bar-start baseline (before any main() ran)
        if (executed) {
          // the historical analog of the realtime rollback: varip + broker persist
          $.series.truncateTo(this.committed);
          $.restoreMutableExceptStrategy(snap!);
          $.series.beginBar();
          this.setBuiltins(bar);
          $.execTick++;
          $.resetLoopBudget();
        }
        const state = historicalBarState(isLast, i === 0);
        if (executed) state.isnew = false; // only the bar's first execution is new
        $.bar = state;
        this.main($);
        executed = true;
      };
      for (let k = 0; k < 4; k++) {
        if (k >= 2 && broker.coofSegmentPass(k, P[k - 1], P[k]) > 0) runExec();
        // the point pass marks its own price and runs chronological risk+margin
        if (broker.coofPointPass(k, P[k]) > 0) runExec();
      }
      const tailEvents = broker.coofEnd(); // close mark + risk/margin finalization
      if (tailEvents > 0) runExec(); // forced liquidation is a broker recalculation event
      if (!executed) runExec(true); // the standard once-per-bar close execution
      // POC × coof (findings A6): the close pass is a broker event like any other —
      // it triggers one more execution whose orders carry to the next bar's A.
      if (broker.coofClosePass() > 0) runExec();
    } finally {
      // coof mode must never leak into realtime processing (follow-up audit §3),
      // even if a script execution throws mid-bar.
      broker.coofFinish();
    }
  }

  /**
   * Process one realtime update for the currently-open bar.
   * @param isClose true when this tick closes the bar (commit it permanently).
   */
  onTick(tick: Bar, isClose: boolean): void {
    const $ = this.$;
    const broker = $.strategyBroker;
    const firstTick = !this.realtimeBarOpen; // opening tick of a fresh bar

    this.rollback();
    this.beginBar(tick, this.committed);
    if (this.committed > $.lastBarIndex) $.lastBarIndex = this.committed;
    // Keep allBars in sync with the developing bar and drop the request.security
    // caches (per-bar columns computed over allBars) so security calls see realtime
    // bars instead of running off the end of the historical cache.
    $.allBars[this.committed] = tick;
    $.invalidateSecurityCaches();
    $.bar = realtimeBarState(firstTick, isClose, this.committed === 0);
    $.onStrategyBar(); // same fill pass as historical bars — orders fill on ticks too

    // A closing POC fill happens after main(), so COOF needs a second execution
    // before commit. Snapshot ordinary script state before the first execution;
    // broker mutations and varip deliberately survive the replay.
    const replayAfterClose =
      isClose &&
      broker.active &&
      broker.settings.processOrdersOnClose &&
      broker.settings.calcOnOrderFills;
    const replaySnapshot = replayAfterClose ? $.snapshotMutable() : null;
    this.main($);
    // process_orders_on_close is a BAR-CLOSE pass, not a speculative-update pass.
    const closeEvents = isClose ? $.onStrategyBarClose() : 0;
    if (replayAfterClose && closeEvents > 0) {
      $.series.truncateTo(this.committed);
      $.restoreMutableExceptStrategy(replaySnapshot!);
      $.series.beginBar();
      this.setBuiltins(tick);
      $.invalidateSecurityCaches();
      $.execTick++;
      $.resetLoopBudget();
      $.bar = realtimeBarState(false, true, this.committed === 0);
      this.main($);
    }

    if (isClose) {
      $.series.commitBar();
      this.committed = $.series.committedBars;
      this.snapshot = $.snapshotMutable();
      this.realtimeBarOpen = false; // next tick opens a new bar
    } else {
      this.realtimeBarOpen = true;
    }
  }

  private rollback(): void {
    const $ = this.$;
    // Realtime-only usage (no runHistorical) still needs a baseline to roll back
    // to — capture the pre-run state on the first tick.
    if (!this.snapshot) this.snapshot = $.snapshotMutable();
    $.series.truncateTo(this.committed); // history slots
    $.restoreMutable(this.snapshot); // ta/broker state + var store (varip exempt)
  }

  private beginBar(bar: Bar, idx: number): void {
    const $ = this.$;
    $.idx = idx;
    $.execTick++;
    $.resetLoopBudget();
    $.series.beginBar();
    this.setBuiltins(bar);
  }

  /** Write the bar's OHLCV/time into the current (uncommitted) series bar. */
  private setBuiltins(bar: Bar): void {
    const $ = this.$;
    $.set(BuiltinSlot.Open, bar.open);
    $.set(BuiltinSlot.High, bar.high);
    $.set(BuiltinSlot.Low, bar.low);
    $.set(BuiltinSlot.Close, bar.close);
    $.set(BuiltinSlot.Volume, bar.volume);
    $.set(BuiltinSlot.Time, bar.time);
  }
}
