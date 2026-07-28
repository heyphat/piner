/**
 * Bar Magnifier P1 partition tests (dev-docs/bar-magnifier-plan.md §1.4/§4/§11.1):
 * envelope filter and 200k cap below/at/above, out-of-envelope rows cannot alter
 * the retained suffix (filtering BEFORE capping is load-bearing), explicit chart
 * ends with session gaps and the final bar, the earliest cap-intersected bucket
 * marking (Driver conservatively falls back and reports cap provenance; a
 * direct-TV M4 fixture could refine that policy later), fail-closed validation,
 * and bucket immutability.
 */
import { describe, it, expect } from 'bun:test';
import type { Bar, BarMagnifierData, PinerBar, UnixMillisecond } from '../src/index.js';
import {
  prepareMagnifierBuckets,
  partitionWithTargetLimit,
  BAR_MAGNIFIER_TARGET_BAR_LIMIT,
  type IntrabarBucket,
} from '../src/engine/intrabars.js';

const H = 3_600_000; // one 60m chart bar, ms
const M10 = 600_000; // one 10m target bar, ms

const ms = (n: number) => n as unknown as UnixMillisecond;

/** A degenerate-but-valid OHLC row at `time` (o=h=l=c). */
const row = (time: number): PinerBar => ({
  time: ms(time),
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
});

const chartBar = (time: number): Bar => ({
  time,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
});

/** Dataset builder: valid host-asserted complete coverage spanning the rows. */
function mkData(
  rows: readonly PinerBar[],
  closeTimes: readonly number[],
  overrides: {
    targetTimeframe?: string;
    complete?: boolean;
    gaps?: BarMagnifierData['coverage']['gaps'];
    requested?: [number, number];
    covered?: Array<[number, number]>;
    source?: BarMagnifierData['chartIntervals']['source'];
  } = {},
): BarMagnifierData {
  const lastTime = rows.length ? (rows[rows.length - 1].time as number) : 0;
  const finalClose = closeTimes.length ? closeTimes[closeTimes.length - 1] : 0;
  const [reqFrom, reqTo] = overrides.requested ?? [-H, Math.max(lastTime + H, finalClose, H)];
  return {
    targetTimeframe: overrides.targetTimeframe ?? '10',
    bars: rows,
    chartIntervals: {
      closeTimes: closeTimes.map(ms),
      source: overrides.source ?? 'utc-fixed',
    },
    coverage: {
      requested: { from: ms(reqFrom), to: ms(reqTo) },
      covered: (overrides.covered ?? [[reqFrom, reqTo]]).map(([f, t]) => ({
        from: ms(f),
        to: ms(t),
      })),
      gaps: overrides.gaps ?? [],
      complete: overrides.complete ?? true,
    },
  };
}

/** Every bucketed row must sit inside its own chart interval, and each used row
 *  must appear in exactly ONE bucket (plan §4 invariants). */
function assertPartitionInvariants(
  buckets: readonly IntrabarBucket[],
  chartBars: readonly Bar[],
  closeTimes: readonly number[],
): void {
  const seen = new Set<number>();
  for (const b of buckets) {
    expect(b.chartIndex).toBeGreaterThanOrEqual(0);
    expect(b.chartIndex).toBeLessThan(chartBars.length);
    for (const r of b.bars) {
      expect(r.time).toBeGreaterThanOrEqual(chartBars[b.chartIndex].time);
      expect(r.time).toBeLessThan(closeTimes[b.chartIndex]);
      expect(seen.has(r.time)).toBe(false);
      seen.add(r.time);
    }
  }
}

