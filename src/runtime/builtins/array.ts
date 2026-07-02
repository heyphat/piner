/**
 * array.* — collection built-ins, namespace form `array.fn(id, ...)`.
 * Backed by plain JS arrays. The method-call form (`id.push(x)`) is deferred
 * with the rest of method dispatch; the namespace form covers the common usage.
 *
 * Note: array values held in `var`/`varip` are reference objects, so the runtime
 * deep-clones the var store in the realtime rollback snapshot (see context.ts) to
 * avoid a developing-tick array mutation corrupting the committed state.
 */
const isNum = (x: number) => typeof x === 'number' && !Number.isNaN(x);

/** Type-aware sort comparator: numbers numerically (na pinned last, like matrix.sort),
 *  strings lexicographically; `sign` = -1 flips for descending. */
const cmpElems = (x: unknown, y: unknown, sign: number): number => {
  if (typeof x === 'string' || typeof y === 'string') {
    const a = String(x), b = String(y);
    return (a < b ? -1 : a > b ? 1 : 0) * sign;
  }
  const nx = x as number, ny = y as number;
  if (Number.isNaN(nx)) return Number.isNaN(ny) ? 0 : 1;
  if (Number.isNaN(ny)) return -1;
  return (nx - ny) * sign;
};

export const ArrayNs = {
  /** Generic constructor for `array.new<T>(size, initial)` (type arg dropped). */
  new<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  new_float(size = 0, initial = NaN): number[] { return new Array(size).fill(initial); },
  new_int(size = 0, initial = NaN): number[] { return new Array(size).fill(initial); },
  new_bool(size = 0, initial = false): boolean[] { return new Array(size).fill(initial); },
  new_string(size = 0, initial = ''): string[] { return new Array(size).fill(initial); },
  new_color(size = 0, initial = '#00000000'): string[] { return new Array(size).fill(initial); },
  // Drawing-id element arrays. Pine's default initial_value for these is `na`,
  // which the engine represents as NaN, matching the other new_<type> shapes.
  new_line<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  new_label<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  new_box<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  new_table<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  new_linefill<T>(size = 0, initial: T = NaN as unknown as T): T[] { return new Array(size).fill(initial); },
  from<T>(...items: T[]): T[] { return items; },

  push<T>(a: T[], x: T): void { a.push(x); },
  unshift<T>(a: T[], x: T): void { a.unshift(x); },
  pop<T>(a: T[]): T | number { return a.length ? (a.pop() as T) : NaN; },
  shift<T>(a: T[]): T | number { return a.length ? (a.shift() as T) : NaN; },
  get<T>(a: T[], i: number): T | number { return i >= 0 && i < a.length ? a[i] : NaN; },
  set<T>(a: T[], i: number, x: T): void { if (i >= 0 && i < a.length) a[i] = x; },
  size(a: unknown[]): number { return a.length; },
  clear(a: unknown[]): void { a.length = 0; },
  // Out-of-range/na index is a no-op (soft-fail; JS splice(-1) would wrap from the end).
  insert<T>(a: T[], i: number, x: T): void { if (i >= 0 && i <= a.length) a.splice(i, 0, x); },
  remove<T>(a: T[], i: number): T | number { return i >= 0 && i < a.length ? (a.splice(i, 1)[0] as T) : NaN; },
  first<T>(a: T[]): T | number { return a.length ? a[0] : NaN; },
  last<T>(a: T[]): T | number { return a.length ? a[a.length - 1] : NaN; },
  reverse(a: unknown[]): void { a.reverse(); },
  includes<T>(a: T[], x: T): boolean { return a.includes(x); },
  indexof<T>(a: T[], x: T): number { return a.indexOf(x); },
  lastindexof<T>(a: T[], x: T): number { return a.lastIndexOf(x); },

  /** Index of `val` in an ascending-sorted array, or -1 if absent (midpoint search). */
  binary_search(a: number[], val: number): number {
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] === val) return mid;
      if (a[mid] < val) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  },
  /** Found: index of the first matching element; otherwise index just left of the insertion point. */
  binary_search_leftmost(a: number[], val: number): number {
    // lower_bound: first index with a[i] >= val.
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < val) lo = mid + 1; else hi = mid; }
    return lo < a.length && a[lo] === val ? lo : lo - 1;
  },
  /** Found: index of the last matching element; otherwise index just right of the insertion point. */
  binary_search_rightmost(a: number[], val: number): number {
    // upper_bound: first index with a[i] > val.
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= val) lo = mid + 1; else hi = mid; }
    return lo > 0 && a[lo - 1] === val ? lo - 1 : lo;
  },

  sum(a: number[]): number { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) : NaN; },
  avg(a: number[]): number { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; },
  /** Smallest value (nth=0), or the (nth+1)-th smallest. */
  min(a: number[], nth = 0): number {
    const v = a.filter(isNum).sort((x, y) => x - y);
    return nth >= 0 && nth < v.length ? v[nth] : NaN;
  },
  /** Greatest value (nth=0), or the (nth+1)-th greatest. */
  max(a: number[], nth = 0): number {
    const v = a.filter(isNum).sort((x, y) => y - x);
    return nth >= 0 && nth < v.length ? v[nth] : NaN;
  },

  copy<T>(a: T[]): T[] { return a.slice(); },
  slice<T>(a: T[], from = 0, to = a.length): T[] { return a.slice(Math.max(0, from), Math.max(0, to)); },
  concat<T>(a: T[], b: T[]): T[] { for (const x of b) a.push(x); return a; },
  join(a: unknown[], sep = ','): string { return a.map((x) => String(x)).join(sep); },
  // Bounds clamped to the current size (soft-fail; unclamped writes would GROW the array).
  fill<T>(a: T[], v: T, from = 0, to = a.length): void {
    const hi = Math.min(a.length, to);
    for (let i = Math.max(0, from); i < hi; i++) a[i] = v;
  },
  range(a: number[]): number { const v = a.filter(isNum); return v.length ? Math.max(...v) - Math.min(...v) : NaN; },
  sort(a: number[], order?: string): void {
    const sign = order === 'descending' ? -1 : 1;
    a.sort((x, y) => cmpElems(x, y, sign));
  },
  median(a: number[]): number {
    const v = a.filter(isNum).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  },
  mode(a: number[]): number {
    const counts = new Map<number, number>();
    for (const x of a) if (isNum(x)) counts.set(x, (counts.get(x) ?? 0) + 1);
    // Highest frequency wins; ties broken by the smallest value (per manual).
    let best = NaN, bestN = 0;
    for (const [val, c] of counts) if (c > bestN || (c === bestN && val < best)) { bestN = c; best = val; }
    return best;
  },
  /** biased=true (default): population variance (/n). biased=false: sample variance (/(n-1)). */
  variance(a: number[], biased = true): number {
    const v = a.filter(isNum);
    if (!v.length) return NaN;
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const ss = v.reduce((s, x) => s + (x - m) ** 2, 0);
    const denom = biased ? v.length : v.length - 1;
    return denom > 0 ? ss / denom : NaN;
  },
  /** biased=true (default): population stdev. biased=false: sample stdev. */
  stdev(a: number[], biased = true): number { return Math.sqrt(ArrayNs.variance(a, biased)); },
  /** biased=true (default): /n. biased=false: /(n-1). */
  covariance(a: number[], b: number[], biased = true): number {
    const len = Math.min(a.length, b.length);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < len; i++) if (isNum(a[i]) && isNum(b[i])) { xs.push(a[i]); ys.push(b[i]); }
    const n = xs.length;
    if (!n) return NaN;
    const ma = xs.reduce((s, x) => s + x, 0) / n;
    const mb = ys.reduce((s, x) => s + x, 0) / n;
    let cov = 0;
    for (let i = 0; i < n; i++) cov += (xs[i] - ma) * (ys[i] - mb);
    const denom = biased ? n : n - 1;
    return denom > 0 ? cov / denom : NaN;
  },

  /** New int array of indices that would sort the source ascending (or descending); source untouched. */
  sort_indices(a: number[], order?: string): number[] {
    const sign = order === 'descending' ? -1 : 1;
    const idx = a.map((_, i) => i);
    idx.sort((x, y) => cmpElems(a[x], a[y], sign));
    return idx;
  },
  /** New float array of standardized elements: (x - mean) / stdev. */
  standardize(a: number[]): number[] {
    const m = ArrayNs.avg(a);
    const sd = ArrayNs.stdev(a);
    return a.map((x) => (isNum(x) ? (x - m) / sd : NaN));
  },
  /** New array of absolute values; na elements stay na. */
  abs(a: number[]): number[] { return a.map((x) => (isNum(x) ? Math.abs(x) : NaN)); },
  /** Value at the given percentile via the nearest-rank method (sorted ascending).
   *  Ordinal rank n = ceil((P/100)·N), 1-indexed (the standard nearest-rank rule). */
  percentile_nearest_rank(a: number[], percentage: number): number {
    const v = a.filter(isNum).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const rank = Math.ceil((percentage / 100) * v.length);
    return v[Math.max(0, Math.min(v.length - 1, rank - 1))];
  },
  /** Value at the given percentile via linear interpolation between the two nearest ranks. */
  percentile_linear_interpolation(a: number[], percentage: number): number {
    const v = a.filter(isNum).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const pos = (percentage / 100) * (v.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  },
  /** Percentile rank of the element at `index`: the percentage of elements strictly
   *  less than the reference value, divided by (size - 1). Matches TradingView/PineTS. */
  percentrank(a: number[], index: number): number {
    const n = a.length;
    if (index < 0 || index >= n) return NaN;
    const ref = a[index];
    if (!isNum(ref)) return NaN;
    let less = 0;
    for (const x of a) if (isNum(x) && x < ref) less++;
    return n > 1 ? (less / (n - 1)) * 100 : NaN;
  },
  /** True when every element is truthy (numeric 0 is false, na/empty arrays are true). */
  every(a: unknown[]): boolean { return a.every((x) => (typeof x === 'number' ? isNum(x) && x !== 0 : !!x)); },
  /** True when at least one element is truthy (numeric 0 is false). */
  some(a: unknown[]): boolean { return a.some((x) => (typeof x === 'number' ? isNum(x) && x !== 0 : !!x)); },
};
export type ArrayNamespace = typeof ArrayNs;
