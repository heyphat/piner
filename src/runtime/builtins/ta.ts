/**
 * ta.* — stateful technical-analysis built-ins (docs/compiler-design.md §5.2).
 *
 * Each *call site* gets a unique `site` id (assigned by slot allocation) and keeps
 * independent rolling state keyed by it. All state is plain data (numbers / number
 * arrays) so `structuredClone` can snapshot/restore it for realtime rollback.
 *
 * Math here need not match TradingView to the last ULP — the cross-check oracle
 * compares the two backends (both calling this code), so determinism is what
 * matters. TradingView numeric parity is a separate (Phase 9) concern.
 */

/** Backref to the runtime context, for builtins that read OHLCV directly. */
export interface TaHost {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

const isNum = (x: number) => !Number.isNaN(x);

/** Plain-data EMA accumulator (structuredClone-safe), seeded on first value. */
const emaState = () => ({ prev: NaN, seeded: false });
const emaStep = (s: { prev: number; seeded: boolean }, x: number, len: number): number => {
  if (!isNum(x)) return s.prev;
  const k = 2 / (len + 1);
  s.prev = s.seeded ? x * k + s.prev * (1 - k) : x;
  s.seeded = true;
  return s.prev;
};

export class Ta {
  host!: TaHost;
  private state = new Map<number, any>();

  private st<T>(site: number, make: () => T): T {
    let s = this.state.get(site);
    if (s === undefined) {
      s = make();
      this.state.set(site, s);
    }
    return s as T;
  }

  // ── moving averages ───────────────────────────────────────
  sma(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[], sum: 0 }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    s.sum += src;
    while (s.buf.length > len) s.sum -= s.buf.shift()!;
    return s.buf.length < len ? NaN : s.sum / len;
  }

