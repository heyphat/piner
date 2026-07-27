/**
 * Bar Magnifier broker-event geometry and resumable-traversal cursor types
 * reserved for the future COOF-capable model in
 * dev-docs/bar-magnifier-plan.md §5.1/§5.3.
 *
 * The current public historical no-COOF path processes independent LTF OHLC
 * rows directly and does not consume these cursor types. COOF deliberately
 * remains on the audited chart scheduler. Future activation requires stronger
 * evidence for the per-LTF event recipe (Q1), same-open/post-extreme eligibility
 * (Q2), threshold/tie ordering and fill clocks (Q3/M2/M3); these interfaces do
 * not turn those unknowns into guessed constants.
 *
 * Geometry reserved for that future model (plan §0.4/§0.5):
 * - Movement inside one LTF bar and arrival at the next LTF open are DISTINCT
 *   events; no continuous segment is ever invented across an LTF boundary.
 * - If magnified COOF is enabled later, COOF-off and COOF-on must traverse the
 *   same events; COOF may only pause traversal to execute the script.
 */

/** Explicit event clock — no fill-capable event inherits chart `host.time`
 *  accidentally (plan §5.1). */
export interface EventClock {
  /** Open time (ms) of the LTF bar this event belongs to. */
  intrabarOpenTime: number;
  /** The event's own time under TV's trade-time convention, pinned by M2/M3. */
  eventTime: number;
}

/**
 * One geometric market event of a chart bar's LTF traversal (plan §5.1).
 *
 * - `arrival` — discontinuous: applies the gap rules at an LTF open (the
 *   emulator assumes no intrabars exist inside the close→open gap).
 * - `point` — a probe-pinned next-event eligibility coordinate (walk start,
 *   extreme, or close role within one LTF bar).
 * - `segment` — monotonic movement INSIDE one LTF bar, from → to.
 * - `terminal-mark` — can update marks/metrics without filling, if TV treats an
 *   LTF close like the current synthetic chart close (close-is-not-a-fill-point).
 */
export type BrokerEvent =
  | {
      kind: 'arrival';
      seq: number;
      intrabar: number;
      clock: EventClock;
      price: number;
    }
  | {
      kind: 'point';
      seq: number;
      intrabar: number;
      clock: EventClock;
      price: number;
      role: 'walk-start' | 'extreme' | 'close';
    }
  | {
      kind: 'segment';
      seq: number;
      intrabar: number;
      clock: EventClock;
      from: number;
      to: number;
    }
  | {
      kind: 'terminal-mark';
      seq: number;
      intrabar: number;
      clock: EventClock;
      price: number;
    };

/**
 * Resume point inside one segment (plan §5.3). A segment may cross several
 * eligible thresholds, and COOF can create new orders after any fill — so the
 * broker cannot consume a whole segment and merely return a fill count. It
 * pauses at the probe-pinned tie batch, the driver optionally recalculates, and
 * traversal resumes on the REMAINING movement only: newly born orders never
 * participate in already-traversed movement (no retroactive fills).
 */
export interface TraversalCursor {
  /** The BrokerEvent.seq this cursor is inside. */
  eventSeq: number;
  /** Price coordinate already reached within the segment. */
  currentPrice: number;
  /** The segment's destination price. */
  targetPrice: number;
  /** Travel direction of the remaining movement. */
  direction: 1 | -1;
  /** Order-birth generation at the pause — the M2 eligibility rule's input. */
  generation: number;
}

/** Result of advancing one broker event (plan §5.3): either the event is fully
 *  consumed, or traversal paused at a fill boundary with a cursor to resume
 *  from. No-COOF consumes the same cursor to completion without script
 *  execution — identical event physics, recalculation optional (plan §0.5). */
export type AdvanceResult =
  | { kind: 'done' }
  | {
      kind: 'paused';
      cursor: TraversalCursor;
      fillPrice: number;
      fillTime: number;
      fills: number;
    };
