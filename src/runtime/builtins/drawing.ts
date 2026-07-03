/**
 * Drawing objects — line / label / box / table (docs/architecture.md §7).
 *
 * Unlike plots (per-bar values) these are mutable handles with a create→mutate→
 * delete lifecycle. They live in a pooled store keyed by integer id; the script
 * holds the id (a number) in a variable. The pool AND its id counter are part of
 * the realtime rollback snapshot, so re-executing a developing bar re-allocates
 * the same ids and reproduces mutations deterministically (repaint).
 *
 * Constructors take required coordinates positionally and accept an `opts` object
 * (built from named arguments by the backends) for styling.
 */
import { NA } from '../series.js';

export type DrawType = 'line' | 'label' | 'box' | 'table' | 'linefill' | 'polyline';

export interface DrawObject {
  id: number;
  type: DrawType;
  props: Record<string, unknown>;
}

export class DrawingPool {
  objects = new Map<number, DrawObject>();
  private nextId = 1;
  /**
   * Per-type live-object caps (from indicator()'s max_lines_count / max_labels_count /
   * max_boxes_count / max_polylines_count). TradingView keeps only the most recent N
   * drawings of each type and auto-deletes the oldest; without this the pool grows
   * unbounded over history (e.g. a session script that draws a few lines per day),
   * so the host re-renders thousands of objects every frame. undefined ⇒ uncapped.
   */
  caps: Partial<Record<DrawType, number>> = {};

  /** Set the per-type caps from the compiled script's metadata (call once at setup). */
  setCaps(caps: Partial<Record<DrawType, number>>): void {
    this.caps = caps;
  }

  create(type: DrawType, props: Record<string, unknown>): number {
    const id = this.nextId++;
    this.objects.set(id, { id, type, props: { ...props } });
    const cap = this.caps[type];
    if (cap !== undefined && cap > 0) {
      // Count live objects of this type and find the oldest (Map preserves insertion
      // order and ids are monotonic, so the first match is the oldest). Over the cap →
      // evict the oldest, mirroring TradingView's most-recent-N retention (FIFO).
      let count = 0;
      let oldest = -1;
      for (const o of this.objects.values()) {
        if (o.type === type) {
          count++;
          if (oldest < 0) oldest = o.id;
        }
      }
      if (count > cap && oldest >= 0) this.objects.delete(oldest);
    }
    return id;
  }
  set(id: number, key: string, value: unknown): void {
    const o = this.objects.get(id);
    if (o) o.props[key] = value;
  }
  get(id: number, key: string): unknown {
    const o = this.objects.get(id);
    return o && key in o.props ? o.props[key] : NA;
  }
  remove(id: number): void {
    this.objects.delete(id);
  }
  /** Clone the object at `id` into a NEW pooled object (independent deep-copied
   * props) and return the new id. Returns NaN if the source is absent. */
  copy(id: number): number {
    const o = this.objects.get(id);
    if (!o) return NaN;
    return this.create(o.type, structuredClone(o.props));
  }

  snapshot(): { objects: Map<number, DrawObject>; nextId: number } {
    return { objects: structuredClone(this.objects), nextId: this.nextId };
  }
  restore(s: { objects: Map<number, DrawObject>; nextId: number }): void {
    this.objects = structuredClone(s.objects);
    this.nextId = s.nextId;
  }
}

type Opts = Record<string, unknown>;

/** A chart.point record: `{ time, index, price }` (chart.point.* constructors). */
type ChartPoint = { time?: number; index?: number; price?: number };

/**
 * Resolve the x-coordinate of `point` for the object at `id`. Drawings store an
 * `xloc` prop (default `bar_index`): with `xloc.bar_time` the x-coordinate comes
 * from `point.time`, otherwise from `point.index`. Mirrors how Pine's *_point
 * setters pick a point field based on the drawing's xloc.
 */
const pointX = (pool: DrawingPool, id: number, point: ChartPoint): unknown => {
  const o = pool.objects.get(id);
  const xloc = o ? o.props.xloc : undefined;
  return xloc === 'bar_time' ? point?.time : point?.index;
};

/** A chart.point argument (an object carrying a `price`) — vs scalar coords or an options object. */
const isPoint = (v: unknown): v is ChartPoint =>
  v != null && typeof v === 'object' && !Array.isArray(v) && 'price' in (v as object);
/** A point's x per the drawing's xloc (bar_time → time, else index). */
const pxOf = (p: ChartPoint, byTime: boolean): unknown => (byTime ? p.time : p.index);

