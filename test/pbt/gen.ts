/**
 * Shared fast-check generators for the library-import-export property tests.
 * Feature: library-import-export.
 */
import fc from 'fast-check';
import type { Bar } from '../../src/index.js';

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
// Identity segments in the wild use mixed case, digits, and underscores
// (`PineCoders/AllTimeHighLow/1`, `rayolf/rc_highest_lowest/1`). Exercise all of them,
// but keep a fixed leading letter so a segment is never a keyword and never starts with
// a digit (both would be invalid where a segment is parsed as an identifier).
const IDENT_CHARS = [...LOWER, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), ...'0123456789'.split(''), '_'];

/** A safe Pine identifier segment: starts with a fixed letter, never a keyword, no `/`. */
export const seg: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...IDENT_CHARS), { minLength: 1, maxLength: 8 })
  .map((a) => `l${a.join('')}`);

/** A version integer (imports parse the version as an integer literal). */
export const versionInt: fc.Arbitrary<number> = fc.integer({ min: 1, max: 9999 });

/** Deterministic OHLCV bars from a seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeBars(n: number, seed: number): Bar[] {
  const r = mulberry32(seed);
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = Math.max(1, price + (r() - 0.5) * 6);
    const open = price + (r() - 0.5) * 2;
    const close = price + (r() - 0.5) * 2;
    const high = Math.max(open, close) + r() * 2;
    const low = Math.min(open, close) - r() * 2;
    bars.push({ time: i * 60000, open, high, low, close, volume: Math.floor(r() * 5000) });
  }
  return bars;
}

export const barsArb = (n = 30): fc.Arbitrary<Bar[]> =>
  fc.integer({ min: 1, max: 1_000_000 }).map((seed) => makeBars(n, seed));

/**
 * A safe Pine numeric expression over the given leaf variables and builtins that
 * never divides, never produces strings, and agrees deterministically across the
 * two backends. Depth-limited to keep expansion bounded.
 */
export function exprArb(leaves: string[], depth = 3): fc.Arbitrary<string> {
  const leaf = fc.constantFrom(...leaves, '1.0', '2.0', '0.5', '3.0');
  if (depth <= 0) return leaf;
  const sub = () => exprArb(leaves, depth - 1);
  return fc.oneof(
    { weight: 2, arbitrary: leaf },
    { weight: 3, arbitrary: fc.tuple(sub(), sub(), fc.constantFrom('+', '-', '*')).map(([a, b, op]) => `(${a} ${op} ${b})`) },
    { weight: 1, arbitrary: sub().map((e) => `ta.sma(${e}, 5)`) },
    { weight: 1, arbitrary: sub().map((e) => `ta.ema(${e}, 4)`) },
    { weight: 1, arbitrary: sub().map((e) => `math.abs(${e})`) },
    { weight: 1, arbitrary: fc.tuple(sub(), sub()).map(([a, b]) => `math.max(${a}, ${b})`) },
  );
}
