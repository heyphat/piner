/** str.* — minimal string built-ins (expand as needed). */
import { NA, isNa } from '../series.js';
// NOTE: use the canonical `isNa` (recognizes the {__na:true} sentinel AND NaN);
// a local NaN-only check would silently miss string-typed `na` values.

/** Pad a number to a fixed width with leading zeros (for format_time tokens). */
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const FIXED_OFFSET_MINUTES_CACHE = new Map<string, number | null>();
const WALL_CLOCK_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

/**
 * Format a number with a Java/Pine DecimalFormat-style pattern.
 * Pattern language (per the v6 manual `str.tostring`/`str.format` remarks):
 *   #  optional digit (no trailing zero is shown — `str.tostring(3.99,'#')` → "4")
 *   0  required digit (forces a leading/trailing zero — `'#.000'` keeps zeros)
 *   .  decimal separator (splits integer and fraction sub-patterns)
 *   ,  grouping separator (group size = digits after the last comma in the int part)
 * Values are rounded HALF_UP (away from zero) to the pattern's max fraction digits.
 * A tiny epsilon corrects binary float artefacts (e.g. 0.125 → "0.13").
 */
function formatNumberPattern(value: number, pattern: string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const dot = pattern.indexOf('.');
  const intPat = dot < 0 ? pattern : pattern.slice(0, dot);
  const fracPat = dot < 0 ? '' : pattern.slice(dot + 1);
  let grouping = 0;
  const lastComma = intPat.lastIndexOf(',');
  if (lastComma >= 0) grouping = intPat.slice(lastComma + 1).replace(/[^#0]/g, '').length;
  const minInt = (intPat.match(/0/g) ?? []).length;
  const maxFrac = fracPat.replace(/[^#0]/g, '').length;
  const minFrac = (fracPat.match(/0/g) ?? []).length;
  const neg = value < 0;
  const factor = 10 ** maxFrac;
  // Round magnitude HALF_UP at the pattern's precision (epsilon fights fp error).
  const rounded = Math.round(Math.abs(value) * factor + 1e-9) / factor;
  let [ip, fp = ''] = rounded.toFixed(maxFrac).split('.');
  if (maxFrac > 0) {
    let keep = fp.length;
    while (keep > minFrac && fp[keep - 1] === '0') keep--; // drop optional trailing zeros
    fp = fp.slice(0, keep);
  } else fp = '';
  ip = ip.replace(/^0+/, '');
  while (ip.length < minInt) ip = '0' + ip;
  if (ip === '') ip = '0'; // always render at least one integer digit
  if (grouping > 0 && ip.length > grouping) {
    const parts: string[] = [];
    let i = ip.length;
    while (i > grouping) { parts.unshift(ip.slice(i - grouping, i)); i -= grouping; }
    parts.unshift(ip.slice(0, i));
    ip = parts.join(',');
  }
  const out = ip + (fp.length > 0 || minFrac > 0 ? '.' + fp : '');
  const isZero = !/[1-9]/.test(out);
  return (neg && !isZero ? '-' : '') + out;
}

/**
 * Resolve a `str.format`/`str.tostring` number-format specifier to a string.
 * Handles the named specifiers documented in the manual (`integer`, `percent`,
 * `currency`) and otherwise treats `spec` as a DecimalFormat pattern. `currency`
 * uses `$#,##0.00` and `percent` scales by 100 (0.5 → "50%"), both per the manual
 * (`{0,number,currency}`,1.34 → "$1.34"; `{0,number,percent}`,0.5 → "50%").
 */
function formatNumberSpec(value: number, spec: string): string {
  if (isNa(value)) return 'NaN';
  const s = spec.trim();
  switch (s) {
    case 'integer': return formatNumberPattern(value, '#');
    case 'percent': return formatNumberPattern(value * 100, '#.###') + '%';
    case 'currency': return '$' + formatNumberPattern(value, '#,##0.00');
    default: return formatNumberPattern(value, s);
  }
}

/** True when a `str.tostring` second argument is a numeric-format pattern. */
function isNumberPattern(fmt: string): boolean {
  return /[#0]/.test(fmt);
}

/**
 * `format.volume`: abbreviate with K / M / B / T like TradingView's volume axis.
 * The scaled mantissa shows up to 3 fractional digits (trailing zeros trimmed);
 * magnitudes below 1000 render as a rounded integer (e.g. 873.94 → "874",
 * 16218.78 → "16.219K", 3983.67 → "3.984K", 8.41e6 → "8.41M").
 */
function formatVolume(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [base, suffix] of units) {
    if (abs >= base) {
      const mantissa = (abs / base).toFixed(3).replace(/\.?0+$/, '');
      return sign + mantissa + suffix;
    }
  }
  return sign + String(Math.round(abs));
}

export const StrNs = {
  /**
   * String representation of `x`. When `fmt` is a DecimalFormat-style pattern
   * (contains `#` or `0`), numbers are formatted with it (e.g. `'#.000'`,
   * `'0.00'`, `'#,##0.##'`); `format.mintick` rounds to the symbol mintick
   * (0.01) with trailing zeros. Otherwise the plain string form is returned,
   * matching the default `String(x)` behavior. `na` → "NaN".
   */
  tostring(x: unknown, fmt?: string): string {
    if (isNa(x)) return 'NaN';
    if (typeof x === 'number' && typeof fmt === 'string') {
      if (fmt === 'mintick') return formatNumberPattern(Math.round(x / 0.01) * 0.01, '0.00');
      if (fmt === 'volume') return formatVolume(x);
      if (isNumberPattern(fmt)) return formatNumberPattern(x, fmt);
    }
    return String(x);
  },
  length(s: string): number {
    return isNa(s) ? NaN : String(s).length;
  },
  contains(s: string, sub: string): boolean {
    return isNa(s) ? false : String(s).includes(sub);
  },
  /**
   * Format `args` into `fmt`. Each `{index}` placeholder is replaced by the
   * plain string form of that argument; `{index,number,spec}` applies a
   * number-format specifier (a DecimalFormat pattern like `#.#`/`0.00`, or one
   * of `integer`/`percent`/`currency`). Whitespace around the index/keyword/spec
   * is tolerated (`{0, number, #.#}`). `''` is an escaped literal single quote
   * and text inside a single-quoted run is emitted verbatim (so `'{0}'` is the
   * literal "{0}"), per the manual's pattern rules.
   */
  format(fmt: string, ...args: unknown[]): string {
    if (isNa(fmt)) return NA as unknown as string;
    const src = String(fmt);
    let out = '';
    for (let i = 0; i < src.length; ) {
      const c = src[i];
      if (c === "'") {
        if (src[i + 1] === "'") { out += "'"; i += 2; continue; }
        i++;
        while (i < src.length && src[i] !== "'") { out += src[i]; i++; }
        i++; // skip closing quote
        continue;
      }
      if (c === '{') {
        const end = src.indexOf('}', i);
        if (end < 0) { out += c; i++; continue; }
        const body = src.slice(i + 1, end);
        const parts = body.split(',');
        const idx = Number(parts[0].trim());
        const arg = args[idx];
        if (parts.length >= 3 && parts[1].trim() === 'number' && typeof arg === 'number') {
          out += formatNumberSpec(arg, parts.slice(2).join(',').trim());
        } else if (parts.length === 1 && Number.isInteger(idx)) {
          out += isNa(arg) ? 'NaN' : String(arg);
        } else {
          // Unrecognized specifier: fall back to the plain argument value.
          out += isNa(arg) ? 'NaN' : String(arg ?? '');
        }
        i = end + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  },
  /** Divide a string into an array of substrings around each `separator`. */
  split(s: string, separator: string): string[] {
    if (isNa(s)) return [];
    return String(s).split(separator);
  },
  /**
   * Replace the `occurrence`-th (0-based) match of `target` with `replacement`.
   * Pine counts occurrences from the left; other matches are left untouched.
   * Returns the source unchanged when there are fewer matches than requested.
   */
  replace(s: string, target: string, replacement: string, occurrence = 0): string {
    if (isNa(s)) return NA as unknown as string;
    const src = String(s);
    if (target === '') return src;
    let from = 0;
    let n = 0;
    for (;;) {
      const idx = src.indexOf(target, from);
      if (idx < 0) return src;
      if (n === occurrence) {
        return src.slice(0, idx) + replacement + src.slice(idx + target.length);
      }
      n++;
      from = idx + target.length;
    }
  },
  /** Replace every occurrence of `target` with `replacement`. */
  replace_all(s: string, target: string, replacement: string): string {
    if (isNa(s)) return NA as unknown as string;
    const src = String(s);
    if (target === '') return src;
    return src.split(target).join(replacement);
  },
  /**
   * Substring from `begin_pos` to `end_pos - 1` (0-based). When `end_pos`
   * is omitted the substring extends to the end of the source.
   */
  substring(s: string, begin_pos: number, end_pos?: number): string {
    if (isNa(s)) return NA as unknown as string;
    const src = String(s);
    return end_pos === undefined ? src.slice(begin_pos) : src.slice(begin_pos, end_pos);
  },
  upper(s: string): string {
    return isNa(s) ? (NA as unknown as string) : String(s).toUpperCase();
  },
  lower(s: string): string {
    return isNa(s) ? (NA as unknown as string) : String(s).toLowerCase();
  },
  startswith(s: string, str: string): boolean {
    return isNa(s) ? false : String(s).startsWith(str);
  },
  endswith(s: string, str: string): boolean {
    return isNa(s) ? false : String(s).endsWith(str);
  },
  /** Position of the first occurrence of `str` in `s`, or na if absent. */
  pos(s: string, str: string): number {
    if (isNa(s)) return NaN;
    const idx = String(s).indexOf(str);
    return idx < 0 ? NaN : idx;
  },
  /**
   * Trim consecutive whitespace and control characters from both ends.
   * Returns "" if the result is empty or the source is na. The range
   * \x00-\x20 covers spaces, tabs, newlines and the C0 control chars.
   */
  trim(s: string): string {
    if (isNa(s)) return '';
    return String(s).replace(/^[\s\x00-\x20]+|[\s\x00-\x20]+$/g, '');
  },
  /** Repeat `s` `count` times, injecting `separator` between copies. */
  repeat(s: string, count: number, separator = ''): string {
    if (isNa(s)) return NA as unknown as string;
    if (count <= 0) return '';
    return new Array(count).fill(String(s)).join(separator);
  },
  /**
   * First substring of `s` matching the regex `regex`, or "" if none.
   * Pine returns an empty string when there is no match.
   */
  match(s: string, regex: string): string {
    if (isNa(s)) return NA as unknown as string;
    const m = String(s).match(new RegExp(regex));
    return m ? m[0] : '';
  },
  /** Parse `s` to a float; na when it is not a valid number. */
  tonumber(s: unknown): number {
    if (isNa(s)) return NaN;
    if (typeof s === 'number') return s;
    const str = String(s).trim();
    if (str === '') return NaN;
    const n = Number(str);
    return Number.isNaN(n) ? NaN : n;
  },
  /**
   * Format an epoch-ms timestamp using Java/Pine-style tokens.
   * Defaults to ISO-8601 ("yyyy-MM-dd'T'HH:mm:ssZ") in UTC. Supports
   * yyyy/yy, MM/M, dd/d, HH/H, mm/m, ss/s plus 'quoted literal' text.
   * Computations use UTC getters on a copy shifted by the timezone offset;
   * the trailing Z token renders that offset (e.g. +0000 for UTC).
   */
  format_time(time: number, format = "yyyy-MM-dd'T'HH:mm:ssZ", timezone = 'UTC'): string {
    if (isNa(time)) return NA as unknown as string;
    const { year, month, day, hour, minute, second, offMin } = tzWallClock(time, timezone);
    const millis = ((time % 1000) + 1000) % 1000;
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const zSign = offMin >= 0 ? '+' : '-';
    const zAbs = Math.abs(offMin);
    const zStr = zSign + pad(Math.floor(zAbs / 60), 2) + pad(zAbs % 60, 2);
    let out = '';
    for (let i = 0; i < format.length; ) {
      const c = format[i];
      if (c === "'") {
        // Quoted literal; '' is an escaped single quote.
        if (format[i + 1] === "'") { out += "'"; i += 2; continue; }
        i++;
        while (i < format.length && format[i] !== "'") { out += format[i]; i++; }
        i++;
        continue;
      }
      // Greedily consume a run of the same token character.
      let j = i + 1;
      while (j < format.length && format[j] === c) j++;
      const run = j - i;
      switch (c) {
        case 'y': out += run <= 2 ? pad(year % 100, 2) : pad(year, run); break;
        case 'M': out += run >= 2 ? pad(month, 2) : String(month); break;
        case 'd': out += run >= 2 ? pad(day, 2) : String(day); break;
        case 'H': out += run >= 2 ? pad(hour, 2) : String(hour); break;
        case 'h': out += run >= 2 ? pad(hour12, 2) : String(hour12); break;
        case 'm': out += run >= 2 ? pad(minute, 2) : String(minute); break;
        case 's': out += run >= 2 ? pad(second, 2) : String(second); break;
        case 'S': out += pad(millis, 3).slice(0, run); break; // fractions of a second
        case 'a': out += hour < 12 ? 'AM' : 'PM'; break;
        case 'Z': out += zStr; break;
        default: out += c.repeat(run); break;
      }
      i = j;
    }
    return out;
  },
};

/** Wall-clock parts of an epoch-ms instant in a timezone, plus its UTC offset. */
interface WallClock {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  offMin: number;
}

/**
 * Parse a fixed-offset timezone string to minutes from UTC, or null if it is
 * not a fixed-offset form. Supports "UTC"/"GMT"/"Z" (0), "UTC±HH:mm",
 * "GMT±HHmm" and bare "±HH:mm"/"±H".
 */
function fixedOffsetMinutes(t: string): number | null {
  const cached = FIXED_OFFSET_MINUTES_CACHE.get(t);
  if (cached !== undefined) return cached;
  if (t === '' || /^(UTC|GMT|Z)$/i.test(t)) return 0;
  const m = t.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) {
    FIXED_OFFSET_MINUTES_CACHE.set(t, null);
    return null;
  }
  const sign = m[1] === '-' ? -1 : 1;
  const offset = sign * (Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0));
  FIXED_OFFSET_MINUTES_CACHE.set(t, offset);
  return offset;
}

/**
 * Compute the wall-clock parts of `time` (epoch ms) in `timezone`.
 * Fixed-offset zones ("UTC", "GMT+5", "UTC-3:30", "+09:00") shift the instant
 * by a constant offset. IANA names ("America/New_York", "Asia/Tokyo") are
 * resolved with Intl.DateTimeFormat so DST is honored; the offset for the `Z`
 * token is read from the same zone via the `longOffset` part. Unknown zones
 * fall back to UTC.
 */
function tzWallClock(time: number, timezone: string): WallClock {
  const t = isNa(timezone) ? 'UTC' : String(timezone).trim();
  const fixed = fixedOffsetMinutes(t);
  if (fixed !== null) {
    const local = new Date(time + fixed * 60000);
    return {
      year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(),
      hour: local.getUTCHours(), minute: local.getUTCMinutes(), second: local.getUTCSeconds(),
      offMin: fixed,
    };
  }
  try {
    let dtf = WALL_CLOCK_FORMATTER_CACHE.get(t);
    if (!dtf) {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: t, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
      });
      WALL_CLOCK_FORMATTER_CACHE.set(t, dtf);
    }
    const m: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(time))) m[p.type] = p.value;
    // longOffset is like "GMT-05:00" / "GMT+9" / "GMT" (UTC). Parse to minutes.
    const off = m.timeZoneName ? fixedOffsetMinutes(m.timeZoneName.replace(/^GMT/i, 'GMT')) : 0;
    return {
      year: Number(m.year), month: Number(m.month), day: Number(m.day),
      hour: Number(m.hour) % 24, minute: Number(m.minute), second: Number(m.second),
      offMin: off ?? 0,
    };
  } catch {
    // Unknown/invalid zone: treat as UTC.
    const local = new Date(time);
    return {
      year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(),
      hour: local.getUTCHours(), minute: local.getUTCMinutes(), second: local.getUTCSeconds(),
      offMin: 0,
    };
  }
}
export type StrNamespace = typeof StrNs;
