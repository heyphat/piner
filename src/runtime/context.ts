/**
 * ExecutionContext — the `$` object every compiled script (codegen output OR the
 * interpreter) calls into. See docs/compiler-design.md §6. All na-propagating
 * operators and stateful builtins funnel through here so the two backends share
 * semantics by construction.
 */

import { SeriesStore, NA, isNa } from './series.js';
import { Ta } from './builtins/ta.js';
import { OutputCollector } from './output.js';
import { MathNs } from './builtins/math.js';
import { ColorNs } from './builtins/color.js';
import { StrNs } from './builtins/str.js';
import { ArrayNs } from './builtins/array.js';
import { MapNs } from './builtins/map.js';
import { MatrixNs, type Matrix } from './builtins/matrix.js';
import {
  DrawingPool,
  makeLineNs,
  makeLabelNs,
  makeBoxNs,
  makeTableNs,
  makeLinefillNs,
  makePolylineNs,
  type DrawObject,
} from './builtins/drawing.js';
import { resampleToTimeframe, bucketKey, type BaseBar, type HtfBar } from './builtins/request.js';
import { StrategyBroker, makeStrategyNs, type StrategySettings } from './builtins/strategy.js';
import { historicalBarState } from './barstate.js';
import {
  PlotNs,
  ShapeNs,
  LocationNs,
  HlineNs,
  DisplayNs,
  PositionNs,
  SizeNs,
  XlocNs,
  ExtendNs,
  FormatNs,
  FontNs,
  TextNs,
  CurrencyNs,
  BarmergeNs,
  SessionNs,
  ScaleNs,
  OrderNs,
  YlocNs,
  AdjustmentNs,
  EarningsNs,
  DividendsNs,
  SplitsNs,
  AlertNs,
  BackAdjustmentNs,
  SettlementNs,
} from './builtins/constants.js';
import type { BarState } from './barstate.js';

/** Seconds in one bar of a timeframe string ("" / "S" / "D" / "W" / "M" units).
 *  Memoized: `time_close`/`timenow` read it every bar, but a context's timeframe is fixed
 *  (and only a handful of distinct strings ever appear), so parse each string once. */
const TF_SECONDS_CACHE = new Map<string, number>();
export function tfSeconds(tf: string): number {
  const cached = TF_SECONDS_CACHE.get(tf);
  if (cached !== undefined) return cached;
  const m = /^(\d*)([a-zA-Z]?)$/.exec(tf) ?? [];
  const mult = m[1] ? Number(m[1]) : 1;
  const unit = (m[2] || '').toUpperCase(); // '' ⇒ minutes
  // "1M" uses 2628003s (365/12 = 30.4167 days), per the v6 manual.
  const secPer: Record<string, number> = { '': 60, S: 1, D: 86400, W: 604800, M: 2628003 };
  const result = mult * (secPer[unit] ?? 60);
  TF_SECONDS_CACHE.set(tf, result);
  return result;
}

const TZ_OFFSET_HOUR_MS = 60 * 60 * 1000;
const TZ_OFFSET_CACHE = new Map<string, number>();
const TZ_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const FIXED_TZ_OFFSET_CACHE = new Map<string, number | null>();
const SESSION_PARSE_CACHE = new Map<
  string,
  { ranges: Array<[number, number]>; days: Set<number> | null } | null
>();

/** Signed offset (ms) of a timezone from UTC at a given instant. UTC/GMT/±HH:mm + IANA names. */
function tzOffsetMs(tz: string, atUtcMs: number): number {
  const zone = (tz || 'UTC').trim();
  if (/^(UTC|GMT|Z)$/i.test(zone)) return 0;
  const fixed = fixedTzOffsetMs(zone);
  if (fixed != null) return fixed;

  const hour = Math.floor(atUtcMs / TZ_OFFSET_HOUR_MS);
  const cacheKey = `${zone}:${hour}`;
  const cached = TZ_OFFSET_CACHE.get(cacheKey);
  if (cached != null) return cached;

  try {
    let formatter = TZ_FORMATTER_CACHE.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      TZ_FORMATTER_CACHE.set(zone, formatter);
    }
    const parts = formatter.formatToParts(new Date(atUtcMs));
    const g: Record<string, number> = {};
    for (const x of parts) if (x.type !== 'literal') g[x.type] = Number(x.value);
    if (g.hour === 24) g.hour = 0;
    const offset = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second) - atUtcMs;
    if (TZ_OFFSET_CACHE.size > 10_000) TZ_OFFSET_CACHE.clear();
    TZ_OFFSET_CACHE.set(cacheKey, offset);
    return offset;
  } catch {
    return 0;
  }
}

function fixedTzOffsetMs(tz: string): number | null {
  if (FIXED_TZ_OFFSET_CACHE.has(tz)) return FIXED_TZ_OFFSET_CACHE.get(tz) ?? null;
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz);
  const offset = m
    ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0)) * 60000
    : null;
  FIXED_TZ_OFFSET_CACHE.set(tz, offset);
  return offset;
}

/** Parse a Pine session spec "HHMM-HHMM[,HHMM-HHMM][:days]" → minute-of-day ranges + an
 *  optional day set (Pine days: 1=Sunday … 7=Saturday). Returns null if unparseable. */
function parseSession(
  spec: string,
): { ranges: Array<[number, number]>; days: Set<number> | null } | null {
  const cached = SESSION_PARSE_CACHE.get(spec);
  if (cached !== undefined) return cached;

  const [timesPart, daysPart] = spec.split(':');
  if (!timesPart) {
    SESSION_PARSE_CACHE.set(spec, null);
    return null;
  }
  const days = daysPart ? new Set([...daysPart].map(Number).filter((d) => d >= 1 && d <= 7)) : null;
  const ranges: Array<[number, number]> = [];
  for (const r of timesPart.split(',')) {
    const m = /^(\d{4})-(\d{4})$/.exec(r.trim());
    if (!m) {
      SESSION_PARSE_CACHE.set(spec, null);
      return null;
    }
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
    ranges.push([toMin(m[1]), toMin(m[2])]);
  }
  const parsed = ranges.length ? { ranges, days } : null;
  SESSION_PARSE_CACHE.set(spec, parsed);
  return parsed;
}

