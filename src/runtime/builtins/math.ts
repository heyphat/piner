/**
 * math.* — pure (stateless) numeric built-ins. na (NaN) propagates naturally
 * through JS arithmetic; explicit guards keep na contagious where needed.
 */
const na = (x: number) => Number.isNaN(x);

/**
 * mulberry32 — tiny deterministic hash from a 32-bit integer seed to a float in
 * [0, 1). math.random uses it as a PURE function of its seed (no retained state),
 * so both backends and realtime rollback always agree (the §7 oracle invariant).
 */
function mulberry32(seed: number): number {
  let a = (seed >>> 0) + 0x6d2b79f5;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const MathNs = {
  // constants
  pi: Math.PI,
  e: Math.E,
  phi: 1.618033988749895,
  rphi: 0.618033988749895,

  max(...xs: number[]): number {
    return xs.some(na) ? NaN : Math.max(...xs);
  },
  min(...xs: number[]): number {
    return xs.some(na) ? NaN : Math.min(...xs);
  },
  abs(x: number): number {
    return Math.abs(x);
  },
  // Pine rounds ties AWAY FROM ZERO (JS Math.round rounds toward +∞).
  round(x: number, precision = 0): number {
    const f = 10 ** precision;
    return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
  },
  pow(b: number, e: number): number {
    return na(b) || na(e) ? NaN : b ** e; // guard: JS NaN ** 0 === 1, Pine says na
  },
  sqrt(x: number): number {
    return Math.sqrt(x);
  },
  sign(x: number): number {
    return na(x) ? NaN : Math.sign(x);
  },
  avg(...xs: number[]): number {
    return xs.some(na) ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
  },
  log(x: number): number {
    return Math.log(x);
  },
  log10(x: number): number {
    return Math.log10(x);
  },
  exp(x: number): number {
    return Math.exp(x);
  },
  floor(x: number): number {
    return Math.floor(x);
  },
  ceil(x: number): number {
    return Math.ceil(x);
  },

  // trigonometry — angles in radians
  sin(x: number): number {
    return Math.sin(x);
  },
  cos(x: number): number {
    return Math.cos(x);
  },
  tan(x: number): number {
    return Math.tan(x);
  },
  // asin/acos return na when the argument is outside [-1, 1]; Math.* already
  // yields NaN there so the guard is implicit.
  asin(x: number): number {
    return Math.asin(x);
  },
  acos(x: number): number {
    return Math.acos(x);
  },
  atan(x: number): number {
    return Math.atan(x);
  },
  atan2(y: number, x: number): number {
    return na(y) || na(x) ? NaN : Math.atan2(y, x);
  },

  // angle conversions
  todegrees(radians: number): number {
    return (radians * 180) / Math.PI;
  },
  toradians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  },

  /**
   * Uniform pseudo-random float in [min, max). DETERMINISTIC by design: a pure
   * function of (min, max, seed) with no hidden RNG state, so the two backends
   * and realtime rollback stay byte-for-byte identical (the §7 oracle invariant).
   * A fixed seed always yields the same value; no seed uses seed 0. This is a
   * deliberate divergence from TradingView's non-deterministic RNG.
   */
  random(min = 0, max = 1, seed?: number): number {
    if (na(min) || na(max)) return NaN;
    const key = seed === undefined || na(seed) ? 0 : Math.trunc(seed);
    return min + mulberry32(key) * (max - min);
  },

  // greatest common divisor of two integers (Euclid); na-propagates
  gcd(a: number, b: number): number {
    if (na(a) || na(b)) return NaN;
    let x = Math.abs(Math.trunc(a));
    let y = Math.abs(Math.trunc(b));
    while (y !== 0) {
      [x, y] = [y, x % y];
    }
    return x;
  },

  // Round to the symbol's mintick (piner's fixed syminfo.mintick = 0.01); ties away from zero.
  round_to_mintick(x: number): number {
    return na(x) ? NaN : (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100;
  },

  // n! — returns na for negative n
  factorial(n: number): number {
    if (na(n) || n < 0) return NaN;
    const m = Math.trunc(n);
    let acc = 1;
    for (let i = 2; i <= m; i++) acc *= i;
    return acc;
  },
};
export type MathNamespace = typeof MathNs;