/**
 * Collect a point-overload's trailing args into one options object. Pine's point form is
 * `line.new(p1, p2, xloc?, extend?, …named)` — but codegen maps params positionally as
 * (x1, y1, x2, y2, opts) and bundles the named args into a trailing object, so a positional
 * xloc lands in the x2 slot and the named-options object in the y2 slot. Scan every trailing
 * slot: merge any options object and pick up positional xloc/extend strings (later wins). This
 * is what lets `line.new(p1, p2, xloc.bar_time, color=…, style=…)` keep BOTH its xloc and color.
 */
const pointOpts = (...rest: unknown[]): Opts => {
  const o: Opts = {};
  for (const a of rest) {
    if (a == null) continue;
    if (typeof a === 'object' && !isPoint(a)) Object.assign(o, a as Opts);
    else if (a === 'bar_time' || a === 'bar_index') o.xloc = a;
    else if (a === 'none' || a === 'left' || a === 'right' || a === 'both') o.extend = a;
  }
  return o;
};

/** Live ids of all objects of a given type (line.all / label.all / box.all / …). */
const allOf = (pool: DrawingPool, type: DrawType) =>
  [...pool.objects.values()].filter((o) => o.type === type).map((o) => o.id);
const drop = (props: Opts) => {
  // strip undefined positional placeholders so `key in props` stays accurate
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
};