/** Is the bar at `timeMs` (epoch ms) within the Pine `session` spec, evaluated in `tz`? */
function inSession(timeMs: number, spec: string, tz: string): boolean {
  const parsed = parseSession(spec);
  if (!parsed) return true; // unparseable → don't filter (permissive, as before)
  const local = new Date(timeMs + tzOffsetMs(tz, timeMs)); // bar's wall clock in the session tz
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (parsed.days && !parsed.days.has(local.getUTCDay() + 1)) return false; // 1=Sun … 7=Sat
  return parsed.ranges.some(
    ([start, end]) => (end > start ? mins >= start && mins < end : mins >= start || mins < end), // overnight wrap
  );
}

/** Inverse of tfSeconds: pick the coarsest exact unit for a seconds count. */
function tfFromSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec % 2628003 === 0) return `${sec / 2628003}M`;
  if (sec % 604800 === 0) return `${sec / 604800}W`;
  if (sec % 86400 === 0) return `${sec / 86400}D`;
  if (sec < 60) return `${sec}S`;
  if (sec % 60 === 0) return `${sec / 60}`; // minutes (bare number)
  return `${sec}S`;
}

/** Pre-declared slot ids for the built-in OHLCV+time series. */
export const enum BuiltinSlot {
  Open = 0,
  High = 1,
  Low = 2,
  Close = 3,
  Volume = 4,
  Time = 5,
  Count = 6,
}

export interface RollbackSnapshot {
  ta: ReturnType<Ta['snapshot']>;
  vars: Map<number, unknown>;
  misc: Map<number, unknown>;
  draw: ReturnType<DrawingPool['snapshot']>;
  /** Broker state (pending orders, position, trades) — mutated by strategy.* calls. */
  strategy: unknown;
  /** Alerts are append-only; a rolled-back tick's alerts must be discarded. */
  alertCount: number;
}

/** na (NaN) propagates; comparisons with na yield false (v6, §4.5). */
const num = (x: unknown): number => (typeof x === 'number' ? x : NaN);
/** A color value, or null (use default) when na. */
const col = (c: unknown): string | null => (isNa(c) ? null : (c as string));

export const DEFAULT_LOOP_ITERATION_BUDGET = 1_000_000;

export class ExecutionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionBudgetError';
  }
}

export class ExecutionContext {
  idx = 0;
  execTick = 0;
  bar!: BarState;
  lastBarIndex = 0;
  /** Symbol & timeframe of the current run (set by the Engine). */
  symbol = '';
  tfStr = '';
  /** Full base-bar series (for request.security resampling); set by the Engine. */
  allBars: BaseBar[] = [];
  /** Host-injected base bars for CROSS-symbol request.security, keyed by the requested
   *  symbol (piner never fetches — fractal supplies these from its market-data layer). */
  securityBars = new Map<string, BaseBar[]>();
  /** History columns declared (for request.security sub-contexts). */
  historySlotCount = BuiltinSlot.Count;
  private secCache = new Map<number, unknown[]>();
  private ltfCache = new Map<number, unknown[]>();

  readonly series = new SeriesStore();
  readonly ta = new Ta();
  readonly out = new OutputCollector();

  // builtin namespaces
  readonly math = MathNs;
  readonly color = ColorNs;
  readonly str = StrNs;
  /** User input overrides keyed by input title (set by the Engine). */
  inputOverrides: Record<string, unknown> = {};
  /** input.* namespace — applies an override by key, else the default. */
  readonly input = {
    int: (key: string, defval: unknown) => Math.trunc(num(this.pickInput(key, defval))),
    float: (key: string, defval: unknown) => num(this.pickInput(key, defval)),
    bool: (key: string, defval: unknown) => Boolean(this.pickInput(key, defval)),
    string: (key: string, defval: unknown) => String(this.pickInput(key, defval)),
    color: (key: string, defval: unknown) => this.pickInput(key, defval),
    source: (key: string, defval: unknown) => this.resolveSourceInput(key, defval),
    price: (key: string, defval: unknown) => num(this.pickInput(key, defval)),
    timeframe: (key: string, defval: unknown) => this.pickInput(key, defval),
    symbol: (key: string, defval: unknown) => String(this.pickInput(key, defval)),
    session: (key: string, defval: unknown) => String(this.pickInput(key, defval)),
    text_area: (key: string, defval: unknown) => String(this.pickInput(key, defval)),
    time: (key: string, defval: unknown) => num(this.pickInput(key, defval)),
    enum: (key: string, defval: unknown) => this.pickInput(key, defval),
    // bare input(defval) — auto-typed; returns the default (or override) as-is.
    auto: (key: string, defval: unknown) => this.pickInput(key, defval),
  };
  readonly array = ArrayNs;
  readonly map = MapNs;
  readonly matrix = MatrixNs;

