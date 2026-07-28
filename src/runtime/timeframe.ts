/**
 * Pine timeframe parsing + the Bar Magnifier chart→intrabar mapping
 * (dev-docs/bar-magnifier-plan.md §1.3).
 *
 * This is a REAL parser, deliberately separate from `tfSeconds()` (context.ts),
 * which is lossy for contract purposes: its regex cannot represent tick
 * intervals ("100T" falls through to minutes) and it flattens months to an
 * average duration. The magnifier contract needs exact domain/unit/count
 * identity. Nominal durations are used here ONLY to order time intervals
 * against the mapping's range boundaries — never to convert timestamps.
 *
 * Clean-room: implemented from the public TradingView docs — the Help Center
 * Bar Magnifier page (chart→intrabar table) and the Pine v6 timeframe
 * specification (unit letters and multiplier bounds).
 */

/** A parsed Pine timeframe string. Ticks and time are distinct domains: a tick
 *  count is not a duration and must never be compared against one. */
export type PineTimeframe =
  | { domain: 'tick'; count: number }
  | {
      domain: 'time';
      unit: 'second' | 'minute' | 'day' | 'week' | 'month';
      count: number;
    };

/** Version of the host-facing Bar Magnifier contract (data channel shape,
 *  report block, mapping export). Bumped on any breaking contract change so a
 *  host (pinerun) can gate by capability instead of failing module linkage. */
export const BAR_MAGNIFIER_CONTRACT_VERSION = 1;

/** Version of the chart→intrabar mapping table below. Bumped whenever a range,
 *  target, or fail-closed support boundary changes, so host memo keys invalidate
 *  correctly. Version 3 implements the published terminal `chart >= 1W` row for
 *  every chart at or above one week — including multi-week, `>7D`, and month —
 *  which version 2 withheld as an unprobed extension. */
export const BAR_MAGNIFIER_MAPPING_VERSION = 3;

/** Pine v6 timeframe format: optional integer multiplier + optional unit letter
 *  (T ticks, S seconds, D days, W weeks, M months; no letter ⇒ minutes), at
 *  least one of the two present. A bare unit means a multiplier of 1. */
const TF_RE = /^(\d+)?([TSDWM])?$/;

/** Documented Pine v6 multipliers. Seconds and ticks are discrete; the
 *  remaining units accept an inclusive integer range. */
const VALID_SECOND_COUNTS = new Set([1, 5, 10, 15, 30, 45]);
const VALID_TICK_COUNTS = new Set([1, 10, 100, 1000]);
const MAX_COUNT: Record<'minute' | 'day' | 'week' | 'month', number> = {
  minute: 1440,
  day: 365,
  week: 52,
  month: 12,
};

/**
 * Parse a Pine timeframe string ("60", "1D", "30S", "100T", bare "D"/"W"/…)
 * into its exact domain/unit/count. Throws on anything outside the documented
 * v6 vocabulary — including nonstandard second/tick multipliers — so the
 * magnifier contract fails closed rather than guessing (plan §0.1).
 */
export function parsePineTimeframe(tf: string): PineTimeframe {
  const m = TF_RE.exec(tf);
  if (!m || (m[1] === undefined && m[2] === undefined)) {
    throw new Error(`bar magnifier: invalid Pine timeframe "${tf}"`);
  }
  const countStr = m[1];
  // Strict format: no leading zeros, and a zero multiplier is meaningless.
  if (countStr !== undefined && (countStr.startsWith('0') || Number(countStr) < 1)) {
    throw new Error(`bar magnifier: invalid Pine timeframe multiplier in "${tf}"`);
  }
  const count = countStr === undefined ? 1 : Number(countStr);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`bar magnifier: invalid Pine timeframe multiplier in "${tf}"`);
  }
  const unitLetter = m[2];
  if (unitLetter === 'T') {
    if (!VALID_TICK_COUNTS.has(count)) {
      throw new Error(
        `bar magnifier: unsupported Pine tick multiplier ${count} in "${tf}" ` +
          '(valid: 1, 10, 100, 1000)',
      );
    }
    return { domain: 'tick', count };
  }
  const unit =
    unitLetter === 'S'
      ? 'second'
      : unitLetter === 'D'
        ? 'day'
        : unitLetter === 'W'
          ? 'week'
          : unitLetter === 'M'
            ? 'month'
            : 'minute';
  if (unit === 'second') {
    if (!VALID_SECOND_COUNTS.has(count)) {
      throw new Error(
        `bar magnifier: unsupported Pine second multiplier ${count} in "${tf}" ` +
          '(valid: 1, 5, 10, 15, 30, 45)',
      );
    }
  } else if (count > MAX_COUNT[unit]) {
    throw new Error(
      `bar magnifier: Pine timeframe multiplier ${count} exceeds the v6 bound for ${unit}s in "${tf}"`,
    );
  }
  return { domain: 'time', unit, count };
}

