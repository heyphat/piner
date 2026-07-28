/**
 * Bar Magnifier envelope filter, 200k target-bar cap, and bounded partitioner
 * (dev-docs/bar-magnifier-plan.md §1.4/§4).
 *
 * Pure and deterministic: a function of the chart bars, the chart timeframe,
 * and the injected dataset. Nothing here fills orders — Driver consumes
 * available buckets for supported historical no-COOF traversal and keeps the
 * chart path for COOF, realtime, no-data, and cap fallbacks (plan §5.5/§10).
 *
 * Deliberately does NOT reuse `computeLowerTf()`'s bucketing: that path ends
 * with an `Infinity` final boundary, and changing it requires its own
 * regressions — not hidden inside this feature (plan §4).
 */

import type { Bar, BarMagnifierData, PinerBar } from './feed.js';
import { barMagnifierTimeframe } from '../runtime/timeframe.js';

/** TradingView's Bar Magnifier limit on requested lower-timeframe bars, applied
 *  to the chart-envelope-eligible target rows, newest first. Broker semantics
 *  enforced by piner for every host (plan §0.3) — hosts may pre-trim
 *  identically to save memory but are not the authority. */
export const BAR_MAGNIFIER_TARGET_BAR_LIMIT = 200_000;

export interface IntrabarBucket {
  chartIndex: number;
  /** The chart bar's target LTF rows, ascending; empty for 'none'. */
  bars: readonly PinerBar[];
  /** 'available' — a nonempty bucket holding every retained row of its interval;
   *  'cap-boundary' — the 200k cap cut through this bucket (it holds only the
   *  newest part of its interval's rows). The partitioner records this cap
   *  provenance; Driver currently falls back for the whole chart bar and reports
   *  the cap reason. A direct-TV M4 fixture could refine that policy later.
   *  'none' — no rows: the chart bar keeps the exact non-magnifier fallback. */
  coverage: 'none' | 'cap-boundary' | 'available';
  /** Present only when this fallback is attributable to the retained suffix:
   *  either the cap cut this bucket or discarded all of its otherwise eligible
   *  rows. Exact-edge cuts keep coverage 'none' while retaining this cause. */
  readonly fallbackReason?: 'cap';
}

/**
 * Partition an injected Bar Magnifier dataset into per-chart-bar buckets, in
 * the plan's exact preparation order (§1.4): validate → restrict to the chart
 * envelope → retain the newest 200,000 eligible rows → partition the retained
 * suffix → mark the earliest cap-intersected bucket. Filtering BEFORE capping
 * is load-bearing: rows after the final chart close must not evict usable
 * chart-range data (asserted by tests, plan §11.1).
 *
 * Throws a deterministic data-contract error on any malformed input: the core
 * never sorts, repairs, or clamps (plan §0.1/§4).
 */
export function prepareMagnifierBuckets(
  chartBars: readonly Bar[],
  chartTf: string,
  data: BarMagnifierData,
): readonly IntrabarBucket[] {
  return partitionWithTargetLimit(chartBars, chartTf, data, BAR_MAGNIFIER_TARGET_BAR_LIMIT);
}

/**
 * @internal The cap is a parameter ONLY so property tests can exercise the cap
 * invariants without 200,000-row inputs. Production callers use
 * {@link prepareMagnifierBuckets}: the 200,000 limit is broker semantics
 * (plan §0.3), not a knob.
 */