describe('bar magnifier — partition happy path (plan §4)', () => {
  it('assigns each in-interval row to exactly one bucket, in order', () => {
    const chart = [chartBar(0), chartBar(H), chartBar(2 * H)];
    const closes = [H, 2 * H, 3 * H];
    const rows = chart.flatMap((c) => Array.from({ length: 6 }, (_, k) => row(c.time + k * M10)));
    const buckets = prepareMagnifierBuckets(chart, '60', mkData(rows, closes));
    expect(buckets.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(buckets[i].chartIndex).toBe(i);
      expect(buckets[i].coverage).toBe('available');
      expect(buckets[i].bars.length).toBe(6);
      expect(buckets[i].bars.map((r) => r.time)).toEqual(
        Array.from({ length: 6 }, (_, k) => ms(i * H + k * M10)),
      );
    }
    assertPartitionInvariants(buckets, chart, closes);
  });

  it('an empty chart bucket is coverage "none" (exact non-magnifier fallback)', () => {
    const chart = [chartBar(0), chartBar(H), chartBar(2 * H)];
    const closes = [H, 2 * H, 3 * H];
    const rows = [row(0), row(M10), row(2 * H), row(2 * H + M10)]; // nothing in bar 1
    const buckets = prepareMagnifierBuckets(chart, '60', mkData(rows, closes));
    expect(buckets.map((b) => b.coverage)).toEqual(['available', 'none', 'available']);
    expect(buckets[1].bars.length).toBe(0);
    expect(buckets[1].fallbackReason).toBeUndefined();
    assertPartitionInvariants(buckets, chart, closes);
  });

  it('rows inside a session gap belong to NO bucket (explicit chart ends)', () => {
    // Bar 0 = [0, H), session gap [H, 2H), bar 1 = [2H, 3H).
    const chart = [chartBar(0), chartBar(2 * H)];
    const closes = [H, 3 * H];
    const rows = [row(0), row(M10), row(H), row(H + M10), row(2 * H), row(2 * H + M10)];
    const buckets = prepareMagnifierBuckets(
      chart,
      '60',
      mkData(rows, closes, {
        requested: [0, 3 * H],
        covered: [
          [0, H],
          [2 * H, 3 * H],
        ],
      }),
    );
    expect(buckets[0].bars.map((r) => r.time)).toEqual([ms(0), ms(M10)]);
    expect(buckets[1].bars.map((r) => r.time)).toEqual([ms(2 * H), ms(2 * H + M10)]);
    assertPartitionInvariants(buckets, chart, closes);
  });

  it('out-of-envelope padding outside clipped coverage is ignored', () => {
    const chart = [chartBar(0), chartBar(H)];
    const closes = [H, 2 * H];
    const inEnv = [row(0), row(M10), row(H), row(H + M10)];
    const withPadding = [row(-M10), ...inEnv, row(2 * H), row(2 * H + M10)];
    const coverage = {
      requested: [0, 2 * H] as [number, number],
      covered: [[0, 2 * H]] as Array<[number, number]>,
    };
    const a = prepareMagnifierBuckets(chart, '60', mkData(inEnv, closes, coverage));
    const b = prepareMagnifierBuckets(chart, '60', mkData(withPadding, closes, coverage));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.isFrozen(withPadding[0])).toBe(true);
    expect(Object.isFrozen(withPadding[withPadding.length - 1])).toBe(true);
  });

  it('malformed padded rows are still rejected by basic shape validation', () => {
    const chart = [chartBar(0)];
    const malformedPadding = { ...row(-M10), high: 0 };
    expect(() =>
      prepareMagnifierBuckets(
        chart,
        '60',
        mkData([malformedPadding, row(0), row(H)], [H], {
          requested: [0, H],
          covered: [[0, H]],
        }),
      ),
    ).toThrow(/target bar 0 violates OHLC bounds/);
  });

  it('unequal chart-bar durations (calendar/session boundaries) partition exactly', () => {
    // Three bars of different lengths with two session gaps:
    // [0, 2000) — gap — [3000, 7000) — gap — [10000, 11000)
    const chart = [chartBar(0), chartBar(3000), chartBar(10000)];
    const closes = [2000, 7000, 11000];
    const rows = [-1, 0, 1999, 2000, 2999, 3000, 6999, 7000, 9999, 10000, 10999, 11000].map(row);
    const buckets = prepareMagnifierBuckets(chart, '60', mkData(rows, closes));
    expect(buckets[0].bars.map((r) => r.time)).toEqual([ms(0), ms(1999)]);
    expect(buckets[1].bars.map((r) => r.time)).toEqual([ms(3000), ms(6999)]);
    expect(buckets[2].bars.map((r) => r.time)).toEqual([ms(10000), ms(10999)]);
    // -1 is before the envelope; 2000/2999/7000/9999 are session-gap rows;
    // 11000 is at the final close (exclusive) — none may appear anywhere.
    assertPartitionInvariants(buckets, chart, closes);
  });

  it('no chart bars → no buckets; a padding-only dataset needs no covered span', () => {
    const source = [row(0)];
    const buckets = prepareMagnifierBuckets(
      [],
      '60',
      mkData(source, [], { requested: [0, H], covered: [] }),
    );
    expect(buckets).toEqual([]);
    expect(Object.isFrozen(buckets)).toBe(true);
    expect(Object.isFrozen(source[0])).toBe(true);
  });

  it('buckets, arrays, and validated source rows are deeply immutable', () => {
    const chart = [chartBar(0)];
    const source = [row(0)];
    const buckets = prepareMagnifierBuckets(chart, '60', mkData(source, [H]));
    expect(Object.isFrozen(buckets)).toBe(true);
    expect(Object.isFrozen(buckets[0])).toBe(true);
    expect(Object.isFrozen(buckets[0].bars)).toBe(true);
    expect(Object.isFrozen(source[0])).toBe(true);
    expect(buckets[0].bars[0]).toBe(source[0]); // no 200k-row object clone

    expect(() => {
      (source[0] as unknown as Bar).high = 0;
    }).toThrow();
    expect(() => {
      (buckets[0].bars[0] as unknown as Bar).low = 2;
    }).toThrow();
    expect(buckets[0].bars[0].high).toBe(1);
    expect(buckets[0].bars[0].low).toBe(1);

    // Replacing an entry in the caller's array cannot alter the frozen slice.
    source[0] = row(M10);
    expect(buckets[0].bars[0].time).toBe(ms(0));
  });
});