/**
 * Nominal seconds per unit — used ONLY to order a chart timeframe against the
 * mapping's range boundaries (all of which sit at second/minute/day/week
 * marks). The month value is a 28-day LOWER BOUND, not a conversion: the only
 * range a month can land in is the terminal `>= 1W` row, and any bound in
 * [28d, ∞) orders every real calendar month identically there.
 */
const NOMINAL_SECONDS: Record<'second' | 'minute' | 'day' | 'week' | 'month', number> = {
  second: 1,
  minute: 60,
  day: 86_400,
  week: 604_800,
  month: 2_419_200,
};

/**
 * TradingView's Bar Magnifier chart→intrabar mapping (Help Center table read
 * as ranges — each row covers chart intervals until the next row; plan §1.3):
 *
 * | chart interval range          | target |
 * | ----------------------------- | ------ |
 * | 1T   <= chart < 100T          | 1T     |
 * | 100T <= chart < 1000T         | 10T    |
 * | chart >= 1000T                | 100T   |
 * | 1S   <= chart < 30S           | 1S     |
 * | 30S  <= chart < 1m            | 5S     |
 * | 1m   <= chart < 5m            | 10S    |
 * | 5m   <= chart < 10m           | 30S    |
 * | 10m  <= chart < 15m           | 1m     |
 * | 15m  <= chart < 30m           | 2m     |
 * | 30m  <= chart < 60m           | 5m     |
 * | 60m  <= chart < 240m          | 10m    |
 * | 240m <= chart < 1D            | 30m    |
 * | 1D   <= chart < 3D            | 60m    |
 * | 3D   <= chart < 1W            | 240m   |
 * | chart >= 1W                   | 1D     |
 *
 * Both terminal rows are UNBOUNDED ranges, and are implemented as written:
 * `chart >= 1000T` maps every larger tick chart to `100T`, and `chart >= 1W`
 * maps every chart at or above one week — multi-week, `>7D`, and month
 * included — to `1D`. Reading the final row as covering only exactly `1W`
 * would contradict the table and leave common chart timeframes unmappable.
 *
 * Only genuinely INVALID Pine timeframes throw (bad unit, unsupported discrete
 * second/tick multiplier). The mapping never clamps a valid timeframe into a
 * neighbouring row (plan §0.1).
 */
export function barMagnifierTimeframe(chartTf: string): string {
  const tf = parsePineTimeframe(chartTf);
  if (tf.domain === 'tick') {
    if (tf.count < 100) return '1T';
    if (tf.count < 1000) return '10T';
    return '100T';
  }
  const s = NOMINAL_SECONDS[tf.unit] * tf.count;
  if (s < 30) return '1S';
  if (s < 60) return '5S';
  if (s < 300) return '10S';
  if (s < 600) return '30S';
  if (s < 900) return '1';
  if (s < 1800) return '2';
  if (s < 3600) return '5';
  if (s < 14_400) return '10';
  if (s < 86_400) return '30';
  if (s < 259_200) return '60';
  if (s < 604_800) return '240';
  return '1D';
}
