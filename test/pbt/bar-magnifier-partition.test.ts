/**
 * Bar Magnifier partition property tests (dev-docs/bar-magnifier-plan.md §11.1):
 * against a brute-force reference model — each used target row is assigned to
 * exactly one bucket, the retained set is the newest min(limit, eligible)
 * suffix of the chart envelope, out-of-envelope rows have NO effect (including
 * on the cap choice), and the core never sorts or repairs. The cap is
 * exercised through the @internal limit parameter so properties do not need
 * 200,000-row inputs (the public function pins the real limit — see
 * bar-magnifier-partition.test.ts).
 */
import { describe, it, expect } from 'bun:test';
import fc from 'fast-check';
import type { Bar, BarMagnifierData, PinerBar, UnixMillisecond } from '../../src/index.js';
import { partitionWithTargetLimit } from '../../src/engine/intrabars.js';

const ms = (n: number) => n as unknown as UnixMillisecond;
const row = (time: number): PinerBar => ({
  time: ms(time),
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
});
const chartBar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 });

const BAR = 1000; // nominal chart bar span in this model's fake ms
const ENV_HINT = 6 * (1500 + 700); // upper bound of any generated envelope

/** Chart layout: 1–6 bars of UNEQUAL durations (calendar/session-end boundaries),
 *  separated by optional session gaps. */