  // drawing objects (pooled, rollback-aware)
  readonly drawPool = new DrawingPool();
  readonly line = makeLineNs(this.drawPool);
  readonly label = makeLabelNs(this.drawPool);
  readonly box = makeBoxNs(this.drawPool);
  readonly table = makeTableNs(this.drawPool);
  readonly linefill = makeLinefillNs(this.drawPool);
  readonly polyline = makePolylineNs(this.drawPool);
  readonly plotNs = PlotNs;
  readonly shape = ShapeNs;
  readonly location = LocationNs;
  readonly hlineNs = HlineNs;
  readonly display = DisplayNs;
  readonly position = PositionNs;
  readonly size = SizeNs;
  readonly xloc = XlocNs;
  readonly extend = ExtendNs;
  readonly format = FormatNs;
  readonly font = FontNs;
  readonly text = TextNs;
  readonly currency = CurrencyNs;
  readonly barmerge = BarmergeNs;
  readonly scale = ScaleNs;
  readonly order = OrderNs;
  readonly yloc = YlocNs;
  readonly adjustment = AdjustmentNs;
  readonly backadjustment = BackAdjustmentNs;
  readonly settlement_as_close = SettlementNs;
  readonly earnings = EarningsNs;
  readonly dividends = DividendsNs;
  readonly splits = SplitsNs;
  /** log.* — records messages (no console side-effects in the engine). */
  readonly log = {
    info: (msg: unknown) => void this.out.alert(this.idx, `[info] ${String(msg)}`),
    warning: (msg: unknown) => void this.out.alert(this.idx, `[warn] ${String(msg)}`),
    error: (msg: unknown) => void this.out.alert(this.idx, `[error] ${String(msg)}`),
  };
  /** ticker.* — builds ticker-id strings (used by request.*, which is deferred). */
  readonly ticker = {
    new: (prefix: string, tkr: string) => `${prefix}:${tkr}`,
    standard: (t: string) => t,
    heikinashi: (t: string) => `${t}_HA`,
    renko: (t: string) => `${t}_RK`,
    linebreak: (t: string) => `${t}_LB`,
    kagi: (t: string) => `${t}_KG`,
    pointfigure: (t: string) => `${t}_PF`,
    modify: (t: string) => t,
    inherit: (t: string) => t,
  };
  /**
   * request.* — `request.security` is intercepted by the compiler (Phase 7). The
   * fundamental/alternative-data family has no feed in a headless run, so each
   * returns na (a scalar series), exactly as Pine yields when data is unavailable.
   * `security_lower_tf` returns an empty array so `for … in` loops stay safe.
   */
  readonly request = {
    dividends: () => NA,
    earnings: () => NA,
    splits: () => NA,
    financial: () => NA,
    economic: () => NA,
    quandl: () => NA,
    currency_rate: () => NA,
    seed: () => NA,
    footprint: () => NA,
    security_lower_tf: () => [] as unknown[],
  };
  /** runtime.* — runtime.error(message) halts the script with the message. */
  readonly runtime = {
    error: (message: unknown): void => {
      throw new Error(`Pine runtime error: ${String(message)}`);
    },
  };

  readonly NA = NA;

  // strategy broker + facade (set up in the constructor)
  readonly strategyBroker = new StrategyBroker();
  readonly strategy: ReturnType<typeof makeStrategyNs>;

  private vars = new Map<number, unknown>();
  private varips = new Map<number, unknown>();
  private misc = new Map<number, unknown>(); // site-keyed state for global stateful builtins
  loopIterationBudget = DEFAULT_LOOP_ITERATION_BUDGET;
  private loopIterationsRemaining = DEFAULT_LOOP_ITERATION_BUDGET;

  constructor() {
    for (let i = 0; i < BuiltinSlot.Count; i++) this.series.declareNumericSlot();
    this.ta.host = this;
    this.strategyBroker.host = this;
    this.strategy = makeStrategyNs(this.strategyBroker);
  }

  /** Instrument tick size — drives slippage (ticks) and tick-denominated exit
   * profit/loss/trail. Defaults to 0.01; set per-run via RunOptions.mintick so non-cent
   * instruments (futures, etc.) price ticks correctly. */
  mintick = 0.01;
  resetLoopBudget(): void {
    const budget = Math.floor(this.loopIterationBudget);
    this.loopIterationsRemaining = Number.isFinite(budget)
      ? Math.max(0, budget)
      : Number.POSITIVE_INFINITY;
  }
  consumeLoopIteration(): void {
    if (this.loopIterationsRemaining === Number.POSITIVE_INFINITY) return;
    if (this.loopIterationsRemaining <= 0) {
      throw new ExecutionBudgetError(`Pine execution budget exceeded at bar_index ${this.idx}`);
    }
    this.loopIterationsRemaining--;
  }
  /** Driver hook: fill pending strategy orders against the current bar (at bar open). */
  onStrategyBar(): void {
    this.strategyBroker.onBar();
  }
  /** Driver hook (after the script body): same-bar-close fills for process_orders_on_close. */
  onStrategyBarClose(): void {
    this.strategyBroker.onBarClose();
  }
  configureStrategy(s: Partial<StrategySettings>): void {
    this.strategyBroker.configure(s);
  }

  // ── built-in series leaves (current-bar values) ───────────
  get open() {
    return this.series.get(BuiltinSlot.Open, 0);
  }
  get high() {
    return this.series.get(BuiltinSlot.High, 0);
  }
  get low() {
    return this.series.get(BuiltinSlot.Low, 0);
  }
  get close() {
    return this.series.get(BuiltinSlot.Close, 0);
  }
  get volume() {
    return this.series.get(BuiltinSlot.Volume, 0);
  }
  get time() {
    return this.series.get(BuiltinSlot.Time, 0);
  }
  get time_close() {
    const t = this.series.get(BuiltinSlot.Time, 0);
    return Number.isNaN(t) ? NaN : t + tfSeconds(this.tfStr) * 1000;
  }
  get hl2() {
    return (this.high + this.low) / 2;
  }
  get hlc3() {
    return (this.high + this.low + this.close) / 3;
  }
  get ohlc4() {
    return (this.open + this.high + this.low + this.close) / 4;
  }
  get hlcc4() {
    return (this.high + this.low + this.close + this.close) / 4;
  }
  get bar_index() {
    return this.idx;
  }
  get last_bar_index() {
    return this.lastBarIndex;
  }
  get barstate(): BarState {
    return this.bar;
  }
  /** time of the dataset's last bar (UTC ms). */
  get last_bar_time() {
    return this.allBars[this.lastBarIndex]?.time ?? this.series.get(BuiltinSlot.Time, 0);
  }
  /** "now" — deterministic: the last bar's close instant (last_bar_time + one tf),
   *  so both backends agree. Falls back to the current bar's time without a dataset. */
  get timenow() {
    const lbt = this.allBars[this.lastBarIndex]?.time;
    return Number.isFinite(lbt) ? lbt + tfSeconds(this.tfStr) * 1000 : this.time;
  }
  /** start instant (UTC midnight) of the trading day the current bar belongs to. */
  get time_tradingday() {
    return this.tradingDayMs(this.time);
  }
  /** Trading-day bucket for the strategy.risk intraday rules: the calendar trading
   *  day on daily-or-faster timeframes, one bucket per bar above daily (the v6
   *  reference: “per 1 bar, if chart resolution is higher than 1 day”). */
  get tradingDayKey(): number {
    if (tfSeconds(this.tfStr) > 86400) return this.idx;
    const d = this.tradingDayMs(this.time);
    return Number.isFinite(d) ? d : this.idx;
  }