  ema(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ prev: NaN, seeded: false }));
    if (!isNum(src)) return s.seeded ? s.prev : NaN;
    const a = 2 / (len + 1);
    s.prev = s.seeded ? a * src + (1 - a) * s.prev : src;
    s.seeded = true;
    return s.prev;
  }

  rma(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ prev: NaN, n: 0, sum: 0 }));
    if (!isNum(src)) return s.n >= len ? s.prev : NaN;
    if (s.n < len) {
      s.sum += src;
      s.n++;
      s.prev = s.n === len ? s.sum / len : NaN;
    } else {
      s.prev = (s.prev * (len - 1) + src) / len;
    }
    return s.prev;
  }

  wma(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let num = 0;
    let den = 0;
    for (let i = 0; i < len; i++) {
      const w = i + 1;
      num += s.buf[i] * w;
      den += w;
    }
    return num / den;
  }

  // ── oscillators ───────────────────────────────────────────
  rsi(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({
      prevSrc: NaN,
      up: { prev: NaN, n: 0, sum: 0 },
      down: { prev: NaN, n: 0, sum: 0 },
    }));
    if (!isNum(src)) return NaN;
    let u = NaN;
    let d = NaN;
    if (isNum(s.prevSrc)) {
      const ch = src - s.prevSrc;
      u = Math.max(ch, 0);
      d = -Math.min(ch, 0);
    }
    s.prevSrc = src;
    const ru = this.rmaInto(s.up, u, len);
    const rd = this.rmaInto(s.down, d, len);
    if (!isNum(ru) || !isNum(rd)) return NaN;
    if (rd === 0) return 100;
    const rs = ru / rd;
    return 100 - 100 / (1 + rs);
  }

  private rmaInto(s: { prev: number; n: number; sum: number }, src: number, len: number): number {
    if (!isNum(src)) return s.n >= len ? s.prev : NaN;
    if (s.n < len) {
      s.sum += src;
      s.n++;
      s.prev = s.n === len ? s.sum / len : NaN;
    } else {
      s.prev = (s.prev * (len - 1) + src) / len;
    }
    return s.prev;
  }

  // ── ranges / volatility ───────────────────────────────────
  // Convention: value args first, `site` last. ta.tr takes an optional
  // handle_na (default false, as the bare `ta.tr` variable): with no prev
  // close the result is na unless handle_na is true (then high − low).
  tr(...args: Array<number | boolean>): number {
    const site = args[args.length - 1] as number;
    const handleNa = args.length >= 2 && args[0] === true;
    const s = this.st(site, () => ({ prevClose: NaN }));
    const { high, low, close } = this.host;
    const r = !isNum(s.prevClose)
      ? handleNa
        ? high - low
        : NaN
      : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
    s.prevClose = close;
    return r;
  }

  atr(len: number, site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, rma: { prev: NaN, n: 0, sum: 0 } }));
    const { high, low, close } = this.host;
    const tr = !isNum(s.prevClose)
      ? high - low
      : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
    s.prevClose = close;
    return this.rmaInto(s.rma, tr, len);
  }

  // ── windowed extremes ─────────────────────────────────────
  // Warmup is gated by BARS elapsed (the window holds the last `len` bars), not by the
  // count of non-na values — matching TradingView, where `ta.highest(high[1], n)` emits
  // at bar n-1 even though `high[1]` is na on bar 0. na slots stay in the window (so they
  // count toward warmup) but are skipped when taking the extreme. sma/stdev differ
  // deliberately: they require `len` valid summands before emitting.
  highest(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let m = -Infinity;
    for (const v of s.buf) if (isNum(v) && v > m) m = v;
    return m === -Infinity ? NaN : m;
  }
  lowest(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let m = Infinity;
    for (const v of s.buf) if (isNum(v) && v < m) m = v;
    return m === Infinity ? NaN : m;
  }
  /** Offset (≤0) to the highest `src` over the last `len` bars; ties → most recent. */
  highestbars(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let idx = -1;
    for (let i = 0; i < s.buf.length; i++) if (isNum(s.buf[i]) && (idx < 0 || s.buf[i] >= s.buf[idx])) idx = i;
    return idx < 0 ? NaN : idx - (len - 1);
  }
  /** Offset (≤0) to the lowest `src` over the last `len` bars; ties → most recent. */
  lowestbars(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let idx = -1;
    for (let i = 0; i < s.buf.length; i++) if (isNum(s.buf[i]) && (idx < 0 || s.buf[i] <= s.buf[idx])) idx = i;
    return idx < 0 ? NaN : idx - (len - 1);
  }
  /** Pearson correlation of `a` and `b` over the last `len` bars. */
  correlation(a: number, b: number, len: number, site: number): number {
    const s = this.st(site, () => ({ x: [] as number[], y: [] as number[] }));
    if (!isNum(a) || !isNum(b)) return NaN;
    s.x.push(a); s.y.push(b);
    while (s.x.length > len) { s.x.shift(); s.y.shift(); }
    if (s.x.length < len) return NaN;
    const mx = s.x.reduce((p, c) => p + c, 0) / len;
    const my = s.y.reduce((p, c) => p + c, 0) / len;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < len; i++) { const dx = s.x[i] - mx, dy = s.y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
    const d = Math.sqrt(vx * vy);
    return d === 0 ? NaN : cov / d;
  }
  /** Awesome Oscillator: sma(hl2, 5) − sma(hl2, 34). */
  ao(site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    const hl2 = (this.host.high + this.host.low) / 2;
    if (!isNum(hl2)) return NaN;
    s.buf.push(hl2);
    if (s.buf.length > 34) s.buf.shift();
    if (s.buf.length < 34) return NaN;
    const sma = (n: number) => { let t = 0; for (let i = s.buf.length - n; i < s.buf.length; i++) t += s.buf[i]; return t / n; };
    return sma(5) - sma(34);
  }
  /** True Strength Index: DEMA(Δsrc) / DEMA(|Δsrc|), double-EMA(long then short).
   *  Pine returns the raw ratio in [-1, 1] (callers multiply by 100 themselves). */
  tsi(src: number, shortLen: number, longLen: number, site: number): number {
    const s = this.st(site, () => ({ prev: NaN, e1: emaState(), e2: emaState(), a1: emaState(), a2: emaState() }));
    if (!isNum(src)) return NaN;
    const pc = isNum(s.prev) ? src - s.prev : NaN;
    s.prev = src;
    if (!isNum(pc)) return NaN;
    const num = emaStep(s.e2, emaStep(s.e1, pc, longLen), shortLen);
    const den = emaStep(s.a2, emaStep(s.a1, Math.abs(pc), longLen), shortLen);
    return den === 0 ? NaN : num / den;
  }

  // ── statistics ────────────────────────────────────────────
  stdev(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const mean = s.buf.reduce((a: number, b: number) => a + b, 0) / len;
    const variance = s.buf.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / len;
    return Math.sqrt(variance);
  }
  dev(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const mean = s.buf.reduce((a: number, b: number) => a + b, 0) / len;
    return s.buf.reduce((a: number, b: number) => a + Math.abs(b - mean), 0) / len;
  }

  // ── change / momentum ─────────────────────────────────────
  /** src - src[len]: BAR-indexed offset (na occupies its slot; na endpoints → na). */
  change(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN);
    // keep the last len+1 bars; the oldest is src[len]
    while (s.buf.length > len + 1) s.buf.shift();
    if (s.buf.length < len + 1) return NaN;
    const past = s.buf[0];
    return isNum(src) && isNum(past) ? src - past : NaN;
  }

  // ── crosses ───────────────────────────────────────────────
  private prevPair(site: number) {
    return this.st(site, () => ({ a: NaN, b: NaN }));
  }
  crossover(a: number, b: number, site: number): boolean {
    const s = this.prevPair(site);
    const res = isNum(s.a) && isNum(s.b) && s.a <= s.b && a > b;
    s.a = a;
    s.b = b;
    return res;
  }
  crossunder(a: number, b: number, site: number): boolean {
    const s = this.prevPair(site);
    const res = isNum(s.a) && isNum(s.b) && s.a >= s.b && a < b;
    s.a = a;
    s.b = b;
    return res;
  }
  cross(a: number, b: number, site: number): boolean {
    const s = this.prevPair(site);
    const res = isNum(s.a) && isNum(s.b) && ((s.a <= s.b && a > b) || (s.a >= s.b && a < b));
    s.a = a;
    s.b = b;
    return res;
  }

  // ── accumulators ──────────────────────────────────────────
  /** All-time high of `src` from the first bar to the current bar. */
  max(src: number, site: number): number {
    const s = this.st(site, () => ({ v: NaN }));
    if (isNum(src)) s.v = isNum(s.v) ? Math.max(s.v, src) : src;
    return s.v;
  }
  /** All-time low of `src` from the first bar to the current bar. */
  min(src: number, site: number): number {
    const s = this.st(site, () => ({ v: NaN }));
    if (isNum(src)) s.v = isNum(s.v) ? Math.min(s.v, src) : src;
    return s.v;
  }
  cum(src: number, site: number): number {
    const s = this.st(site, () => ({ sum: 0 }));
    if (isNum(src)) s.sum += src;
    return s.sum;
  }
  barssince(cond: boolean, site: number): number {
    const s = this.st(site, () => ({ count: NaN as number }));
    s.count = cond ? 0 : isNum(s.count) ? s.count + 1 : NaN;
    return s.count;
  }
  /** Source value the `occurrence`-th most recent time `cond` was true (0 = latest). */
  valuewhen(cond: boolean, src: number, occurrence: number, site: number): number {
    const s = this.st(site, () => ({ hist: [] as number[] }));
    if (cond) s.hist.push(src);
    if (s.hist.length > 5000) s.hist.shift(); // bound rollback-snapshot growth
    const k = Math.trunc(occurrence);
    const idx = s.hist.length - 1 - k;
    return idx >= 0 ? s.hist[idx] : NaN;
  }

  // ── momentum / rate-of-change ─────────────────────────────
  mom(src: number, len: number, site: number): number {
    return this.change(src, len, site); // src - src[len]
  }
  roc(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(isNum(src) ? src : NaN); // bar-indexed, like change
    while (s.buf.length > len + 1) s.buf.shift();
    if (s.buf.length < len + 1) return NaN;
    const past = s.buf[0];
    if (!isNum(src) || !isNum(past) || past === 0) return NaN;
    return (100 * (src - past)) / past;
  }
  rising(src: number, len: number, site: number): boolean {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    while (s.buf.length > len + 1) s.buf.shift();
    if (s.buf.length < len + 1) return false;
    for (let i = 1; i < s.buf.length; i++) if (!(s.buf[i] > s.buf[i - 1])) return false;
    return true;
  }
  falling(src: number, len: number, site: number): boolean {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    while (s.buf.length > len + 1) s.buf.shift();
    if (s.buf.length < len + 1) return false;
    for (let i = 1; i < s.buf.length; i++) if (!(s.buf[i] < s.buf[i - 1])) return false;
    return true;
  }

  // ── statistics ────────────────────────────────────────────
  variance(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const mean = s.buf.reduce((a: number, b: number) => a + b, 0) / len;
    return s.buf.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / len;
  }
  median(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const sorted = s.buf.slice().sort((a: number, b: number) => a - b);
    const mid = Math.floor(len / 2);
    return len % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  percentrank(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    while (s.buf.length > len + 1) s.buf.shift();
    if (s.buf.length < len + 1 || !isNum(src)) return NaN;
    let count = 0;
    for (let i = 0; i < s.buf.length - 1; i++) if (s.buf[i] <= src) count++;
    return (count / len) * 100;
  }

  // ── weighted / regression MAs ─────────────────────────────
  /** Symmetric weighted MA, fixed 4-bar weights [1,2,2,1]/6. */
  swma(src: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    if (s.buf.length > 4) s.buf.shift();
    if (s.buf.length < 4) return NaN;
    return (s.buf[0] * 1 + s.buf[1] * 2 + s.buf[2] * 2 + s.buf[3] * 1) / 6;
  }
  linreg(src: number, len: number, offset: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    // least-squares line over the window; x = 0..len-1 (oldest..newest)
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < len; i++) { sx += i; sy += s.buf[i]; sxx += i * i; sxy += i * s.buf[i]; }
    const denom = len * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (len * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / len;
    // value at the most recent bar shifted by `offset`
    return intercept + slope * (len - 1 - offset);
  }
  vwma(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ pv: { buf: [] as number[], sum: 0 }, v: { buf: [] as number[], sum: 0 } }));
    const vol = this.host.volume;
    if (!isNum(src) || !isNum(vol)) return NaN;
    const pv = this.smaInto(s.pv, src * vol, len);
    const v = this.smaInto(s.v, vol, len);
    return isNum(pv) && isNum(v) && v !== 0 ? pv / v : NaN;
  }
  private smaInto(s: { buf: number[]; sum: number }, src: number, len: number): number {
    s.buf.push(src);
    s.sum += src;
    while (s.buf.length > len) s.sum -= s.buf.shift()!;
    return s.buf.length < len ? NaN : s.sum / len;
  }
  private emaInto(s: { prev: number; seeded: boolean }, src: number, len: number): number {
    if (!isNum(src)) return s.seeded ? s.prev : NaN;
    const a = 2 / (len + 1);
    s.prev = s.seeded ? a * src + (1 - a) * s.prev : src;
    s.seeded = true;
    return s.prev;
  }

  // ── oscillators returning tuples ──────────────────────────
  /** ta.macd → [macdLine, signalLine, histogram]. */
  macd(src: number, fast: number, slow: number, signal: number, site: number): number[] {
    const s = this.st(site, () => ({
      f: { prev: NaN, seeded: false }, s: { prev: NaN, seeded: false }, sig: { prev: NaN, seeded: false },
    }));
    const ef = this.emaInto(s.f, src, fast);
    const es = this.emaInto(s.s, src, slow);
    const macdLine = ef - es;
    const sigLine = this.emaInto(s.sig, macdLine, signal);
    return [macdLine, sigLine, macdLine - sigLine];
  }
  /** ta.bb → [basis, upper, lower]. */
  bb(src: number, len: number, mult: number, site: number): number[] {
    const s = this.st(site, () => ({ sma: { buf: [] as number[], sum: 0 }, dev: { buf: [] as number[] } }));
    if (!isNum(src)) return [NaN, NaN, NaN]; // skip na inputs like sma (else s.sma.sum poisons)
    const basis = this.smaInto(s.sma, src, len);
    s.dev.buf.push(src);
    while (s.dev.buf.length > len) s.dev.buf.shift();
    let sd = NaN;
    if (s.dev.buf.length === len) {
      const mean = s.dev.buf.reduce((a: number, b: number) => a + b, 0) / len;
      sd = Math.sqrt(s.dev.buf.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / len);
    }
    return [basis, basis + mult * sd, basis - mult * sd];
  }
  /** ta.stoch(src, highSrc, lowSrc, len) → %K. */
  stoch(src: number, highSrc: number, lowSrc: number, len: number, site: number): number {
    const s = this.st(site, () => ({ hi: [] as number[], lo: [] as number[] }));
    s.hi.push(highSrc);
    s.lo.push(lowSrc);
    while (s.hi.length > len) { s.hi.shift(); s.lo.shift(); }
    if (s.hi.length < len) return NaN;
    const hh = Math.max(...s.hi);
    const ll = Math.min(...s.lo);
    return hh === ll ? NaN : (100 * (src - ll)) / (hh - ll);
  }

  private wmaInto(s: { buf: number[] }, src: number, len: number): number {
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let num = 0, den = 0;
    for (let i = 0; i < len; i++) { const w = i + 1; num += s.buf[i] * w; den += w; }
    return num / den;
  }

  // ── more moving averages / oscillators ────────────────────
  hma(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ half: { buf: [] as number[] }, full: { buf: [] as number[] }, sq: { buf: [] as number[] } }));
    const half = this.wmaInto(s.half, src, Math.floor(len / 2));
    const full = this.wmaInto(s.full, src, len);
    return this.wmaInto(s.sq, 2 * half - full, Math.round(Math.sqrt(len)));
  }
  cog(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let num = 0, den = 0;
    for (let j = 0; j < len; j++) { const w = len - j; num += s.buf[j] * w; den += s.buf[j]; }
    return den === 0 ? NaN : -num / den;
  }
  cmo(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ prev: NaN, buf: [] as number[] }));
    const ch = isNum(s.prev) && isNum(src) ? src - s.prev : NaN; // first bar: na (Pine warmup)
    s.prev = src;
    if (!isNum(ch)) return NaN;
    s.buf.push(ch);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    let up = 0, dn = 0;
    for (const d of s.buf) { if (d > 0) up += d; else dn += -d; }
    return up + dn === 0 ? 0 : (100 * (up - dn)) / (up + dn);
  }
  bbw(src: number, len: number, mult: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const mean = s.buf.reduce((a, b) => a + b, 0) / len;
    const sd = Math.sqrt(s.buf.reduce((a, b) => a + (b - mean) ** 2, 0) / len);
    return mean === 0 ? NaN : (2 * mult * sd) / mean;
  }
  cci(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const mean = s.buf.reduce((a, b) => a + b, 0) / len;
    const md = s.buf.reduce((a, b) => a + Math.abs(b - mean), 0) / len;
    return md === 0 ? 0 : (src - mean) / (0.015 * md);
  }
  // ── price-channel / volume oscillators (read host OHLCV) ──
  wpr(len: number, site: number): number {
    const s = this.st(site, () => ({ hi: [] as number[], lo: [] as number[] }));
    const { high, low, close } = this.host;
    s.hi.push(high); s.lo.push(low);
    while (s.hi.length > len) { s.hi.shift(); s.lo.shift(); }
    if (s.hi.length < len) return NaN;
    const hh = Math.max(...s.hi), ll = Math.min(...s.lo);
    return hh === ll ? NaN : (-100 * (hh - close)) / (hh - ll);
  }
  mfi(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ prev: NaN, pos: [] as number[], neg: [] as number[] }));
    const vol = this.host.volume;
    const rmf = src * vol;
    const valid = isNum(s.prev) && isNum(src) && isNum(vol); // first bar: na change → na (Pine warmup)
    const p = valid ? (src > s.prev ? rmf : 0) : NaN;
    const n = valid ? (src < s.prev ? rmf : 0) : NaN;
    s.prev = src;
    if (!valid) return NaN;
    s.pos.push(p); s.neg.push(n);
    while (s.pos.length > len) { s.pos.shift(); s.neg.shift(); }
    if (s.pos.length < len) return NaN;
    const sp = s.pos.reduce((a, b) => a + b, 0), sn = s.neg.reduce((a, b) => a + b, 0);
    return sn === 0 ? 100 : 100 - 100 / (1 + sp / sn);
  }
  /**
   * Volume-weighted average price. Two forms (the trailing arg is always the
   * state `site`, appended by the caller):
   *   - `ta.vwap(source)` → float, anchored to the session (resets each new UTC day).
   *   - `ta.vwap(source, anchor)` → float, a truthy `anchor` restarts the accumulation.
   *   - `ta.vwap(source, anchor, stdev_mult)` → `[vwap, upper, lower]`, anchored as
   *     above, with bands `stdev_mult` volume-weighted standard deviations either
   *     side of the VWAP.
   */
  vwap(src: number, ...rest: Array<number | boolean>): number | number[] {
    const site = rest[rest.length - 1] as number;
    const anchored = rest.length >= 2; // (anchor, site) or (anchor, stdev_mult, site)
    const banded = rest.length === 3; // (anchor, stdev_mult, site)
    const s = this.st(site, () => ({ pv: 0, v: 0, sv2: 0, day: NaN }));

    let reset: boolean;
    if (anchored) {
      reset = rest[0] === true || (typeof rest[0] === 'number' && rest[0] !== 0 && isNum(rest[0]));
    } else {
      const day = Math.floor(this.host.time / 86400000);
      reset = day !== s.day;
      s.day = day;
    }
    if (reset) { s.pv = 0; s.v = 0; s.sv2 = 0; }

    const vol = this.host.volume;
    if (isNum(src) && isNum(vol)) { s.pv += src * vol; s.v += vol; s.sv2 += src * src * vol; }
    const vwap = s.v === 0 ? NaN : s.pv / s.v;
    if (!banded) return vwap;

    const variance = s.v === 0 ? NaN : Math.max(0, s.sv2 / s.v - vwap * vwap);
    const stdev = Math.sqrt(variance);
    const mult = rest[1] as number;
    const band = isNum(stdev) && isNum(mult) ? stdev * mult : NaN;
    return [vwap, vwap + band, vwap - band];
  }
  // ── pivots (confirmed `right` bars later; na otherwise) ───
  pivothigh(src: number, left: number, right: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    const win = left + right + 1;
    while (s.buf.length > win) s.buf.shift();
    if (s.buf.length < win) return NaN;
    const center = s.buf[left];
    for (let i = 0; i < win; i++) if (i !== left && s.buf[i] >= center) return NaN;
    return center;
  }
  pivotlow(src: number, left: number, right: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    s.buf.push(src);
    const win = left + right + 1;
    while (s.buf.length > win) s.buf.shift();
    if (s.buf.length < win) return NaN;
    const center = s.buf[left];
    for (let i = 0; i < win; i++) if (i !== left && s.buf[i] <= center) return NaN;
    return center;
  }
  // ── tuple-returning channel/trend indicators ──────────────
  kc(src: number, len: number, mult: number, site: number): number[] {
    const s = this.st(site, () => ({ ema: { prev: NaN, seeded: false }, prevClose: NaN, range: { prev: NaN, seeded: false } }));
    const { high, low, close } = this.host;
    const mid = this.emaInto(s.ema, src, len);
    const tr = !isNum(s.prevClose) ? high - low : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
    s.prevClose = close;
    const span = this.emaInto(s.range, tr, len); // Pine: EMA of true range, not RMA
    return [mid, mid + mult * span, mid - mult * span];
  }
  kcw(src: number, len: number, mult: number, site: number): number {
    const [mid, up, lo] = this.kc(src, len, mult, site);
    return mid === 0 ? NaN : (up - lo) / mid;
  }
  supertrend(factor: number, atrLen: number, site: number): number[] {
    const s = this.st(site, () => ({ atr: { prevClose: NaN, rma: { prev: NaN, n: 0, sum: 0 } }, up: NaN, dn: NaN, dir: 1, prevClose: NaN }));
    const { high, low, close } = this.host;
    const hl2 = (high + low) / 2;
    const tr = !isNum(s.atr.prevClose) ? high - low : Math.max(high - low, Math.abs(high - s.atr.prevClose), Math.abs(low - s.atr.prevClose));
    s.atr.prevClose = close;
    const atr = this.rmaInto(s.atr.rma, tr, atrLen);
    // up = lowerBand, dn = upperBand (sticky, ratcheted against the prior bar).
    let up = hl2 - factor * atr, dn = hl2 + factor * atr;
    if (isNum(s.up) && isNum(s.prevClose)) up = s.prevClose > s.up ? Math.max(up, s.up) : up;
    if (isNum(s.dn) && isNum(s.prevClose)) dn = s.prevClose < s.dn ? Math.min(dn, s.dn) : dn;
    // Direction follows TradingView's sign convention: -1 = uptrend (trail = lowerBand,
    // below price), +1 = downtrend (trail = upperBand, above price). A downtrend flips to
    // up once close breaks above the upper band; an uptrend flips down once close breaks
    // below the lower band. Compare against the current sticky bands, as TV does.
    let dir = s.dir; // seeded to +1 (downtrend) for the first bars, matching TV
    if (!isNum(atr)) { /* keep */ } else if (s.dir === 1) dir = close > dn ? -1 : 1;
    else dir = close < up ? 1 : -1;
    s.up = up; s.dn = dn; s.dir = dir; s.prevClose = close;
    return [dir === -1 ? up : dn, dir];
  }
  dmi(diLen: number, adxLen: number, site: number): number[] {
    const s = this.st(site, () => ({ ph: NaN, pl: NaN, pc: NaN, tr: { prev: NaN, n: 0, sum: 0 }, p: { prev: NaN, n: 0, sum: 0 }, m: { prev: NaN, n: 0, sum: 0 }, adx: { prev: NaN, n: 0, sum: 0 } }));
    const { high, low, close } = this.host;
    let plusDM = 0, minusDM = 0, tr = high - low;
    if (isNum(s.ph)) {
      const upMove = high - s.ph, downMove = s.pl - low;
      plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
      tr = Math.max(high - low, Math.abs(high - s.pc), Math.abs(low - s.pc));
    }
    s.ph = high; s.pl = low; s.pc = close;
    const atr = this.rmaInto(s.tr, tr, diLen);
    const sp = this.rmaInto(s.p, plusDM, diLen);
    const sm = this.rmaInto(s.m, minusDM, diLen);
    const plusDI = atr === 0 ? 0 : (100 * sp) / atr;
    const minusDI = atr === 0 ? 0 : (100 * sm) / atr;
    const dx = plusDI + minusDI === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI);
    const adx = this.rmaInto(s.adx, dx, adxLen);
    return [plusDI, minusDI, adx];
  }
  /**
   * TradingView/ta library: requestUpAndDownVolume(lowerTimeframe) → [up, down, delta].
   * The library sums (close>open?volume:0) and (close<open?volume:0) over each intrabar of a
   * lower timeframe. piner has no intrabar data (request.security_lower_tf is a stub), so this
   * is the single-bar degenerate: classify the whole bar's volume by candle direction. Down
   * volume is returned NEGATIVE, matching the library (callers take math.abs). lowerTimeframe
   * is accepted for signature compatibility but unused without intrabar data.
   */
  requestUpAndDownVolume(_lowerTimeframe: unknown, _site: number): number[] {
    const { open, close, volume } = this.host;
    const vol = isNum(volume) ? volume : 0;
    const up = close > open ? vol : 0;
    const down = close < open ? -vol : 0;
    return [up, down, up + down];
  }

  /** Rolling sum over `len` bars (also backs math.sum). */
  sum(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[], sum: 0 }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    s.sum += src;
    while (s.buf.length > len) s.sum -= s.buf.shift()!;
    return s.buf.length < len ? NaN : s.sum;
  }
  alma(src: number, len: number, offset: number, sigma: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    const m = offset * (len - 1);
    const sd = len / sigma;
    let norm = 0, sum = 0;
    for (let i = 0; i < len; i++) { const w = Math.exp(-((i - m) ** 2) / (2 * sd * sd)); norm += w; sum += s.buf[i] * w; }
    return norm === 0 ? NaN : sum / norm;
  }
  /** Parabolic SAR. */
  /**
   * Parabolic SAR — a faithful port of the documented `pine_sar` reference
   * (na on bar 0, trend initialized on bar 1 from close vs close[1], 2-bar
   * lookback clamp). `isBelow` = SAR is below price = uptrend.
   */
  sar(start: number, inc: number, max: number, site: number): number {
    const s = this.st(site, () => ({
      result: NaN, maxMin: NaN, accel: NaN, isBelow: false, bar: -1,
      h1: NaN, h2: NaN, l1: NaN, l2: NaN, c1: NaN,
    }));
    const { high, low, close } = this.host;
    s.bar++;
    const bar = s.bar;
    let firstTrend = false;
    if (bar === 1) {
      if (close > s.c1) { s.isBelow = true; s.maxMin = high; s.result = s.l1; }
      else { s.isBelow = false; s.maxMin = low; s.result = s.h1; }
      firstTrend = true;
      s.accel = start;
    }
    if (bar >= 1) {
      s.result = s.result + s.accel * (s.maxMin - s.result);
      if (s.isBelow) {
        if (s.result > low) { firstTrend = true; s.isBelow = false; s.result = Math.max(high, s.maxMin); s.maxMin = low; s.accel = start; }
      } else if (s.result < high) {
        firstTrend = true; s.isBelow = true; s.result = Math.min(low, s.maxMin); s.maxMin = high; s.accel = start;
      }
      if (!firstTrend) {
        if (s.isBelow) { if (high > s.maxMin) { s.maxMin = high; s.accel = Math.min(s.accel + inc, max); } }
        else if (low < s.maxMin) { s.maxMin = low; s.accel = Math.min(s.accel + inc, max); }
      }
      if (s.isBelow) {
        s.result = Math.min(s.result, s.l1);
        if (bar > 1) s.result = Math.min(s.result, s.l2);
      } else {
        s.result = Math.max(s.result, s.h1);
        if (bar > 1) s.result = Math.max(s.result, s.h2);
      }
    }
    const out = bar < 1 ? NaN : s.result;
    s.h2 = s.h1; s.l2 = s.l1; s.h1 = high; s.l1 = low; s.c1 = close;
    return out;
  }

  // ── volume / accumulation indicators (read host OHLCV) ────
  /** On-Balance Volume (cumulative): ta.cum(sign(change(close)) * volume).
   *  First bar (no prior close) seeds 0. */
  obv(site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, sum: 0 }));
    const { close, volume } = this.host;
    if (!isNum(s.prevClose)) {
      s.prevClose = close;
      return 0;
    }
    if (close > s.prevClose) s.sum += volume;
    else if (close < s.prevClose) s.sum -= volume;
    s.prevClose = close;
    return s.sum;
  }
  /** Accumulation/Distribution: cumulative Σ clv*volume,
   *  clv = ((close−low)−(high−close))/(high−low), 0 when high==low.
   *  na inputs carry the running total forward unchanged. */
  accdist(site: number): number {
    const s = this.st(site, () => ({ sum: 0 }));
    const { high, low, close, volume } = this.host;
    if (!isNum(close) || !isNum(high) || !isNum(low) || !isNum(volume)) return s.sum;
    const range = high - low;
    if (range !== 0) s.sum += ((close - low - (high - close)) / range) * volume;
    return s.sum;
  }
  /** Intraday Intensity Index (per-bar): (2*close−high−low)/((high−low)*volume).
   *  0 when the denominator is 0; na when any input is na. */
  iii(_site: number): number {
    const { high, low, close, volume } = this.host;
    if (!isNum(close) || !isNum(high) || !isNum(low) || !isNum(volume)) return NaN;
    const denom = (high - low) * volume;
    if (denom === 0) return 0;
    return (2 * close - high - low) / denom;
  }
  /** Williams Variable Accumulation/Distribution (per-bar):
   *  (close−open)/(high−low)*volume. 0 when high==low; na when any input na. */
  wvad(_site: number): number {
    const { open, high, low, close, volume } = this.host;
    if (!isNum(close) || !isNum(open) || !isNum(high) || !isNum(low) || !isNum(volume)) return NaN;
    const range = high - low;
    if (range === 0) return 0;
    return ((close - open) / range) * volume;
  }
  /** Williams Accumulation/Distribution (cumulative).
   *  trueHigh=max(high,close[1]); trueLow=min(low,close[1]); mom=change(close);
   *  gain = mom>0 ? close−trueLow : mom<0 ? close−trueHigh : 0; wad = Σ gain.
   *  na close/high/low carry the running total forward unchanged. */
  wad(site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, sum: 0 }));
    const { high, low, close } = this.host;
    if (!isNum(close) || !isNum(high) || !isNum(low)) return s.sum;
    let gain = 0;
    if (isNum(s.prevClose)) {
      const trueHigh = Math.max(high, s.prevClose);
      const trueLow = Math.min(low, s.prevClose);
      const mom = close - s.prevClose;
      if (mom > 0) gain = close - trueLow;
      else if (mom < 0) gain = close - trueHigh;
    }
    s.sum += gain;
    s.prevClose = close;
    return s.sum;
  }
  /** Negative Volume Index. Seeds at 1; updates only when volume < volume[1].
   *  When current or prior close is 0/na the index is carried forward. */
  nvi(site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, prevVol: NaN, nvi: 1 }));
    const { close, volume } = this.host;
    const c = isNum(close) ? close : 0;
    const pc = isNum(s.prevClose) ? s.prevClose : 0;
    const v = isNum(volume) ? volume : 0;
    const pv = isNum(s.prevVol) ? s.prevVol : 0;
    if (!(c === 0 || pc === 0) && v < pv) s.nvi += ((c - pc) / pc) * s.nvi;
    s.prevClose = close;
    s.prevVol = volume;
    return s.nvi;
  }
  /** Positive Volume Index. Seeds at 1; updates only when volume > volume[1].
   *  When current or prior close is 0/na the index is carried forward. */
  pvi(site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, prevVol: NaN, pvi: 1 }));
    const { close, volume } = this.host;
    const c = isNum(close) ? close : 0;
    const pc = isNum(s.prevClose) ? s.prevClose : 0;
    const v = isNum(volume) ? volume : 0;
    const pv = isNum(s.prevVol) ? s.prevVol : 0;
    if (!(c === 0 || pc === 0) && v > pv) s.pvi += ((c - pc) / pc) * s.pvi;
    s.prevClose = close;
    s.prevVol = volume;
    return s.pvi;
  }
  /** Price Volume Trend (cumulative): Σ ((close − close[1]) / close[1]) * volume.
   *  First bar (no prior close) seeds 0; na/zero prior close carries forward. */
  pvt(site: number): number {
    const s = this.st(site, () => ({ prevClose: NaN, sum: 0 }));
    const { close, volume } = this.host;
    if (isNum(s.prevClose) && s.prevClose !== 0 && isNum(close) && isNum(volume)) {
      s.sum += ((close - s.prevClose) / s.prevClose) * volume;
    }
    s.prevClose = close;
    return s.sum;
  }
  /** ta.range(source, length): highest(src,len) − lowest(src,len). */
  range(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    return Math.max(...s.buf) - Math.min(...s.buf);
  }
  /** ta.percentile_nearest_rank(source, length, percentage): nearest-rank
   *  percentile over the last `len` bars. na values are ignored. */
  percentile_nearest_rank(src: number, len: number, percentage: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[], seen: 0 }));
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    s.seen++;
    if (s.seen < len) return NaN;
    const vals = s.buf.filter(isNum);
    if (vals.length === 0) return NaN;
    vals.sort((a, b) => a - b);
    let c = Math.ceil((percentage / 100) * vals.length) - 1;
    if (c < 0) c = 0;
    if (c >= vals.length) c = vals.length - 1;
    return vals[c];
  }
  /** ta.percentile_linear_interpolation(source, length, percentage): percentile
   *  via linear interpolation between adjacent ranks over the last `len` bars.
   *  na values are included → an na result. */
  percentile_linear_interpolation(src: number, len: number, percentage: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[], seen: 0 }));
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    s.seen++;
    if (s.seen < len) return NaN;
    for (const v of s.buf) if (!isNum(v)) return NaN;
    const vals = s.buf.slice().sort((a, b) => a - b);
    let c = (percentage / 100) * len - 0.5;
    if (c < 0) c = 0;
    if (c > len - 1) c = len - 1;
    const u = Math.floor(c);
    const p = Math.ceil(c);
    if (u === p) return vals[u];
    return vals[u] + (c - u) * (vals[p] - vals[u]);
  }

  /** ta.rci(source, length): Rank Correlation Index — Spearman's rank
   *  correlation between `source` and the bar order over the last `len`
   *  bars, scaled to [-100, 100]. The most recent bar is the highest
   *  time rank; +100 ⇒ source rose monotonically over the window, −100 ⇒
   *  it fell monotonically. Ties use average ranks (Pearson-on-ranks). */
  rci(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (!isNum(src)) return NaN;
    s.buf.push(src);
    while (s.buf.length > len) s.buf.shift();
    if (s.buf.length < len) return NaN;
    if (len < 2) return NaN;
    // Time rank: oldest = 1 … newest = len (buf is push-ordered, oldest first).
    // Price rank: average rank of each value within the window (1 = smallest).
    const n = len;
    const idx = s.buf.map((_, i) => i);
    idx.sort((a, b) => s.buf[a] - s.buf[b]);
    const priceRank = new Array<number>(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && s.buf[idx[j + 1]] === s.buf[idx[i]]) j++;
      const avg = (i + j) / 2 + 1; // ranks 1..n, average over the tie block
      for (let k = i; k <= j; k++) priceRank[idx[k]] = avg;
      i = j + 1;
    }
    // Pearson correlation between time rank (i+1) and price rank.
    const mean = (n + 1) / 2; // mean of 1..n for both rank sets
    let sxy = 0, sxx = 0, syy = 0;
    for (let t = 0; t < n; t++) {
      const dt = t + 1 - mean;
      const dp = priceRank[t] - mean;
      sxy += dt * dp;
      sxx += dt * dt;
      syy += dp * dp;
    }
    const den = Math.sqrt(sxx * syy);
    if (den === 0) return 0;
    return (sxy / den) * 100;
  }

  /** ta.mode(source, length): most frequent value over the last `len`
   *  non-na values. Ties resolve to the smallest value. na inputs are
   *  ignored; the window holds `len` non-na observations. */
  mode(src: number, len: number, site: number): number {
    const s = this.st(site, () => ({ buf: [] as number[] }));
    if (isNum(src)) {
      s.buf.push(src);
      while (s.buf.length > len) s.buf.shift();
    }
    if (s.buf.length < len) return NaN;
    const counts = new Map<number, number>();
    for (const x of s.buf) counts.set(x, (counts.get(x) ?? 0) + 1);
    let best = NaN, bestN = 0;
    for (const [val, c] of counts) {
      if (c > bestN || (c === bestN && val < best)) { bestN = c; best = val; }
    }
    return best;
  }

  /** ta.pivot_point_levels(type, anchor, developing=false): array<float> of
   *  11 levels [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5]. Levels absent
   *  from a type are na (e.g. "DM" yields only P, R1, S1). The anchor
   *  period's open/high/low/close accumulate across bars and reset when
   *  `anchor` is true; non-developing levels use the *previous* completed
   *  period's OHLC, so a value is published only once a period has closed. */
  pivot_point_levels(type: string, anchor: boolean, ...rest: number[]): number[] {
    // Optional `developing` arg precedes the trailing `site`; handle both arities.
    const site = rest[rest.length - 1] ?? 0;
    const developing = rest.length >= 2 ? Boolean(rest[0]) : false;
    const s = this.st(site, () => ({
      // current (developing) period accumulator
      o: NaN, h: NaN, l: NaN, c: NaN, started: false,
      // last completed period's OHLC (used by non-developing levels)
      po: NaN, ph: NaN, pl: NaN, pc: NaN, havePrev: false,
    }));
    const { open, high, low, close } = this.host;
    if (anchor) {
      // Close the current period → it becomes the "previous" period.
      if (s.started) {
        s.po = s.o; s.ph = s.h; s.pl = s.l; s.pc = s.c; s.havePrev = true;
      }
      // Begin a fresh period from this bar.
      s.o = open; s.h = high; s.l = low; s.c = close; s.started = true;
    } else if (s.started) {
      s.h = Math.max(s.h, high);
      s.l = Math.min(s.l, low);
      s.c = close;
    }

    const NA = NaN;
    const out = [NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA]; // P,R1,S1,R2,S2,R3,S3,R4,S4,R5,S5

    // Pick the source OHLC: developing uses the in-progress period, otherwise
    // the previous completed period.
    let O: number, H: number, L: number, C: number;
    if (developing) {
      if (type === 'Woodie') return out; // Woodie cannot develop (manual)
      if (!s.started) return out;
      O = s.o; H = s.h; L = s.l; C = s.c;
    } else {
      if (!s.havePrev) return out;
      O = s.po; H = s.ph; L = s.pl; C = s.pc;
    }

    const range = H - L;
    switch (type) {
      case 'Traditional': {
        const P = (H + L + C) / 3;
        out[0] = P;
        out[1] = P * 2 - L;       // R1
        out[2] = P * 2 - H;       // S1
        out[3] = P + range;       // R2
        out[4] = P - range;       // S2
        out[5] = H + 2 * (P - L); // R3
        out[6] = L - 2 * (H - P); // S3
        out[7] = H + 3 * (P - L); // R4
        out[8] = L - 3 * (H - P); // S4
        out[9] = H + 4 * (P - L); // R5
        out[10] = L - 4 * (H - P); // S5
        break;
      }
      case 'Fibonacci': {
        const P = (H + L + C) / 3;
        out[0] = P;
        out[1] = P + 0.382 * range; // R1
        out[2] = P - 0.382 * range; // S1
        out[3] = P + 0.618 * range; // R2
        out[4] = P - 0.618 * range; // S2
        out[5] = P + range;         // R3
        out[6] = P - range;         // S3
        break;
      }
      case 'Woodie': {
        // Woodie PP anchors on the CURRENT period's open: (H_prev + L_prev + 2*O_cur)/4.
        const P = (H + L + 2 * s.o) / 4;
        out[0] = P;
        out[1] = P * 2 - L;             // R1
        out[2] = P * 2 - H;             // S1
        out[3] = P + range;             // R2
        out[4] = P - range;             // S2
        out[5] = H + 2 * (P - L);       // R3
        out[6] = L - 2 * (H - P);       // S3
        out[7] = out[5] + range;        // R4
        out[8] = out[6] - range;        // S4
        break;
      }
      case 'Classic': {
        const P = (H + L + C) / 3;
        out[0] = P;
        out[1] = P * 2 - L;       // R1
        out[2] = P * 2 - H;       // S1
        out[3] = P + range;       // R2
        out[4] = P - range;       // S2
        out[5] = P + 2 * range;   // R3
        out[6] = P - 2 * range;   // S3
        out[7] = P + 3 * range;   // R4
        out[8] = P - 3 * range;   // S4
        break;
      }
      case 'DM': {
        let X: number;
        if (C < O) X = H + 2 * L + C;
        else if (C > O) X = 2 * H + L + C;
        else X = H + L + 2 * C;
        const P = X / 4;
        out[0] = P;
        out[1] = X / 2 - L; // R1
        out[2] = X / 2 - H; // S1
        break;
      }
      case 'Camarilla': {
        const P = (H + L + C) / 3;
        out[0] = P;
        out[1] = C + range * 1.1 / 12;  // R1
        out[2] = C - range * 1.1 / 12;  // S1
        out[3] = C + range * 1.1 / 6;   // R2
        out[4] = C - range * 1.1 / 6;   // S2
        out[5] = C + range * 1.1 / 4;   // R3
        out[6] = C - range * 1.1 / 4;   // S3
        out[7] = C + range * 1.1 / 2;   // R4
        out[8] = C - range * 1.1 / 2;   // S4
        break;
      }
      default:
        return out;
    }
    return out;
  }

  // ── snapshot / restore for realtime rollback ──────────────
  snapshot(): Map<number, unknown> {
    return structuredClone(this.state);
  }
  restore(snap: Map<number, unknown>): void {
    this.state = structuredClone(snap) as Map<number, any>;
  }
}