export function partitionWithTargetLimit(
  chartBars: readonly Bar[],
  chartTf: string,
  data: BarMagnifierData,
  limit: number,
): readonly IntrabarBucket[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`bar magnifier: target-bar limit must be a nonnegative integer, got ${limit}`);
  }
  // 1. Target-TF verification (§4 step 1). A mismatched NONEMPTY dataset is a
  // deterministic data-contract error (§3.4); an empty one has nothing to
  // consume — every bucket is 'none'. An invalid chart TF throws from the
  // mapping itself when there is data to consume: fail closed, never guess.
  if (data.bars.length > 0) {
    const expected = barMagnifierTimeframe(chartTf);
    if (data.targetTimeframe !== expected) {
      throw new Error(
        `bar magnifier: target dataset timeframe "${data.targetTimeframe}" does not match ` +
          `barMagnifierTimeframe("${chartTf}") = "${expected}"`,
      );
    }
  }

  // 2. Chart interval ends vs chart opens (§4 step 2, §3.4 validation).
  const closes = data.chartIntervals.closeTimes;
  if (closes.length !== chartBars.length) {
    throw new Error(
      `bar magnifier: chartIntervals.closeTimes has ${closes.length} entries for ` +
        `${chartBars.length} chart bars`,
    );
  }
  for (let i = 0; i < chartBars.length; i++) {
    const open = chartBars[i].time;
    const close = closes[i];
    if (!Number.isFinite(open) || !Number.isFinite(close) || open >= close) {
      throw new Error(`bar magnifier: chart interval ${i} must satisfy open < close`);
    }
    if (i + 1 < chartBars.length && close > chartBars[i + 1].time) {
      throw new Error(`bar magnifier: chart intervals ${i} and ${i + 1} overlap`);
    }
  }

  // Coverage contract (§3.3/§3.5): piner rejects incomplete coverage and
  // explicit provider gaps — incomplete acquisition is a host-side typed
  // failure, not an engine fallback. Only TV's own cap suffix and genuinely
  // empty buckets inside complete coverage fall back.
  const cov = data.coverage;
  if (!cov.complete) {
    throw new Error(
      'bar magnifier: injected dataset must assert coverage.complete === true ' +
        '(incomplete acquisition is rejected, not silently degraded)',
    );
  }
  if (cov.gaps.length > 0) {
    throw new Error('bar magnifier: injected dataset carries explicit provider gaps — rejected');
  }
  if (!(Number.isFinite(cov.requested.from) && Number.isFinite(cov.requested.to))) {
    throw new Error('bar magnifier: coverage.requested endpoints must be finite');
  }
  if (cov.requested.from >= cov.requested.to) {
    throw new Error('bar magnifier: coverage.requested must be a nonempty half-open interval');
  }
  if (
    chartBars.length > 0 &&
    (cov.requested.from > chartBars[0].time || cov.requested.to < closes[closes.length - 1])
  ) {
    throw new Error('bar magnifier: coverage.requested must contain the complete chart envelope');
  }
  let prevCoveredTo = -Infinity;
  for (const c of cov.covered) {
    if (!(Number.isFinite(c.from) && Number.isFinite(c.to) && c.from < c.to)) {
      throw new Error('bar magnifier: coverage.covered intervals must be nonempty and finite');
    }
    if (c.from < prevCoveredTo) {
      throw new Error('bar magnifier: coverage.covered intervals must be ascending and disjoint');
    }
    if (c.from < cov.requested.from || c.to > cov.requested.to) {
      throw new Error('bar magnifier: coverage.covered must lie within coverage.requested');
    }
    prevCoveredTo = c.to;
  }

  // `complete` is meaningful only if every tradable chart interval is proven
  // covered. Gaps between chart bars may be closed-session time and need not be
  // covered, but no leading, trailing, or internal hole may intersect a chart
  // interval itself.
  let coverageIndex = 0;
  for (let i = 0; i < chartBars.length; i++) {
    let cursor = chartBars[i].time;
    const close = closes[i];
    while (coverageIndex < cov.covered.length && cov.covered[coverageIndex].to <= cursor) {
      coverageIndex++;
    }
    let j = coverageIndex;
    while (cursor < close) {
      const span = cov.covered[j];
      if (!span || span.from > cursor) {
        throw new Error(`bar magnifier: declared coverage does not contain chart interval ${i}`);
      }
      cursor = Math.max(cursor, span.to);
      j++;
    }
    coverageIndex = Math.max(coverageIndex, j - 1);
  }

  // Basic shape validation of ALL rows — out-of-envelope rows are ignored only
  // AFTER this (§1.4): strictly ascending unique opens (no sort/repair in
  // core), finite fields, OHLC bounds.
  const rows = data.bars;
  let prevTime = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    if (
      !Number.isFinite(b.time) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      !Number.isFinite(b.volume)
    ) {
      throw new Error(`bar magnifier: target bar ${i} has a non-finite field`);
    }
    if (
      b.high < b.low ||
      b.high < b.open ||
      b.high < b.close ||
      b.low > b.open ||
      b.low > b.close
    ) {
      throw new Error(`bar magnifier: target bar ${i} violates OHLC bounds`);
    }
    if (b.time <= prevTime) {
      throw new Error(
        `bar magnifier: target bar opens must be strictly ascending and unique (row ${i}); ` +
          'the core never sorts or repairs',
      );
    }
    prevTime = b.time;
  }

  // Coverage self-consistency (§3.4): rows that can participate in a chart
  // interval must be explained by the declared coverage. Acquisition padding
  // before/after the chart envelope and rows inside explicit session gaps are
  // shape-validated above, but may legitimately sit outside coverage clipped
  // to the logical chart intervals (§3.2); they are ignored here and during
  // bucket assignment. Keep a chart cursor so only [chartOpen, chartClose)
  // rows reach the coverage-membership check.
  let rowChartIndex = 0;
  let rowCoverageIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].time;
    while (rowChartIndex < chartBars.length && closes[rowChartIndex] <= t) {
      rowChartIndex++;
    }
    if (rowChartIndex >= chartBars.length || t < chartBars[rowChartIndex].time) {
      continue;
    }

    while (rowCoverageIndex < cov.covered.length && cov.covered[rowCoverageIndex].to <= t) {
      rowCoverageIndex++;
    }
    if (rowCoverageIndex >= cov.covered.length || t < cov.covered[rowCoverageIndex].from) {
      throw new Error(`bar magnifier: target bar ${i} lies outside the declared covered intervals`);
    }
  }

  // Freeze the validated row objects in place. This preserves the host-owned
  // immutable dataset identity (and avoids a 200k-row clone per engine) while
  // ensuring no source or bucket reference can mutate OHLC after validation.
  for (const row of rows) Object.freeze(row);

  if (chartBars.length === 0) return Object.freeze([]);

  // 3+4. Envelope [firstChartOpen, finalChartClose) — rows outside are ignored
  // and MUST NOT affect anything downstream, including the cap choice.
  const envFrom = chartBars[0].time;
  const envTo = closes[closes.length - 1];
  let lo = 0;
  while (lo < rows.length && rows[lo].time < envFrom) lo++;
  let hi = rows.length;
  while (hi > lo && rows[hi - 1].time >= envTo) hi--;
  const eligible = hi - lo;

  // 5. Retain the newest min(limit, eligible) target rows (§1.4 step 3).
  const retainedCount = Math.max(0, Math.min(limit, eligible));
  const start = hi - retainedCount; // oldest retained row index
  const dropped = eligible - retainedCount;

  // 6. Partition the retained suffix by [chartOpen, chartClose) with ONE
  // forward cursor (§4 step 6). Rows inside session gaps (>= a bar's close,
  // < the next bar's open) belong to no bucket and are unused.
  const buckets: Array<{
    chartIndex: number;
    bars: readonly PinerBar[];
    coverage: IntrabarBucket['coverage'];
    fallbackReason?: IntrabarBucket['fallbackReason'];
  }> = new Array(chartBars.length);
  let cur = start;
  let droppedCur = lo;
  for (let i = 0; i < chartBars.length; i++) {
    const open = chartBars[i].time;
    const close = closes[i];
    while (cur < hi && rows[cur].time < open) cur++;
    const first = cur;
    while (cur < hi && rows[cur].time < close) cur++;
    const bucketBars = Object.freeze(rows.slice(first, cur));

    // Preserve cap provenance for every interval that lost eligible rows, not
    // just the one partial boundary. A clean edge cut therefore remains
    // coverage 'none' while reports can still distinguish it from no data.
    while (droppedCur < start && rows[droppedCur].time < open) droppedCur++;
    const firstDropped = droppedCur;
    while (droppedCur < start && rows[droppedCur].time < close) droppedCur++;

    buckets[i] = {
      chartIndex: i,
      bars: bucketBars,
      coverage: bucketBars.length > 0 ? 'available' : 'none',
      ...(droppedCur > firstDropped ? { fallbackReason: 'cap' as const } : {}),
    };
  }

  // 7. Mark the earliest cap-intersected bucket (§4 step 7): the cap cut
  // through a chart bucket iff the newest DROPPED row falls inside the same
  // chart interval as the oldest RETAINED row. When the cut lands exactly on a
  // bucket edge (or in a session gap), no bucket is partial — earlier buckets
  // are simply 'none'. Driver conservatively falls back for a 'cap-boundary'
  // bucket and reports cap provenance; direct-TV M4 could refine that later.
  if (dropped > 0 && retainedCount > 0) {
    const newestDroppedTime = rows[start - 1].time;
    let j = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].bars.length > 0) {
        j = i;
        break;
      }
    }
    if (j >= 0 && newestDroppedTime >= chartBars[j].time) {
      buckets[j].coverage = 'cap-boundary';
    }
  }

  // 8. Immutable buckets (§4 step 8) — Driver stores this array exactly once
  // per historical run()/prepare() and applies the supported traversal/fallback policy.
  for (const b of buckets) Object.freeze(b);
  return Object.freeze(buckets);
}