  /** chart.* — two-level namespace (`chart.point.*` builds point records) plus the
   *  chart-type flags, theme colors, and visible-range bar times. */
  get chart() {
    return {
      point: {
        new: (time: number, index: number, price: number) => ({ time, index, price }),
        from_index: (index: number, price: number) => ({ index, time: NaN, price }),
        from_time: (time: number, price: number) => ({ time, index: NaN, price }),
        now: (price?: unknown) => ({
          index: this.idx,
          time: this.time,
          price: price === undefined || isNa(price) ? this.close : Number(price),
        }),
        copy: (p: unknown) => (p == null || isNa(p) ? NA : { ...(p as object) }),
      },
      is_standard: true,
      is_heikinashi: false,
      is_renko: false,
      is_kagi: false,
      is_pnf: false,
      is_range: false,
      is_linebreak: false,
      bg_color: '#ffffff',
      fg_color: '#131722',
      left_visible_bar_time: this.allBars[0]?.time ?? NaN,
      right_visible_bar_time: this.allBars[this.lastBarIndex]?.time ?? this.time,
    };
  }

  /** session.* — the regular/extended constants plus the first/last-bar-of-session
   *  flags (24h dataset ⇒ a session is one UTC trading day; regular == extended). */
  get session() {
    const t = this.time;
    const day = this.tradingDayMs(t);
    const prev = this.series.get(BuiltinSlot.Time, 1);
    const next = this.allBars[this.idx + 1]?.time ?? NaN;
    const isFirst = !Number.isFinite(prev) || this.tradingDayMs(prev) !== day;
    const isLast = !Number.isFinite(next) || this.tradingDayMs(next) !== day;
    return {
      ...SessionNs,
      isfirstbar: isFirst,
      islastbar: isLast,
      isfirstbar_regular: isFirst,
      islastbar_regular: isLast,
    };
  }

