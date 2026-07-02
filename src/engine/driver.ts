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
import type { Bar } from './feed.js';

/** A compiled script body: runs once for the current bar against `$`. */
export type ScriptFn = ($: ExecutionContext) => void;

export class Driver {
  /** Number of confirmed bars; the realtime bar rolls back to this length. */
  private committed = 0;
  private snapshot: RollbackSnapshot | null = null;
  /** True once the open realtime bar has received its first tick. */
  private realtimeBarOpen = false;

  constructor(
    private readonly main: ScriptFn,
    private readonly $: ExecutionContext,
  ) {}

  /** Run the full historical dataset, committing each bar. */
  runHistorical(bars: Bar[]): void {
    const $ = this.$;
    $.lastBarIndex = bars.length - 1;
    for (let i = 0; i < bars.length; i++) {
      const isLast = i === bars.length - 1;
      this.beginBar(bars[i], i);
      $.bar = historicalBarState(isLast, i === 0);
      $.onStrategyBar(); // fill pending strategy orders against this bar's open/range
      this.main($);
      $.onStrategyBarClose(); // process_orders_on_close: fill this bar's market orders at close
      $.series.commitBar();
      this.committed = $.series.committedBars;
    }
    // Capture state as of the last confirmed bar so realtime ticks can roll back.
    this.snapshot = $.snapshotMutable();
  }

  /**
   * Process one realtime update for the currently-open bar.
   * @param isClose true when this tick closes the bar (commit it permanently).
   */
  onTick(tick: Bar, isClose: boolean): void {
    const $ = this.$;
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
    this.main($);
    $.onStrategyBarClose(); // process_orders_on_close (no-op unless configured)

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
    $.set(BuiltinSlot.Open, bar.open);
    $.set(BuiltinSlot.High, bar.high);
    $.set(BuiltinSlot.Low, bar.low);
    $.set(BuiltinSlot.Close, bar.close);
    $.set(BuiltinSlot.Volume, bar.volume);
    $.set(BuiltinSlot.Time, bar.time);
  }
}
