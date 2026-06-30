/**
 * color.* — color construction and named constants. Colors are represented as
 * normalized `#RRGGBBAA` strings (alpha derived from Pine's 0-100 transparency).
 */
import { NA, isNa } from '../series.js';

function hex2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, '0').toUpperCase();
}
function alphaFromTransp(transp: number): string {
  // Pine transparency: 0 = opaque, 100 = fully transparent.
  const a = Math.round((1 - Math.max(0, Math.min(100, transp)) / 100) * 255);
  return hex2(a);
}

// Parse a normalized `#RRGGBBAA` string into its four 0-255 channels.
// Returns null for na/invalid colors so callers can yield na-equivalents.
function parse(c: unknown): { r: number; g: number; b: number; a: number } | null {
  if (isNa(c) || typeof c !== 'string') return null;
  const hex = c.startsWith('#') ? c.slice(1) : c;
  if (hex.length < 6) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Alpha is optional in malformed input; default to fully opaque (FF).
  const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
  return { r, g, b, a };
}

const base = (rgb: string) => `#${rgb}FF`;

export const ColorNs = {
  new(col: string, transp: number): string | typeof NA {
    // color.new(na, …) is na in Pine. from_gradient and others yield the NA sentinel
    // (not null), so guard on isNa/non-string rather than `??` to avoid a .slice crash.
    if (isNa(col) || typeof col !== 'string') return NA;
    const rgb = col.slice(1, 7);
    return `#${rgb}${alphaFromTransp(transp)}`;
  },
  rgb(r: number, g: number, b: number, transp = 0): string {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${alphaFromTransp(transp)}`;
  },
  // channel getters — return na (NaN) for na/invalid colors.
  r(col: string): number {
    const p = parse(col);
    return p === null ? NaN : p.r;
  },
  g(col: string): number {
    const p = parse(col);
    return p === null ? NaN : p.g;
  },
  b(col: string): number {
    const p = parse(col);
    return p === null ? NaN : p.b;
  },
  t(col: string): number {
    // Transparency: AA=FF → 0 (opaque), AA=00 → 100 (fully transparent).
    const p = parse(col);
    return p === null ? NaN : Math.round((1 - p.a / 255) * 100);
  },
  from_gradient(
    value: number,
    bottom_value: number,
    top_value: number,
    bottom_color: string,
    top_color: string,
  ): string | typeof NA {
    const bot = parse(bottom_color);
    const top = parse(top_color);
    if (bot === null || top === null) return NA;
    if (isNa(value) || isNa(bottom_value) || isNa(top_value)) return NA;
    const span = top_value - bottom_value;
    // Relative position clamped to [0, 1]; a zero-width range pins to the top color.
    const raw = span === 0 ? 1 : (value - bottom_value) / span;
    const f = Math.max(0, Math.min(1, raw));
    // RGB channels interpolate directly in 0-255 byte space.
    const lerp = (a: number, b: number) => a + (b - a) * f;
    // Transparency channel: TradingView/PineTS interpolate the 0..255 alpha in
    // normalized (a/255) space, and `color.t` reports round((1 - a/255) * 100).
    // To make the result round-trip against that mapping, derive each endpoint's
    // transparency the way `t` does, rebuild its canonical alpha byte, then
    // interpolate the normalized alphas (matching PineTS's float arithmetic,
    // which rounds differently than raw byte-space lerp at .5 boundaries).
    const transp = (a: number) => Math.round((1 - a / 255) * 100);
    const alphaByte = (t: number) => Math.round((255 / 100) * (100 - t));
    const a0 = alphaByte(transp(bot.a)) / 255;
    const a1 = alphaByte(transp(top.a)) / 255;
    const aOut = Math.round((a0 + (a1 - a0) * f) * 255);
    return `#${hex2(lerp(bot.r, top.r))}${hex2(lerp(bot.g, top.g))}${hex2(lerp(bot.b, top.b))}${hex2(aOut)}`;
  },
  // named constants — TradingView Pine v6 palette (per v6 reference manual)
  red: base('F23645'),
  green: base('4CAF50'),
  blue: base('2962FF'),
  orange: base('FF9800'),
  purple: base('9C27B0'),
  yellow: base('FDD835'),
  white: base('FFFFFF'),
  black: base('363A45'),
  gray: base('787B86'),
  silver: base('B2B5BE'),
  lime: base('00E676'),
  maroon: base('880E4F'),
  navy: base('311B92'),
  olive: base('808000'),
  teal: base('089981'),
  aqua: base('00BCD4'),
  fuchsia: base('E040FB'),
};
export type ColorNamespace = typeof ColorNs;