describe('bar magnifier — envelope filter precedes the cap (plan §1.4, load-bearing)', () => {
  const chart = [chartBar(0), chartBar(H)];
  const closes = [H, 2 * H];
  const eligible = [0, M10, 2 * M10, H, H + M10, H + 2 * M10].map(row); // 3 + 3

  it('cap above / at / below the eligible count', () => {
    // above: nothing dropped
    const above = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 10);
    expect(above.map((b) => [b.coverage, b.bars.length])).toEqual([
      ['available', 3],
      ['available', 3],
    ]);
    // exactly at: nothing dropped, no cap mark
    const at = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 6);
    expect(JSON.stringify(at)).toBe(JSON.stringify(above));
    // below, cutting INSIDE bucket 0: earliest intersected bucket is marked
    const below = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 4);
    expect(below[0].coverage).toBe('cap-boundary');
    expect(below[0].fallbackReason).toBe('cap');
    expect(below[0].bars.map((r) => r.time)).toEqual([ms(2 * M10)]); // newest 1 of its 3
    expect(below[1].coverage).toBe('available');
    expect(below[1].fallbackReason).toBeUndefined();
    expect(below[1].bars.length).toBe(3);
  });

  it('equality boundary: newest dropped row exactly AT the first bucket open still marks it', () => {
    // limit 5 drops only the row at t=0 — the newest dropped time EQUALS chart
    // bar 0's open. The half-open interval [open, close) contains its open, so
    // the cap did cut through bucket 0: it must be 'cap-boundary' (>=, not >).
    const eq = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 5);
    expect(eq[0].coverage).toBe('cap-boundary');
    expect(eq[0].fallbackReason).toBe('cap');
    expect(eq[0].bars.map((r) => r.time)).toEqual([ms(M10), ms(2 * M10)]);
    expect(eq[1].coverage).toBe('available');
    expect(eq[1].bars.length).toBe(3);
  });

  it('a cut exactly on a bucket edge keeps coverage none but records cap fallback', () => {
    const clean = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 3);
    expect(clean[0].coverage).toBe('none');
    expect(clean[0].fallbackReason).toBe('cap');
    expect(clean[0].bars.length).toBe(0);
    expect(clean[1].coverage).toBe('available');
    expect(clean[1].fallbackReason).toBeUndefined();
    expect(clean[1].bars.length).toBe(3);
  });

  it('a cut landing in a session gap marks nothing', () => {
    // bar 0 = [0, H), gap [H, 2H), bar 1 = [2H, 3H)
    const gapChart = [chartBar(0), chartBar(2 * H)];
    const gapCloses = [H, 3 * H];
    const rows = [0, M10, H, H + M10, 2 * H, 2 * H + M10].map(row); // 2 bucket0, 2 gap, 2 bucket1
    const buckets = partitionWithTargetLimit(gapChart, '60', mkData(rows, gapCloses), 3);
    // retained newest 3 = one gap row + both bucket-1 rows; the newest DROPPED row
    // is also a gap row — no bucket was cut through.
    expect(buckets[0].coverage).toBe('none');
    expect(buckets[0].fallbackReason).toBe('cap');
    expect(buckets[1].coverage).toBe('available');
    expect(buckets[1].fallbackReason).toBeUndefined();
    expect(buckets[1].bars.length).toBe(2);
  });

  it('trailing rows after the final chart close cannot evict chart-range data (plan §4)', () => {
    const trailing = [...eligible, row(2 * H), row(2 * H + M10), row(2 * H + 2 * M10)];
    for (const limit of [3, 4, 6]) {
      const withoutJunk = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), limit);
      const withJunk = partitionWithTargetLimit(chart, '60', mkData(trailing, closes), limit);
      expect(JSON.stringify(withJunk)).toBe(JSON.stringify(withoutJunk));
    }
  });

  it('limit 0 retains nothing, keeps coverage none, and records cap provenance', () => {
    const none = partitionWithTargetLimit(chart, '60', mkData(eligible, closes), 0);
    expect(none.map((b) => [b.coverage, b.bars.length, b.fallbackReason])).toEqual([
      ['none', 0, 'cap'],
      ['none', 0, 'cap'],
    ]);
  });

  /** n-1 full hourly chart bars (6 ten-minute rows each) + a final bar holding
   *  `lastBarRows` rows — drives the PUBLIC 200,000-row cap exactly. */
  function genUniform(nBars: number, lastBarRows: number) {
    const chartBig: Bar[] = new Array(nBars);
    const closesBig: number[] = new Array(nBars);
    const rowsBig: PinerBar[] = [];
    for (let i = 0; i < nBars; i++) {
      chartBig[i] = chartBar(i * H);
      closesBig[i] = (i + 1) * H;
      const count = i === nBars - 1 ? lastBarRows : 6;
      for (let k = 0; k < count; k++) rowsBig.push(row(i * H + k * M10));
    }
    return { chartBig, closesBig, rowsBig };
  }

  it('the real cap, BELOW 200,000 eligible rows: nothing dropped, nothing marked', () => {
    const { chartBig, closesBig, rowsBig } = genUniform(33_333, 6); // 199,998
    const buckets = prepareMagnifierBuckets(chartBig, '60', mkData(rowsBig, closesBig));
    expect(buckets[0].coverage).toBe('available');
    expect(buckets[0].bars.length).toBe(6);
    expect(buckets.every((b) => b.coverage === 'available')).toBe(true);
  });

  it('the real cap, AT exactly 200,000 eligible rows: nothing dropped, nothing marked', () => {
    const { chartBig, closesBig, rowsBig } = genUniform(33_334, 2); // 6×33,333 + 2
    expect(rowsBig.length).toBe(200_000);
    const buckets = prepareMagnifierBuckets(chartBig, '60', mkData(rowsBig, closesBig));
    expect(buckets[0].coverage).toBe('available');
    expect(buckets[0].bars.length).toBe(6);
    expect(buckets.some((b) => b.coverage === 'cap-boundary')).toBe(false);
    let total = 0;
    for (const b of buckets) total += b.bars.length;
    expect(total).toBe(200_000);
  });

  it('the real 200,000 cap: newest suffix retained, earliest intersected bucket marked', () => {
    expect(BAR_MAGNIFIER_TARGET_BAR_LIMIT).toBe(200_000);
    // 33,335 hourly chart bars × 6 ten-minute rows = 200,010 eligible → 10 dropped:
    // bucket 0 loses all 6 (clean), bucket 1 loses its oldest 4 (cap-boundary).
    const n = 33_335;
    const chartBig: Bar[] = new Array(n);
    const closesBig: number[] = new Array(n);
    const rowsBig: PinerBar[] = new Array(n * 6);
    for (let i = 0; i < n; i++) {
      chartBig[i] = chartBar(i * H);
      closesBig[i] = (i + 1) * H;
      for (let k = 0; k < 6; k++) rowsBig[i * 6 + k] = row(i * H + k * M10);
    }
    const buckets = prepareMagnifierBuckets(chartBig, '60', mkData(rowsBig, closesBig));
    expect(buckets[0].coverage).toBe('none');
    expect(buckets[0].fallbackReason).toBe('cap');
    expect(buckets[0].bars.length).toBe(0);
    expect(buckets[1].coverage).toBe('cap-boundary');
    expect(buckets[1].fallbackReason).toBe('cap');
    expect(buckets[1].bars.length).toBe(2);
    expect(buckets[1].bars[0].time).toBe(ms(H + 4 * M10));
    expect(buckets[2].coverage).toBe('available');
    expect(buckets[2].bars.length).toBe(6);
    let total = 0;
    for (const b of buckets) total += b.bars.length;
    expect(total).toBe(200_000);
  });
});

