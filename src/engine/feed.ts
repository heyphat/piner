/**
 * DataFeed — OHLCV provider (docs/architecture.md §11).
 *
 * The engine is deterministic: all time comes from the feed, never from the
 * system clock. A feed supplies closed historical bars and (optionally) a
 * realtime tick subscription where each update carries the full developing bar
 * plus whether this tick closes it.
 */

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TickHandler = (bar: Bar, isClose: boolean) => void;

// ── Bar Magnifier data channel (dev-docs/bar-magnifier-plan.md §3.4) ─────────
//
// Lower-timeframe (LTF) target bars a host injects for the broker emulator's
// Bar Magnifier mode. This is a DEDICATED channel — deliberately never a
// `securityBars` key: a script's own `request.security_lower_tf()` for the same
// timeframe must not couple to fill simulation. Driver validates and prepares
// immutable buckets at the historical-run boundary, then consumes available
// buckets for the supported historical no-COOF traversal (plan §5.5/§10).

/** Unix epoch milliseconds, branded (plan §3.2): magnifier boundary math must
 *  never mix units, so a plain number cannot cross this boundary unannotated.
 *  Hosts convert provider seconds → ms exactly once and assert the brand. */
export type UnixMillisecond = number & { readonly __unixMillisecond: unique symbol };

/** A piner-ready immutable bar whose `time` is asserted to be epoch
 *  milliseconds. The preparation boundary freezes every supplied row after
 *  validation, preserving object identity without allowing post-validation
 *  OHLC mutation. */
export type PinerBar = Readonly<Omit<Bar, 'time'> & { time: UnixMillisecond }>;

/** Half-open time interval `[from, to)` in epoch milliseconds. */
export interface HalfOpenIntervalMs {
  /** Inclusive. */
  from: UnixMillisecond;
  /** Exclusive. */
  to: UnixMillisecond;
}

/** A known-incomplete stretch of an injected dataset. Piner REJECTS datasets
 *  that carry any of these (plan §3.5): incomplete acquisition is a host-side
 *  typed failure, not an engine fallback — only TV's own 200k cap and a
 *  genuinely empty chart bucket inside complete coverage fall back. */
export interface CoverageGapMs extends HalfOpenIntervalMs {
  reason: 'provider-missing' | 'partial-aggregate' | 'provider-truncated';
}

/** Explicit chart-bar close times. These eliminate the next-open/`Infinity`
 *  ambiguity of a derived final boundary and carry exchange-session ends the
 *  engine cannot invent (plan §3.4). */
export interface ChartIntervalEnds {
  /** One EXCLUSIVE close per chart bar, milliseconds, same order as the chart bars. */
  closeTimes: readonly UnixMillisecond[];
  source: 'utc-fixed' | 'provider-calendar' | 'host-explicit';
}

/** The injected Bar Magnifier dataset (plan §3.4). Piner validates the target
 *  timeframe against its own mapping, bar order/uniqueness/OHLC shape, chart
 *  interval consistency, and the coverage contract before any bar is used. */
export interface BarMagnifierData {
  /** Pine TF of the target bars — must equal `barMagnifierTimeframe(chartTf)`. */
  targetTimeframe: string;
  /** Target LTF bars, ascending, strictly unique open times, used verbatim. */
  bars: readonly PinerBar[];
  chartIntervals: ChartIntervalEnds;
  coverage: {
    requested: HalfOpenIntervalMs;
    covered: readonly HalfOpenIntervalMs[];
    gaps: readonly CoverageGapMs[];
    complete: boolean;
  };
}

export interface DataFeed {
  history(symbol: string, timeframe: string): Promise<Bar[]>;
  subscribe?(symbol: string, timeframe: string, onTick: TickHandler): () => void;
}

/** In-memory feed for tests and replay. */
export class ArrayFeed implements DataFeed {
  constructor(private readonly bars: Bar[]) {}
  async history(): Promise<Bar[]> {
    return this.bars.slice();
  }
}
