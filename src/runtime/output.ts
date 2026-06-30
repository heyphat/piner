/**
 * OutputCollector — the complete, serializable VISUAL IR (docs/implementation-plan
 * Phase 6.6). Everything a renderer needs to draw a Pine script's visuals:
 * plots (with per-bar color), markers (plotshape/char/arrow), candle overlays
 * (plotcandle/plotbar), hlines, fills, and per-bar bar/background coloring — all
 * plain data so it serializes cleanly across a worker boundary.
 *
 * Values are indexed by bar index, so re-executing the realtime bar overwrites the
 * same slot (no explicit "drop uncommitted" pass needed).
 */

export interface PlotSeries {
  id: number;
  title: string;
  data: number[];
  /** Per-bar color (#RRGGBBAA) or null to use the default; sparse-filled. */
  colors: (string | null)[];
  options: Record<string, unknown>;
}

export interface MarkerPoint {
  color?: string | null;
  text?: string;
}
export interface MarkerSeries {
  id: number;
  title: string;
  kind: 'shape' | 'char' | 'arrow';
  /** abovebar | belowbar | top | bottom | absolute. */
  location: string;
  /** shape name (shape.*) or character (plotchar). */
  glyph: string;
  /** One entry per bar where the marker is shown; null when hidden. */
  data: (MarkerPoint | null)[];
}

export interface OHLC { open: number; high: number; low: number; close: number; }
export interface CandleSeries {
  id: number;
  title: string;
  data: (OHLC | null)[];
  colors: (string | null)[];
  wickColors: (string | null)[];
  borderColors: (string | null)[];
}

export interface HLine {
  id: number;
  price: number;
  title: string;
}

export interface FillGradient {
  topValue: number[];
  bottomValue: number[];
  topColor: (string | null)[];
  bottomColor: (string | null)[];
}
export interface FillRegion {
  id: number;
  /** Ids of the two bounding plots/hlines (look up in `plots`/`hlines`). */
  plot1: number;
  plot2: number;
  title: string;
  /** Static color, or null when per-bar `colors` / `gradient` is used. */
  color: string | null;
  /** Per-bar fill color (sparse); takes precedence over `color` where present. */
  colors: (string | null)[];
  /** Per-bar vertical gradient (fill with top_value/bottom_value + colors). */
  gradient?: FillGradient;
}

export interface AlertEvent {
  bar: number;
  message: string;
}

/** A `request.security` / `request.security_lower_tf` data dependency a script asked for.
 *  A host (fractal) reads these after a discovery run to know which symbol/timeframe bars to
 *  fetch + inject (piner never fetches). `lowerTf` distinguishes the intrabar variant. */
export interface SecurityRequest {
  symbol: string;
  timeframe: string;
  lowerTf: boolean;
}

export class OutputCollector {
  readonly plots = new Map<number, PlotSeries>();
  readonly markers = new Map<number, MarkerSeries>();
  readonly candles = new Map<number, CandleSeries>();
  readonly hlines = new Map<number, HLine>();
  readonly fills = new Map<number, FillRegion>();
  readonly alerts: AlertEvent[] = [];
  /** request.security[_lower_tf] data dependencies (deduped), for host-side fetch + inject. */
  readonly securityRequests: SecurityRequest[] = [];
  recordSecurityRequest(symbol: string, timeframe: string, lowerTf: boolean): void {
    if (this.securityRequests.some((r) => r.symbol === symbol && r.timeframe === timeframe && r.lowerTf === lowerTf)) {
      return;
    }
    this.securityRequests.push({ symbol, timeframe, lowerTf });
  }
  /** Per-bar bar coloring layers (barcolor), keyed by call-site id. */
  readonly barColors = new Map<number, (string | null)[]>();
  /** Per-bar background coloring layers (bgcolor), keyed by call-site id. */
  readonly bgColors = new Map<number, (string | null)[]>();

  // ── plot ──────────────────────────────────────────────────
  declarePlot(id: number, title: string, options: Record<string, unknown> = {}): void {
    if (!this.plots.has(id)) this.plots.set(id, { id, title, data: [], colors: [], options });
  }
  plot(id: number, bar: number, value: number, color?: string | null): void {
    const s = this.plots.get(id);
    if (!s) return;
    s.data[bar] = value;
    if (color !== undefined) s.colors[bar] = color;
  }

  // ── markers (plotshape / plotchar / plotarrow) ────────────
  declareMarker(id: number, title: string, kind: MarkerSeries['kind'], location: string, glyph: string): void {
    if (!this.markers.has(id)) this.markers.set(id, { id, title, kind, location, glyph, data: [] });
  }
  marker(id: number, bar: number, on: boolean, point: MarkerPoint): void {
    const s = this.markers.get(id);
    if (s) s.data[bar] = on ? point : null;
  }

  // ── candle overlays (plotcandle / plotbar) ────────────────
  declareCandle(id: number, title: string): void {
    if (!this.candles.has(id)) this.candles.set(id, { id, title, data: [], colors: [], wickColors: [], borderColors: [] });
  }
  candle(id: number, bar: number, ohlc: OHLC | null, color?: string | null, wick?: string | null, border?: string | null): void {
    const s = this.candles.get(id);
    if (!s) return;
    s.data[bar] = ohlc;
    if (color !== undefined) s.colors[bar] = color;
    if (wick !== undefined) s.wickColors[bar] = wick;
    if (border !== undefined) s.borderColors[bar] = border;
  }

  // ── hline / fill ──────────────────────────────────────────
  hline(id: number, price: number, title: string): void {
    if (!this.hlines.has(id)) this.hlines.set(id, { id, price, title });
  }
  declareFill(id: number, plot1: number, plot2: number, title: string, color: string | null): void {
    if (!this.fills.has(id)) this.fills.set(id, { id, plot1, plot2, title, color, colors: [] });
  }
  fillColor(id: number, bar: number, color: string | null): void {
    const s = this.fills.get(id);
    if (s && color != null) s.colors[bar] = color;
  }
  fillGradientPoint(id: number, bar: number, topValue: number, bottomValue: number, topColor: string | null, bottomColor: string | null): void {
    const s = this.fills.get(id);
    if (!s) return;
    if (!s.gradient) s.gradient = { topValue: [], bottomValue: [], topColor: [], bottomColor: [] };
    s.gradient.topValue[bar] = topValue;
    s.gradient.bottomValue[bar] = bottomValue;
    s.gradient.topColor[bar] = topColor;
    s.gradient.bottomColor[bar] = bottomColor;
  }

  // ── bar / background coloring ─────────────────────────────
  barcolor(id: number, bar: number, color: string | null): void {
    let layer = this.barColors.get(id);
    if (!layer) this.barColors.set(id, (layer = []));
    layer[bar] = color;
  }
  bgcolor(id: number, bar: number, color: string | null): void {
    let layer = this.bgColors.get(id);
    if (!layer) this.bgColors.set(id, (layer = []));
    layer[bar] = color;
  }

  alert(bar: number, message: string): void {
    this.alerts.push({ bar, message });
  }
}
