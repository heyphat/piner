/**
 * BarState — the `barstate.*` built-in namespace (docs/architecture.md §5).
 *
 * Recomputed each bar by the driver. The load-bearing discriminator is
 * `isconfirmed`: true on all historical bars and on the closing tick of the
 * realtime bar — the standard repaint-avoidance signal.
 */
export interface BarState {
  /** The very first bar of the dataset (bar_index === 0). */
  isfirst: boolean;
  /** First execution of this bar (historical bars + realtime opening tick). */
  isnew: boolean;
  /** Bar is closed/committed (all historical bars + realtime closing tick). */
  isconfirmed: boolean;
  /** The most recent bar on the chart. */
  islast: boolean;
  /** Bar is historical (already closed when the script first ran). */
  ishistory: boolean;
  /** Bar is the live, still-updating realtime bar. */
  isrealtime: boolean;
  /** Last historical bar before realtime updates began. */
  islastconfirmedhistory: boolean;
}

export function historicalBarState(isLast: boolean, isFirst = false): BarState {
  return {
    isfirst: isFirst,
    isnew: true,
    isconfirmed: true,
    islast: isLast,
    ishistory: true,
    isrealtime: false,
    // In a historical replay the last bar IS the last confirmed history.
    islastconfirmedhistory: isLast,
  };
}

export function realtimeBarState(isNewTick: boolean, isClose: boolean, isFirst = false): BarState {
  return {
    isfirst: isFirst, // true when the dataset had no history (bar_index === 0 live)
    isnew: isNewTick,
    isconfirmed: isClose,
    islast: true,
    ishistory: false,
    isrealtime: true,
    islastconfirmedhistory: false,
  };
}