  /** UTC-midnight (ms) of the calendar day containing `t` — the trading-day key. */
  private tradingDayMs(t: number): number {
    if (!Number.isFinite(t)) return NaN;
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // ── date/time (current bar; `time` is ms epoch, UTC) ──────
  private dateField(t: number, f: string): number {
    const d = new Date(t);
    switch (f) {
      case 'year':
        return d.getUTCFullYear();
      case 'month':
        return d.getUTCMonth() + 1;
      case 'dayofmonth':
        return d.getUTCDate();
      case 'dayofweek':
        return d.getUTCDay() + 1; // Pine: Sunday = 1
      case 'hour':
        return d.getUTCHours();
      case 'minute':
        return d.getUTCMinutes();
      case 'second':
        return d.getUTCSeconds();
      case 'weekofyear': {
        const onejan = Date.UTC(d.getUTCFullYear(), 0, 1);
        return Math.ceil(((t - onejan) / 86400000 + 1) / 7);
      }
      default:
        return NaN;
    }
  }
  get year() {
    return this.dateField(this.time, 'year');
  }
  get month() {
    return this.dateField(this.time, 'month');
  }
  get dayofmonth() {
    return this.dateField(this.time, 'dayofmonth');
  }
  get dayofweek() {
    return this.dateField(this.time, 'dayofweek');
  }
  get hour() {
    return this.dateField(this.time, 'hour');
  }
  get minute() {
    return this.dateField(this.time, 'minute');
  }
  get second() {
    return this.dateField(this.time, 'second');
  }
  get weekofyear() {
    return this.dateField(this.time, 'weekofyear');
  }
  /** Date functions taking a time arg: year(t), month(t), … */
  dateAt(field: string, t: number): number {
    return isNa(t) ? NaN : this.dateField(num(t), field);
  }

  /**
   * timestamp(...) → epoch ms. Forms: (y, mo, d, h?, mi?, s?),
   * (timezone, y, mo, d, h?, mi?, s?), or a single date string ("20 Jul 2021 00:00 +0300").
   * The wall-clock parts are interpreted in the given timezone (default UTC).
   */
  timestamp(...a: unknown[]): number {
    if (a.length === 1 && typeof a[0] === 'string') {
      const t = Date.parse(a[0]);
      return Number.isNaN(t) ? NaN : t;
    }
    let i = 0;
    let tz = 'UTC';
    if (typeof a[0] === 'string') {
      tz = a[0];
      i = 1;
    } // leading timezone arg
    const y = num(a[i]),
      mo = num(a[i + 1]),
      d = num(a[i + 2]);
    if ([y, mo, d].some((v) => Number.isNaN(v))) return NaN;
    const h = a[i + 3] != null ? num(a[i + 3]) : 0,
      mi = a[i + 4] != null ? num(a[i + 4]) : 0,
      s = a[i + 5] != null ? num(a[i + 5]) : 0;
    const utc = Date.UTC(y, mo - 1, d, h, mi, s);
    return utc - tzOffsetMs(tz, utc);
  }

  /** time(timeframe, session?, timezone?) — the current bar's open time, or na when a
   *  `session` is given and the bar falls OUTSIDE that session window (evaluated in
   *  `timezone`, default UTC). HTF resampling of `timeframe` is still deferred. */
  timeFn(_tf?: unknown, session?: unknown, tz?: unknown): number {
    if (typeof session === 'string' && session !== '') {
      const zone = typeof tz === 'string' && tz !== '' ? tz : 'UTC';
      return inSession(this.time, session, zone) ? this.time : NaN;
    }
    return this.time;
  }

  /** time_close(timeframe, …) — the bar's close time (open + one timeframe duration). */
  timeCloseFn(tf?: unknown, _session?: unknown, _tz?: unknown): number {
    const t = this.time;
    return isNaN(t) ? NaN : t + tfSeconds(tf == null || tf === '' ? this.tfStr : String(tf)) * 1000;
  }

  /** syminfo.prefix(tickerid) / syminfo.ticker(tickerid) — split "EXCHANGE:SYMBOL". */
  syminfoParse(which: 'prefix' | 'ticker', tickerid: unknown): string {
    const s = String(tickerid ?? '');
    const i = s.indexOf(':');
    if (which === 'prefix') return i >= 0 ? s.slice(0, i) : '';
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // ── syminfo.* / timeframe.* (from the run's symbol + timeframe) ──
  get syminfo() {
    return {
      tickerid: this.symbol,
      ticker: this.symbol,
      prefix: '',
      root: this.symbol,
      description: this.symbol,
      currency: 'USD',
      basecurrency: 'USD',
      type: 'crypto',
      mintick: this.mintick,
      minmove: 1,
      pricescale: 100,
      pointvalue: 1,
      timezone: 'UTC',
      session: 'regular',
      volumetype: 'base',
      mincontract: 1,
      country: '',
      employees: 0,
      shareholders: 0,
    };
  }
  get timeframe() {
    const tf = this.tfStr;
    const m = /^(\d*)([a-zA-Z]?)$/.exec(tf) ?? [];
    const mult = m[1] ? Number(m[1]) : 1;
    const unit = (m[2] || (m[1] ? '' : '')).toUpperCase(); // '' ⇒ minutes
    return {
      period: tf,
      multiplier: mult,
      // in_seconds(timeframe="") is a FUNCTION in v6 (defaults to the chart tf).
      in_seconds: (t?: unknown) => tfSeconds(t == null || isNa(t) || t === '' ? tf : String(t)),
      // from_seconds(seconds) → the shortest timeframe string for that many seconds.
      from_seconds: (sec: unknown) => tfFromSeconds(Number(sec)),
      // change(timeframe) → true on the first bar of a new period of that tf.
      // Stateless: compares this bar's bucket to the previous bar's (by bar time).
      change: (t: unknown) => {
        const tfArg = String(t);
        const now = this.time;
        const prev = this.series.get(BuiltinSlot.Time, 1);
        if (isNaN(prev)) return true; // first bar starts a new period
        return bucketKey(now, tfArg) !== bucketKey(prev, tfArg);
      },
      isticks: unit === 'T',
      isseconds: unit === 'S',
      isminutes: unit === '',
      isintraday: unit === '' || unit === 'S' || unit === 'T',
      isdaily: unit === 'D',
      isweekly: unit === 'W',
      ismonthly: unit === 'M',
      isdwm: unit === 'D' || unit === 'W' || unit === 'M',
      main_period: tf,
    };
  }

  /** Declare enough history columns for the compiler-assigned slots. */
  ensureHistorySlots(total: number): void {
    this.series.ensureNumericSlots(total);
    this.historySlotCount = Math.max(this.historySlotCount, total);
  }

  /**
   * request.security(symbol, timeframe, expr) — higher-timeframe data on the same
   * symbol. `evalFn(subCtx)` evaluates the requested expression against an HTF
   * sub-context. Result is mapped to chart bars with the lookahead semantics.
   */
  security(
    site: number,
    symbol: string,
    tf: unknown,
    lookahead: unknown,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown {
    let cache = this.secCache.get(site);
    if (!cache) {
      cache = this.computeSecurity(symbol ?? '', String(tf), !!lookahead, evalFn);
      this.secCache.set(site, cache);
    }
    const v = cache[this.idx];
    return v === undefined ? NA : v;
  }

  /**
   * request.security_lower_tf(symbol, tf, expr) — intrabar (lower-timeframe) data: the
   * expression's values across the lower-TF bars WITHIN the current chart bar. Declares the
   * dependency (so the host fetches + injects the lower-TF bars under `securityBars["<sym>@<tf>"]`)
   * and, when those bars are present, buckets them into each chart bar and evaluates per intrabar.
   * A scalar expr → one array per chart bar; a tuple expr (`[high, low, volume]`) → a tuple of
   * arrays. No injected bars → [] per chart bar (graceful — the pre-feed behavior).
   */
  securityLowerTf(
    site: number,
    symbol: string,
    tf: unknown,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const tfStr = String(tf);
    const sym = symbol || this.symbol;
    this.out.recordSecurityRequest(sym, tfStr, true); // declare the dependency
    let cache = this.ltfCache.get(site);
    if (!cache) {
      cache = this.computeLowerTf(sym, tfStr, evalFn);
      this.ltfCache.set(site, cache);
    }
    const v = cache[this.idx];
    return v === undefined ? [] : (v as unknown[]);
  }

  /**
   * Bucket host-injected lower-TF bars INTO each chart bar (the inverse of HTF resampling) and
   * evaluate the requested expression once per intrabar. The injected bars live under
   * `securityBars["<symbol>@<tf>"]` (the raw request tf — the host resolves an auto/empty tf to a
   * concrete one for FETCHING, but keys by what the script asked for). Tuple expressions are
   * transposed: per-intrabar `[h,l,v]` tuples become `[hArr, lArr, vArr]`.
   */
  private computeLowerTf(
    symbol: string,
    tf: string,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const out: unknown[] = new Array(this.allBars.length);
    const injected = this.securityBars.get(`${symbol}@${tf}`);
    // Choose the intrabar source. Host-injected lower-TF bars win. With none: an EMPTY (auto)
    // timeframe degrades to ONE intrabar per chart bar — the chart bar itself, the most granular
    // data available — so visible-range / volume-profile scripts (LuxAlgo S&D) render from chart
    // bars alone instead of accumulating nothing. An explicitly requested lower tf with no data
    // stays [] (the host genuinely lacks it; the script must wait for injection).
    const ltf = injected && injected.length ? injected : tf === '' ? this.allBars : null;
    if (!ltf) {
      out.fill([]);
      return out;
    }
    // value of the expr at each intrabar (reuse the HTF sub-context evaluator).
    const vals = this.evalOverHtf(ltf, tf, symbol, evalFn);
    const arity = Array.isArray(vals[0]) ? (vals[0] as unknown[]).length : 0; // >0 ⇒ tuple expr
    let j = 0;
    for (let c = 0; c < this.allBars.length; c++) {
      const start = this.allBars[c].time;
      const end = c + 1 < this.allBars.length ? this.allBars[c + 1].time : Infinity;
      while (j < ltf.length && ltf[j].time < start) j++; // drop intrabars before this chart bar
      const bucket: unknown[] = [];
      while (j < ltf.length && ltf[j].time < end) {
        bucket.push(vals[j]);
        j++;
      }
      if (arity > 0) {
        const cols: unknown[][] = Array.from({ length: arity }, () => []);
        for (const t of bucket) for (let a = 0; a < arity; a++) cols[a].push((t as unknown[])[a]);
        out[c] = cols; // tuple of arrays
      } else {
        out[c] = bucket; // single array
      }
    }
    return out;
  }

  private computeSecurity(
    symbol: string,
    tf: string,
    lookahead: boolean,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const sym = this.symbol;
    this.out.recordSecurityRequest(symbol || sym, tf, false); // declare the dependency (P0)
    // Same-symbol only on exact match or an exchange-prefix boundary ("BINANCE:BTCUSDT"
    // vs "BTCUSDT") — a bare endsWith would misclassify e.g. WETHUSDT as ETHUSDT.
    const sameSymbol =
      !symbol ||
      (!!sym && (symbol === sym || symbol.endsWith(`:${sym}`) || sym.endsWith(`:${symbol}`)));
    if (!sameSymbol) {
      // CROSS-symbol: resolve against host-injected bars; absent → all-na (no feed → Pine's
      // own behavior). Aligned to the chart bars by TIME (the other symbol has its own bars).
      const baseBars = this.securityBars.get(symbol);
      return baseBars && baseBars.length
        ? this.computeCrossSecurity(symbol, baseBars, tf, lookahead, evalFn)
        : [];
    }
    // SAME-symbol.
    // When the host injects the requested timeframe's ACTUAL bars under
    // `securityBars["<symbol>@<tf>"]`, evaluate the expression over that real series and align it to
    // the chart by bar CLOSE time — the accurate, TradingView-matching path for ANY timeframe
    // (finer OR higher than the chart). This avoids resampling the chart's own bars, which both
    // can't produce a finer timeframe and, for a higher timeframe, surfaces a just-closed HTF bar
    // one chart-bar too late. Resampling below is only a fallback when no real bars were injected.
    const injected = this.securityBars.get(`${symbol || sym}@${tf}`);
    if (injected && injected.length)
      return this.computeInjectedSameSymbol(injected, tf, sym, lookahead, evalFn);
    // Fallback (no injected bars): resample the chart's own bars; align by base-bar bucket index.
    const { htf, bucketOf } = resampleToTimeframe(this.allBars, tf);
    const vals = this.evalOverHtf(htf, tf, sym, evalFn);
    // The non-repainting lookahead_off lag (see the previous HTF bar) only applies
    // when the requested timeframe is STRICTLY HIGHER than the chart's: a same- or
    // lower-TF request resolves to an already-complete bar, so it has no lag
    // (`request.security(tickerid, timeframe.period, close)` == close).
    const higherTf = tfSeconds(tf) > tfSeconds(this.tfStr || tf);
    const out: unknown[] = new Array(this.allBars.length);
    for (let c = 0; c < this.allBars.length; c++) {
      const bk = bucketOf[c];
      out[c] = lookahead || !higherTf ? vals[bk] : bk > 0 ? vals[bk - 1] : NA;
    }
    return out;
  }

  /**
   * Same-symbol request.security resolved against the host-injected ACTUAL bars for the requested
   * timeframe (`securityBars["<symbol>@<tf>"]`) — used for any timeframe, finer or higher than the
   * chart. Evaluate the expression once per injected bar, then map onto each chart bar by CLOSE
   * time so it matches TradingView bar-for-bar:
   *   • lookahead_off (default, non-repainting): the value of the last injected bar that has CLOSED
   *     by the chart bar's own close. A higher-tf bar becomes visible on the LAST chart bar of its
   *     period (their closes coincide) — NOT one bar later — and a finer-tf bar resolves to the
   *     last sub-bar that closed within the chart bar. No future information is used.
   *   • lookahead_on: the injected bar whose period CONTAINS the chart bar (open ≤ chart open) —
   *     the current, possibly-incomplete bar, i.e. TradingView's future leak on historical bars.
   * Values carry forward across chart bars that hold no newly-closed injected bar.
   */
  private computeInjectedSameSymbol(
    injected: BaseBar[],
    tf: string,
    symbol: string,
    lookahead: boolean,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const vals = this.evalOverHtf(injected, tf, symbol, evalFn);
    const n = this.allBars.length;
    const tfMs = tfSeconds(tf) * 1000;
    const chartTfMs = n > 1 ? this.allBars[1].time - this.allBars[0].time : tfMs;
    // close time of injected bar j = the next injected bar's open (falls back to open + one tf).
    const closeOf = (j: number) =>
      j + 1 < injected.length ? injected[j + 1].time : injected[j].time + tfMs;
    const out: unknown[] = new Array(n);
    let j = 0;
    let carry: unknown = NA;
    for (let c = 0; c < n; c++) {
      if (lookahead) {
        // advance through every injected bar whose PERIOD has started by this chart bar's open
        while (j < injected.length && injected[j].time <= this.allBars[c].time) carry = vals[j++];
      } else {
        // advance through every injected bar that has CLOSED by this chart bar's close
        const chartClose = c + 1 < n ? this.allBars[c + 1].time : this.allBars[c].time + chartTfMs;
        while (j < injected.length && closeOf(j) <= chartClose) carry = vals[j++];
      }
      out[c] = carry;
    }
    return out;
  }

  /** Evaluate the requested expression once per HTF bar in a fresh sub-context. */
  private evalOverHtf(
    htf: HtfBar[],
    tf: string,
    symbol: string,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const sub = new ExecutionContext();
    sub.ensureHistorySlots(this.historySlotCount);
    sub.inputOverrides = this.inputOverrides;
    sub.loopIterationBudget = this.loopIterationBudget;
    sub.symbol = symbol;
    sub.tfStr = tf;
    sub.lastBarIndex = htf.length - 1;
    sub.allBars = htf; // allow (single-level) nested resampling
    const vals: unknown[] = [];
    for (let i = 0; i < htf.length; i++) {
      const b = htf[i];
      sub.idx = i;
      sub.bar = historicalBarState(i === htf.length - 1);
      sub.resetLoopBudget();
      sub.series.beginBar();
      sub.set(BuiltinSlot.Open, b.open);
      sub.set(BuiltinSlot.High, b.high);
      sub.set(BuiltinSlot.Low, b.low);
      sub.set(BuiltinSlot.Close, b.close);
      sub.set(BuiltinSlot.Volume, b.volume);
      sub.set(BuiltinSlot.Time, b.time);
      vals[i] = evalFn(sub);
      sub.series.commitBar();
    }
    return vals;
  }

  /**
   * Cross-symbol request.security: resample the injected bars, evaluate, then map each chart
   * bar to the other symbol's bucket BY TIME. lookahead_off + higher-tf uses the last bucket
   * that closed strictly before the chart bar's own bucket (no lookahead bias).
   */
  private computeCrossSecurity(
    symbol: string,
    baseBars: BaseBar[],
    tf: string,
    lookahead: boolean,
    evalFn: (sub: ExecutionContext) => unknown,
  ): unknown[] {
    const { htf } = resampleToTimeframe(baseBars, tf);
    if (htf.length === 0) return [];
    const keys = htf.map((h) => bucketKey(h.time, tf)); // ascending
    const vals = this.evalOverHtf(htf, tf, symbol, evalFn);
    const strictPrev = !lookahead && tfSeconds(tf) > tfSeconds(this.tfStr || tf);
    const out: unknown[] = new Array(this.allBars.length);
    let j = -1; // rightmost htf index with keys[j] <= the current chart bar's bucket key
    for (let c = 0; c < this.allBars.length; c++) {
      const kc = bucketKey(this.allBars[c].time, tf);
      while (j + 1 < keys.length && keys[j + 1] <= kc) j++;
      const idx = strictPrev ? (j >= 0 && keys[j] < kc ? j : j - 1) : j; // last fully-closed bucket
      out[c] = idx >= 0 ? vals[idx] : NA;
    }
    return out;
  }

  // ── history & na ──────────────────────────────────────────
  // `$.get` backs every `x[n]` history read (both backends) — polymorphic so a slot holding a
  // string/color/array/map/UDT reads back the value, not the NaN a numeric column would coerce
  // it to. The built-in OHLCV/time leaves read `this.series.get` directly (numeric fast path).
  get(slot: number, offset: number): unknown {
    return this.series.getHist(slot, offset);
  }
  set(slot: number, value: unknown): void {
    this.series.set(slot, value);
  }

  na(v: unknown): boolean {
    return isNa(v);
  }
  nz(v: unknown, replacement = 0): number {
    return isNa(v) ? replacement : num(v);
  }

  fixnan(v: number, site: number): number {
    const prev = this.misc.get(site);
    if (!isNa(v)) {
      this.misc.set(site, v);
      return v;
    }
    return prev === undefined ? NaN : (prev as number);
  }

  colorLit(s: string): string {
    return s;
  }

  private pickInput(key: string, defval: unknown): unknown {
    const v = this.inputOverrides[key];
    return v === undefined ? defval : v;
  }

  /**
   * input.source resolution. An override is normally the script's own series value (a number),
   * but a host (e.g. a settings dropdown) may pass a source NAME string ("close", "hl2", …) —
   * resolve it to that series' current-bar value so the picked source actually drives the
   * script. Unknown strings / non-strings pass through unchanged, so the default is intact.
   */
  private resolveSourceInput(key: string, defval: unknown): unknown {
    const v = this.pickInput(key, defval);
    if (typeof v === 'string') {
      const series = this.sourceByName(v);
      if (series !== undefined) return series;
    }
    return v;
  }

  /** Current-bar value of a named price source, or undefined if the name isn't a source. */
  private sourceByName(name: string): number | undefined {
    switch (name) {
      case 'open':
        return this.open;
      case 'high':
        return this.high;
      case 'low':
        return this.low;
      case 'close':
        return this.close;
      case 'volume':
        return this.volume;
      case 'hl2':
        return this.hl2;
      case 'hlc3':
        return this.hlc3;
      case 'ohlc4':
        return this.ohlc4;
      case 'hlcc4':
        return this.hlcc4;
      default:
        return undefined;
    }
  }

  // type casts
  toInt(x: number): number {
    return isNa(x) ? NaN : Math.trunc(num(x));
  }
  toFloat(x: number): number {
    return num(x);
  }
  toBool(x: unknown): boolean {
    return isNa(x) ? false : !!x;
  }

  // ── var / varip ───────────────────────────────────────────
  initVar<T>(id: number, init: () => T): T {
    if (!this.vars.has(id)) this.vars.set(id, init());
    return this.vars.get(id) as T;
  }
  readVar<T>(id: number): T {
    return this.vars.get(id) as T;
  }
  setVar(id: number, value: unknown): void {
    this.vars.set(id, value);
  }

  initVarip<T>(id: number, init: () => T): T {
    if (!this.varips.has(id)) this.varips.set(id, init());
    return this.varips.get(id) as T;
  }
  readVarip<T>(id: number): T {
    return this.varips.get(id) as T;
  }
  setVarip(id: number, value: unknown): void {
    this.varips.set(id, value);
  }

  // ── arithmetic (na = NaN propagates) ──────────────────────
  add(a: number, b: number): number {
    return num(a) + num(b);
  }
  sub(a: number, b: number): number {
    return num(a) - num(b);
  }
  mul(a: number, b: number): number {
    return num(a) * num(b);
  }
  div(a: number, b: number): number {
    return num(a) / num(b);
  } // v6: always float division
  mod(a: number, b: number): number {
    return num(a) % num(b);
  }
  neg(a: number): number {
    return -num(a);
  }
  concat(a: unknown, b: unknown): string {
    return String(a) + String(b);
  }

  // ── comparisons (na operand → false, §4.5) ────────────────
  lt(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : (a as number) < (b as number);
  }
  le(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : (a as number) <= (b as number);
  }
  gt(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : (a as number) > (b as number);
  }
  ge(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : (a as number) >= (b as number);
  }
  eq(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : a === b;
  }
  ne(a: unknown, b: unknown): boolean {
    return isNa(a) || isNa(b) ? false : a !== b;
  }
  not(a: unknown): boolean {
    return !this.toBool(a);
  } // v6: na bool coerces to false, so `not na` is true

  // ── outputs (the visual IR; per-bar color where applicable) ─
  plot(
    id: number,
    value: number,
    color?: unknown,
    title = `plot ${id}`,
    options: Record<string, unknown> = {},
  ): number {
    this.out.declarePlot(id, title, options);
    this.out.plot(id, this.idx, num(value), color === undefined ? undefined : col(color)); // na (NA sentinel) → NaN
    return id; // plot() returns a handle (its id) for fill(plot1, plot2)
  }
  /** plotshape / plotchar / plotarrow — kind/location/glyph are static, color/text per-bar. */
  marker(
    id: number,
    on: unknown,
    color: unknown,
    text: unknown,
    title: string,
    location: string,
    glyph: string,
    kind: 'shape' | 'char' | 'arrow',
  ): void {
    this.out.declareMarker(id, title, kind, location, glyph);
    const shown = !isNa(on) && on !== false && on !== 0;
    this.out.marker(id, this.idx, shown, {
      color: col(color),
      text: isNa(text) ? undefined : String(text),
    });
  }
  plotcandle(
    id: number,
    open: number,
    high: number,
    low: number,
    close: number,
    color?: unknown,
    wick?: unknown,
    border?: unknown,
    title = `candle ${id}`,
  ): void {
    this.out.declareCandle(id, title);
    const ohlc =
      isNa(open) || isNa(high) || isNa(low) || isNa(close) ? null : { open, high, low, close };
    this.out.candle(
      id,
      this.idx,
      ohlc,
      color === undefined ? undefined : col(color),
      wick === undefined ? undefined : col(wick),
      border === undefined ? undefined : col(border),
    );
  }
  hline(id: number, price: number, title = `hline ${id}`): number {
    this.out.hline(id, price, title);
    return id; // returns a handle for fill(hline1, hline2)
  }
  fill(id: number, plot1: number, plot2: number, color?: unknown, title = `fill ${id}`): void {
    this.out.declareFill(id, plot1, plot2, title, color === undefined ? null : col(color));
    if (color !== undefined) this.out.fillColor(id, this.idx, col(color));
  }
  fillGradient(
    id: number,
    plot1: number,
    plot2: number,
    topValue: number,
    bottomValue: number,
    topColor: unknown,
    bottomColor: unknown,
    title = `fill ${id}`,
  ): void {
    this.out.declareFill(id, plot1, plot2, title, null);
    this.out.fillGradientPoint(
      id,
      this.idx,
      topValue,
      bottomValue,
      col(topColor),
      col(bottomColor),
    );
  }
  bgcolor(id: number, color: unknown): void {
    this.out.bgcolor(id, this.idx, col(color));
  }
  barcolor(id: number, color: unknown): void {
    this.out.barcolor(id, this.idx, col(color));
  }
  /** alert(message, freq?) — records the alert. Callable AND a namespace so the
   *  `alert.freq_*` frequency constants resolve as `$.alert.freq_*`. */
  readonly alert = Object.assign((message: string, _freq?: unknown): void => {
    this.out.alert(this.idx, message);
  }, AlertNs);
  alertcondition(condition: boolean, title?: string, message?: string): void {
    if (condition) this.out.alert(this.idx, message ?? title ?? 'alert');
  }

  /**
   * Method-call dispatch (`recv.method(args)`) for collections and drawing
   * handles, resolved at runtime by the receiver's shape. The namespace-call
   * form (`array.push(recv, args)`) is the same function with recv as arg 0.
   */
  method(recv: unknown, name: string, args: unknown[]): unknown {
    if (Array.isArray(recv)) return (this.array as any)[name]?.(recv, ...args) ?? NA;
    if (recv instanceof Map) return (this.map as any)[name]?.(recv, ...args) ?? NA;
    if (recv && typeof recv === 'object' && 'rows' in recv && 'data' in recv) {
      return (this.matrix as any)[name]?.(recv as Matrix, ...args) ?? NA;
    }
    if (typeof recv === 'number') {
      const o = this.drawPool.objects.get(recv);
      if (o) {
        const ns =
          o.type === 'line'
            ? this.line
            : o.type === 'label'
              ? this.label
              : o.type === 'box'
                ? this.box
                : o.type === 'linefill'
                  ? this.linefill
                  : o.type === 'polyline'
                    ? this.polyline
                    : this.table;
        return (ns as any)[name]?.(recv, ...args) ?? NA;
      }
    }
    return NA;
  }

  // ── rollback support ──────────────────────────────────────
  snapshotMutable(): RollbackSnapshot {
    // Deep-clone: var values may be reference objects (arrays/collections), and a
    // developing realtime tick must not mutate the committed snapshot.
    return {
      ta: this.ta.snapshot(),
      vars: structuredClone(this.vars),
      misc: structuredClone(this.misc),
      draw: this.drawPool.snapshot(),
      strategy: this.strategyBroker.snapshot(),
      alertCount: this.out.alerts.length,
    };
  }
  restoreMutable(snap: RollbackSnapshot): void {
    this.ta.restore(snap.ta);
    this.vars = structuredClone(snap.vars);
    this.misc = structuredClone(snap.misc); // fixnan state is rolled back like ta state
    this.drawPool.restore(snap.draw); // drawing objects roll back on each realtime tick
    this.strategyBroker.restore(snap.strategy); // pending orders/fills from a superseded tick are discarded
    this.out.alerts.length = snap.alertCount; // ditto duplicate alert/log events
    // only varips intentionally escape rollback within the same realtime bar
  }

  /** Drop request.security caches — the driver calls this on each realtime tick so
   *  cached per-bar columns (computed over `allBars`) pick up the developing bar. */
  invalidateSecurityCaches(): void {
    this.secCache.clear();
    this.ltfCache.clear();
  }

  /** Live drawing objects (for rendering). */
  get drawings(): DrawObject[] {
    return [...this.drawPool.objects.values()];
  }
}

export { NA, isNa };