describe('bar magnifier — fail-closed validation (plan §0.1/§3.4/§3.5)', () => {
  const chart = [chartBar(0), chartBar(H)];
  const closes = [H, 2 * H];
  const rows = [row(0), row(H)];

  const cases: Array<[string, () => void]> = [
    ['closeTimes count mismatch', () => prepareMagnifierBuckets(chart, '60', mkData(rows, [H]))],
    ['chart open >= close', () => prepareMagnifierBuckets(chart, '60', mkData(rows, [0, 2 * H]))],
    [
      'overlapping chart intervals',
      () => prepareMagnifierBuckets(chart, '60', mkData(rows, [H + M10, 2 * H])),
    ],
    [
      'unsorted target rows (core never sorts or repairs)',
      () => prepareMagnifierBuckets(chart, '60', mkData([row(H), row(0)], closes)),
    ],
    [
      'duplicate target row times',
      () => prepareMagnifierBuckets(chart, '60', mkData([row(0), row(0)], closes)),
    ],
    [
      'non-finite field',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData([{ ...row(0), open: Number.NaN }, row(H)], closes),
        ),
    ],
    [
      'OHLC bounds violation (high < open)',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData([{ ...row(0), open: 2, high: 1, low: 0.5, close: 1 }, row(H)], closes),
        ),
    ],
    [
      'coverage.complete === false is rejected (host-side typed failure, not fallback)',
      () => prepareMagnifierBuckets(chart, '60', mkData(rows, closes, { complete: false })),
    ],
    [
      'explicit provider gaps are rejected',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData(rows, closes, {
            gaps: [{ from: ms(0), to: ms(M10), reason: 'provider-missing' }],
          }),
        ),
    ],
    [
      'empty coverage.requested interval',
      () => prepareMagnifierBuckets(chart, '60', mkData(rows, closes, { requested: [H, H] })),
    ],
    [
      'coverage.requested misses the leading chart envelope, even with no rows',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData([], closes, { requested: [M10, 2 * H], covered: [[M10, 2 * H]] }),
        ),
    ],
    [
      'coverage.requested misses the trailing chart envelope, even with no rows',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData([], closes, {
            requested: [0, 2 * H - M10],
            covered: [[0, 2 * H - M10]],
          }),
        ),
    ],
    [
      'declared complete coverage has an internal hole inside a chart interval',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData([], closes, {
            requested: [0, 2 * H],
            covered: [
              [0, H],
              [H + M10, 2 * H],
            ],
          }),
        ),
    ],
    [
      'covered outside requested',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData(rows, closes, { requested: [0, H], covered: [[-M10, H]] }),
        ),
    ],
    [
      'covered intervals unsorted/overlapping',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData(rows, closes, {
            requested: [0, 2 * H],
            covered: [
              [0, H],
              [H - M10, 2 * H],
            ],
          }),
        ),
    ],
    [
      'contradictory coverage: complete with no covered intervals but nonempty bars',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData(rows, closes, { requested: [0, 2 * H], covered: [] }),
        ),
    ],
    [
      'contradictory coverage: a target bar outside every covered interval',
      () =>
        prepareMagnifierBuckets(
          chart,
          '60',
          mkData(rows, closes, { requested: [0, 2 * H], covered: [[0, H]] }),
        ),
    ],
    [
      'nonempty dataset with a mismatched target timeframe',
      () => prepareMagnifierBuckets(chart, '60', mkData(rows, closes, { targetTimeframe: '5' })),
    ],
    [
      'nonempty dataset on an invalid chart timeframe',
      () => prepareMagnifierBuckets(chart, '1h', mkData(rows, closes)),
    ],
  ];

  for (const [name, fn] of cases) {
    it(`rejects: ${name}`, () => {
      expect(fn).toThrow(/bar magnifier/);
    });
  }

  it('rejects a non-integer or negative internal limit (test seam stays fail-closed)', () => {
    for (const bad of [2.5, -1, Number.NaN]) {
      expect(() => partitionWithTargetLimit(chart, '60', mkData(rows, closes), bad)).toThrow(
        /bar magnifier/,
      );
    }
  });

  it('an EMPTY dataset with a mismatched label does not throw — every bucket is "none"', () => {
    const buckets = prepareMagnifierBuckets(
      chart,
      '60',
      mkData([], closes, { targetTimeframe: '5' }),
    );
    expect(buckets.map((b) => b.coverage)).toEqual(['none', 'none']);
  });
});