/** line.* — coords are bar_index/time (x) and price (y). */
export function makeLineNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'line');
    },
    // line.style_* — opaque identity tags (const string) for line.new / set_style.
    style_solid: 'solid',
    style_dotted: 'dotted',
    style_dashed: 'dashed',
    style_arrow_left: 'arrow_left',
    style_arrow_right: 'arrow_right',
    style_arrow_both: 'arrow_both',
    new(x1: unknown, y1: unknown, x2?: unknown, y2?: unknown, opts: Opts = {}): number {
      // Two-point overload: line.new(first_point, second_point, xloc?, extend?, …opts). The
      // trailing args (xloc/extend strings and/or the options object) may land in the x2/y2/opts
      // slots depending on how many were positional — pointOpts gathers them all.
      if (isPoint(x1) && isPoint(y1)) {
        const o = pointOpts(x2, y2, opts);
        const byTime = o.xloc === 'bar_time';
        return pool.create(
          'line',
          drop({ x1: pxOf(x1, byTime), y1: x1.price, x2: pxOf(y1, byTime), y2: y1.price, ...o }),
        );
      }
      return pool.create('line', drop({ x1, y1, x2, y2, ...opts }));
    },
    copy(id: number): number {
      return pool.copy(id);
    },
    set_xy1(id: number, x: number, y: number): void {
      pool.set(id, 'x1', x);
      pool.set(id, 'y1', y);
    },
    set_xy2(id: number, x: number, y: number): void {
      pool.set(id, 'x2', x);
      pool.set(id, 'y2', y);
    },
    // *_point setters take a chart.point; x comes from index/time per the line's xloc, y from price.
    set_first_point(id: number, point: ChartPoint): void {
      pool.set(id, 'x1', pointX(pool, id, point));
      pool.set(id, 'y1', point?.price);
    },
    set_second_point(id: number, point: ChartPoint): void {
      pool.set(id, 'x2', pointX(pool, id, point));
      pool.set(id, 'y2', point?.price);
    },
    set_x1(id: number, x: number): void {
      pool.set(id, 'x1', x);
    },
    set_y1(id: number, y: number): void {
      pool.set(id, 'y1', y);
    },
    set_x2(id: number, x: number): void {
      pool.set(id, 'x2', x);
    },
    set_y2(id: number, y: number): void {
      pool.set(id, 'y2', y);
    },
    set_color(id: number, c: string): void {
      pool.set(id, 'color', c);
    },
    set_width(id: number, w: number): void {
      pool.set(id, 'width', w);
    },
    set_style(id: number, s: string): void {
      pool.set(id, 'style', s);
    },
    set_extend(id: number, e: string): void {
      pool.set(id, 'extend', e);
    },
    // set_xloc updates both x coords and the xloc property in one call.
    set_xloc(id: number, x1: number, x2: number, xloc: string): void {
      pool.set(id, 'x1', x1);
      pool.set(id, 'x2', x2);
      pool.set(id, 'xloc', xloc);
    },
    get_x1(id: number): unknown {
      return pool.get(id, 'x1');
    },
    get_y1(id: number): unknown {
      return pool.get(id, 'y1');
    },
    get_x2(id: number): unknown {
      return pool.get(id, 'x2');
    },
    get_y2(id: number): unknown {
      return pool.get(id, 'y2');
    },
    // Price on the line at bar x via linear interpolation through its two points
    // (the line is treated as extend.both, so x may fall outside [x1, x2]).
    get_price(id: number, x: number): number {
      const o = pool.objects.get(id);
      if (!o) return NaN;
      const x1 = o.props.x1 as number,
        y1 = o.props.y1 as number;
      const x2 = o.props.x2 as number,
        y2 = o.props.y2 as number;
      if (
        typeof x1 !== 'number' ||
        typeof y1 !== 'number' ||
        typeof x2 !== 'number' ||
        typeof y2 !== 'number'
      )
        return NaN;
      if (x2 === x1) return y1; // vertical line: degenerate slope
      return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** label.* — a point annotation with text. */
export function makeLabelNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'label');
    },
    // label.style_* — opaque identity tags (const string) for label.new / set_style.
    style_none: 'none',
    style_xcross: 'xcross',
    style_cross: 'cross',
    style_triangleup: 'triangleup',
    style_triangledown: 'triangledown',
    style_flag: 'flag',
    style_circle: 'circle',
    style_arrowup: 'arrowup',
    style_arrowdown: 'arrowdown',
    style_label_up: 'label_up',
    style_label_down: 'label_down',
    style_label_left: 'label_left',
    style_label_right: 'label_right',
    style_label_lower_left: 'label_lower_left',
    style_label_lower_right: 'label_lower_right',
    style_label_upper_left: 'label_upper_left',
    style_label_upper_right: 'label_upper_right',
    style_label_center: 'label_center',
    style_square: 'square',
    style_diamond: 'diamond',
    style_text_outline: 'text_outline',
    new(x: unknown, y: unknown, text: unknown = '', opts: Opts = {}): number {
      // Point overload: label.new(point, text, xloc?, opts?). Pine has an overload
      // taking a chart.point instead of (x, y); the text shifts into the `y` slot and
      // the optional xloc into the `text` slot. Without this, structure/swing labels
      // (BOS/CHoCH, HH/LL, EQH/EQL) rendered the literal "bar_index" at a NaN y.
      if (isPoint(x)) {
        const xlocVal =
          typeof text === 'string' && text !== ''
            ? text
            : typeof opts.xloc === 'string'
              ? opts.xloc
              : 'bar_index';
        const byTime = xlocVal === 'bar_time';
        const labelText = typeof y === 'string' ? y : y == null ? '' : String(y);
        return pool.create(
          'label',
          drop({ x: pxOf(x, byTime), y: x.price, text: labelText, xloc: xlocVal, ...opts }),
        );
      }
      return pool.create('label', drop({ x, y, text, ...opts }));
    },
    copy(id: number): number {
      return pool.copy(id);
    },
    set_xy(id: number, x: number, y: number): void {
      pool.set(id, 'x', x);
      pool.set(id, 'y', y);
    },
    set_x(id: number, x: number): void {
      pool.set(id, 'x', x);
    },
    set_y(id: number, y: number): void {
      pool.set(id, 'y', y);
    },
    // set_point takes a chart.point; x comes from index/time per the label's xloc, y from price.
    set_point(id: number, point: ChartPoint): void {
      pool.set(id, 'x', pointX(pool, id, point));
      pool.set(id, 'y', point?.price);
    },
    set_text(id: number, t: string): void {
      pool.set(id, 'text', t);
    },
    set_textalign(id: number, align: string): void {
      pool.set(id, 'textalign', align);
    },
    set_tooltip(id: number, tooltip: string): void {
      pool.set(id, 'tooltip', tooltip);
    },
    set_text_formatting(id: number, fmt: unknown): void {
      pool.set(id, 'text_formatting', fmt);
    },
    set_color(id: number, c: string): void {
      pool.set(id, 'color', c);
    },
    set_textcolor(id: number, c: string): void {
      pool.set(id, 'textcolor', c);
    },
    set_style(id: number, s: string): void {
      pool.set(id, 'style', s);
    },
    set_size(id: number, s: string): void {
      pool.set(id, 'size', s);
    },
    set_text_font_family(id: number, family: string): void {
      pool.set(id, 'text_font_family', family);
    },
    set_yloc(id: number, yloc: string): void {
      pool.set(id, 'yloc', yloc);
    },
    // set_xloc updates the x coord and the xloc property in one call.
    set_xloc(id: number, x: number, xloc: string): void {
      pool.set(id, 'x', x);
      pool.set(id, 'xloc', xloc);
    },
    get_x(id: number): unknown {
      return pool.get(id, 'x');
    },
    get_y(id: number): unknown {
      return pool.get(id, 'y');
    },
    get_text(id: number): unknown {
      return pool.get(id, 'text');
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** box.* — a rectangle between (left, top) and (right, bottom). */
export function makeBoxNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'box');
    },
    new(left: unknown, top: unknown, right?: unknown, bottom?: unknown, opts: Opts = {}): number {
      // Two-point overload: box.new(top_left, bottom_right, xloc?, extend?, …opts). The trailing
      // args (xloc/extend strings and/or the options object) may land in the right/bottom/opts
      // slots depending on how many were positional — pointOpts gathers them all.
      if (isPoint(left) && isPoint(top)) {
        const o = pointOpts(right, bottom, opts);
        const byTime = o.xloc === 'bar_time';
        return pool.create(
          'box',
          drop({
            left: pxOf(left, byTime),
            top: left.price,
            right: pxOf(top, byTime),
            bottom: top.price,
            ...o,
          }),
        );
      }
      return pool.create('box', drop({ left, top, right, bottom, ...opts }));
    },
    copy(id: number): number {
      return pool.copy(id);
    },
    set_lefttop(id: number, left: number, top: number): void {
      pool.set(id, 'left', left);
      pool.set(id, 'top', top);
    },
    set_rightbottom(id: number, right: number, bottom: number): void {
      pool.set(id, 'right', right);
      pool.set(id, 'bottom', bottom);
    },
    // Corner setters take a chart.point; x (left/right) comes from index/time per the box's xloc, y (top/bottom) from price.
    set_top_left_point(id: number, point: ChartPoint): void {
      pool.set(id, 'left', pointX(pool, id, point));
      pool.set(id, 'top', point?.price);
    },
    set_bottom_right_point(id: number, point: ChartPoint): void {
      pool.set(id, 'right', pointX(pool, id, point));
      pool.set(id, 'bottom', point?.price);
    },
    set_left(id: number, left: number): void {
      pool.set(id, 'left', left);
    },
    set_top(id: number, top: number): void {
      pool.set(id, 'top', top);
    },
    set_right(id: number, right: number): void {
      pool.set(id, 'right', right);
    },
    set_bottom(id: number, bottom: number): void {
      pool.set(id, 'bottom', bottom);
    },
    set_bgcolor(id: number, c: string): void {
      pool.set(id, 'bgcolor', c);
    },
    set_border_color(id: number, c: string): void {
      pool.set(id, 'border_color', c);
    },
    set_border_width(id: number, w: number): void {
      pool.set(id, 'border_width', w);
    },
    set_border_style(id: number, s: string): void {
      pool.set(id, 'border_style', s);
    },
    set_extend(id: number, e: string): void {
      pool.set(id, 'extend', e);
    },
    set_text(id: number, t: string): void {
      pool.set(id, 'text', t);
    },
    set_text_color(id: number, c: string): void {
      pool.set(id, 'text_color', c);
    },
    set_text_font_family(id: number, family: string): void {
      pool.set(id, 'text_font_family', family);
    },
    set_text_size(id: number, s: string): void {
      pool.set(id, 'text_size', s);
    },
    set_text_halign(id: number, a: string): void {
      pool.set(id, 'text_halign', a);
    },
    set_text_valign(id: number, a: string): void {
      pool.set(id, 'text_valign', a);
    },
    set_text_formatting(id: number, fmt: unknown): void {
      pool.set(id, 'text_formatting', fmt);
    },
    set_text_wrap(id: number, wrap: string): void {
      pool.set(id, 'text_wrap', wrap);
    },
    // set_xloc updates the left/right coords and the xloc property in one call.
    set_xloc(id: number, left: number, right: number, xloc: string): void {
      pool.set(id, 'left', left);
      pool.set(id, 'right', right);
      pool.set(id, 'xloc', xloc);
    },
    get_left(id: number): unknown {
      return pool.get(id, 'left');
    },
    get_top(id: number): unknown {
      return pool.get(id, 'top');
    },
    get_right(id: number): unknown {
      return pool.get(id, 'right');
    },
    get_bottom(id: number): unknown {
      return pool.get(id, 'bottom');
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** polyline.* — a multi-point line/shape over an array of chart points. */
export function makePolylineNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'polyline');
    },
    new(points: unknown, opts: Opts = {}): number {
      const pts = Array.isArray(points) ? points.map((p) => ({ ...(p as object) })) : [];
      return pool.create('polyline', drop({ points: pts, ...opts }));
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** linefill.* — a colored fill between two existing line ids. */
export function makeLinefillNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'linefill');
    },
    new(line1: number, line2: number, color: string): number {
      return pool.create('linefill', drop({ line1, line2, color }));
    },
    set_color(id: number, c: string): void {
      pool.set(id, 'color', c);
    },
    get_line1(id: number): unknown {
      return pool.get(id, 'line1');
    },
    get_line2(id: number): unknown {
      return pool.get(id, 'line2');
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** table.* — a grid of cells positioned on the chart. */
export function makeTableNs(pool: DrawingPool) {
  return {
    get all() {
      return allOf(pool, 'table');
    },
    new(position: string, columns: number, rows: number, opts: Opts = {}): number {
      return pool.create('table', drop({ position, columns, rows, cells: {}, ...opts }));
    },
    copy(id: number): number {
      return pool.copy(id);
    },
    cell(id: number, column: number, row: number, text = '', opts: Opts = {}): void {
      const o = pool.objects.get(id);
      if (o)
        (o.props.cells as Record<string, unknown>)[`${column},${row}`] = drop({ text, ...opts });
    },
    // Mutate one attribute of an already-defined cell. If the cell does not yet
    // exist it is created with just this attribute (table.cell defaults apply on render).
    cell_set_text(id: number, column: number, row: number, text: string): void {
      cellSet(pool, id, column, row, 'text', text);
    },
    cell_set_tooltip(id: number, column: number, row: number, tooltip: string): void {
      cellSet(pool, id, column, row, 'tooltip', tooltip);
    },
    cell_set_text_font_family(id: number, column: number, row: number, family: string): void {
      cellSet(pool, id, column, row, 'text_font_family', family);
    },
    cell_set_bgcolor(id: number, column: number, row: number, c: string): void {
      cellSet(pool, id, column, row, 'bgcolor', c);
    },
    cell_set_text_color(id: number, column: number, row: number, c: string): void {
      cellSet(pool, id, column, row, 'text_color', c);
    },
    cell_set_text_size(id: number, column: number, row: number, size: string): void {
      cellSet(pool, id, column, row, 'text_size', size);
    },
    cell_set_text_halign(id: number, column: number, row: number, a: string): void {
      cellSet(pool, id, column, row, 'text_halign', a);
    },
    cell_set_text_valign(id: number, column: number, row: number, a: string): void {
      cellSet(pool, id, column, row, 'text_valign', a);
    },
    cell_set_text_formatting(id: number, column: number, row: number, fmt: unknown): void {
      cellSet(pool, id, column, row, 'text_formatting', fmt);
    },
    cell_set_width(id: number, column: number, row: number, w: number): void {
      cellSet(pool, id, column, row, 'width', w);
    },
    cell_set_height(id: number, column: number, row: number, h: number): void {
      cellSet(pool, id, column, row, 'height', h);
    },
    // Merge a rectangle of cells (start = top-left, end = bottom-right) into the
    // start cell; the merged region inherits the start cell's properties.
    merge_cells(
      id: number,
      startColumn: number,
      startRow: number,
      endColumn: number,
      endRow: number,
    ): void {
      const o = pool.objects.get(id);
      if (!o) return;
      const cells = o.props.cells as Record<string, unknown>;
      const key = `${startColumn},${startRow}`;
      const start = (cells[key] as Record<string, unknown>) ?? (cells[key] = {});
      start.merged = {
        start_column: startColumn,
        start_row: startRow,
        end_column: endColumn,
        end_row: endRow,
      };
    },
    set_position(id: number, p: string): void {
      pool.set(id, 'position', p);
    },
    set_bgcolor(id: number, c: string): void {
      pool.set(id, 'bgcolor', c);
    },
    set_border_color(id: number, c: string): void {
      pool.set(id, 'border_color', c);
    },
    set_border_width(id: number, w: number): void {
      pool.set(id, 'border_width', w);
    },
    set_frame_color(id: number, c: string): void {
      pool.set(id, 'frame_color', c);
    },
    set_frame_width(id: number, w: number): void {
      pool.set(id, 'frame_width', w);
    },
    clear(id: number): void {
      const o = pool.objects.get(id);
      if (o) o.props.cells = {};
    },
    delete(id: number): void {
      pool.remove(id);
    },
  };
}

/** Set one attribute on a table cell, creating the cell entry if absent. */
function cellSet(
  pool: DrawingPool,
  id: number,
  column: number,
  row: number,
  key: string,
  value: unknown,
): void {
  const o = pool.objects.get(id);
  if (!o) return;
  const cells = o.props.cells as Record<string, unknown>;
  const k = `${column},${row}`;
  const cell = (cells[k] as Record<string, unknown>) ?? (cells[k] = {});
  cell[key] = value;
}