const chartArb = fc
  .array(
    fc.record({
      dur: fc.integer({ min: 300, max: 1500 }),
      gap: fc.integer({ min: 0, max: 700 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((specs) => {
    const opens: number[] = [];
    const closes: number[] = [];
    let t = 0;
    for (const s of specs) {
      opens.push(t);
      closes.push(t + s.dur);
      t = t + s.dur + s.gap;
    }
    return { chart: opens.map(chartBar), closes };
  });

function mkData(rows: readonly PinerBar[], closes: readonly number[]): BarMagnifierData {
  const last = rows.length ? (rows[rows.length - 1].time as number) : 0;
  const hi = Math.max(last + BAR, (closes[closes.length - 1] ?? 0) + BAR, BAR);
  return {
    targetTimeframe: '10',
    bars: rows,
    chartIntervals: { closeTimes: closes.map(ms), source: 'utc-fixed' },
    coverage: {
      requested: { from: ms(-2 * BAR), to: ms(hi) },
      covered: [{ from: ms(-2 * BAR), to: ms(hi) }],
      gaps: [],
      complete: true,
    },
  };
}

/** Brute-force reference: envelope filter → newest-suffix cap → interval partition. */
function referenceModel(
  chart: readonly Bar[],
  closes: readonly number[],
  rows: readonly PinerBar[],
  limit: number,
) {
  const envFrom = chart[0].time;
  const envTo = closes[closes.length - 1];
  const eligible = rows.filter((r) => r.time >= envFrom && r.time < envTo);
  const retained = eligible.slice(Math.max(0, eligible.length - Math.max(0, limit)));
  const dropped = eligible.length - retained.length;
  const buckets = chart.map((c, i) =>
    retained.filter((r) => r.time >= c.time && r.time < closes[i]).map((r) => r.time as number),
  );
  return {
    buckets,
    retained,
    dropped,
    droppedRows: eligible.slice(0, dropped),
    newestDroppedTime: dropped > 0 ? (eligible[dropped - 1].time as number) : undefined,
  };
}

const rowTimesArb = (envHint: number) =>
  fc.uniqueArray(fc.integer({ min: -2 * BAR, max: envHint + 2 * BAR }), {
    minLength: 0,
    maxLength: 40,
  });

const limitArb = fc.oneof(
  fc.integer({ min: 0, max: 12 }),
  fc.constant(1_000_000), // effectively uncapped
);

describe('bar magnifier — partition properties (plan §11.1 PBT)', () => {
  it('matches the brute-force reference model exactly (assignment, cap size, suffix)', () => {
    fc.assert(
      fc.property(chartArb, rowTimesArb(ENV_HINT), limitArb, ({ chart, closes }, times, limit) => {
        const rows = [...times].sort((a, b) => a - b).map(row);
        const got = partitionWithTargetLimit(chart, '60', mkData(rows, closes), limit);
        const ref = referenceModel(chart, closes, rows, limit);

        // exact per-bucket assignment (each used row exactly once, right bucket)
        expect(got.map((b) => b.bars.map((r) => r.time as number))).toEqual(ref.buckets);
        // cap-size invariant: bucketed + retained-but-in-gap == min(limit, eligible)
        let bucketed = 0;
        for (const b of got) bucketed += b.bars.length;
        const gapRetained = ref.retained.length - bucketed;
        expect(bucketed).toBeLessThanOrEqual(ref.retained.length);
        expect(gapRetained).toBeGreaterThanOrEqual(0);

        // coverage law: 'none' iff empty; only the FIRST nonempty bucket may be
        // 'cap-boundary', and exactly when the newest dropped row falls inside
        // that bucket's interval. The partitioner records this provenance;
        // Driver conservatively falls back, while direct-TV M4 could refine it.
        // Separately, every bucket that lost at least one otherwise eligible row
        // preserves cap provenance, including fully discarded exact-edge buckets.
        const firstNonEmpty = got.findIndex((b) => b.bars.length > 0);
        got.forEach((b, i) => {
          const capDropped = ref.droppedRows.some(
            (r) => r.time >= chart[i].time && r.time < closes[i],
          );
          expect(b.chartIndex).toBe(i);
          expect(b.fallbackReason).toBe(capDropped ? 'cap' : undefined);
          if (b.bars.length === 0) {
            expect(b.coverage).toBe('none');
          } else if (
            i === firstNonEmpty &&
            ref.dropped > 0 &&
            ref.newestDroppedTime !== undefined &&
            ref.newestDroppedTime >= chart[i].time
          ) {
            expect(b.coverage).toBe('cap-boundary');
          } else {
            expect(b.coverage).toBe('available');
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  it('out-of-envelope rows have no effect — including on the cap choice', () => {
    fc.assert(
      fc.property(
        chartArb,
        rowTimesArb(ENV_HINT),
        fc.integer({ min: 0, max: 8 }),
        ({ chart, closes }, times, limit) => {
          const envFrom = chart[0].time;
          const envTo = closes[closes.length - 1];
          const all = [...times].sort((a, b) => a - b).map(row);
          const inEnv = all.filter((r) => r.time >= envFrom && r.time < envTo);
          const a = partitionWithTargetLimit(chart, '60', mkData(inEnv, closes), limit);
          const b = partitionWithTargetLimit(chart, '60', mkData(all, closes), limit);
          expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never sorts or repairs: any out-of-order permutation throws', () => {
    fc.assert(
      fc.property(
        chartArb,
        fc.uniqueArray(fc.integer({ min: 0, max: 5000 }), { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 0, max: 100 }),
        ({ chart, closes }, times, seed) => {
          const sorted = [...times].sort((a, b) => a - b);
          // deterministic non-identity permutation: rotate by 1 + seed offset swap
          const shuffled = [...sorted];
          const i = seed % (shuffled.length - 1);
          [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1], shuffled[i]];
          expect(() =>
            partitionWithTargetLimit(chart, '60', mkData(shuffled.map(row), closes), 10),
          ).toThrow(/bar magnifier/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('results are deeply frozen', () => {
    fc.assert(
      fc.property(chartArb, rowTimesArb(ENV_HINT), ({ chart, closes }, times) => {
        const rows = [...times].sort((a, b) => a - b).map(row);
        const got = partitionWithTargetLimit(chart, '60', mkData(rows, closes), 5);
        expect(Object.isFrozen(got)).toBe(true);
        for (const b of got) {
          expect(Object.isFrozen(b)).toBe(true);
          expect(Object.isFrozen(b.bars)).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });
});
