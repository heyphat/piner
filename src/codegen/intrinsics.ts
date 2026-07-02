/**
 * Shared intrinsic tables for BOTH backends (codegen + interpreter), so they make
 * identical decisions (docs/compiler-design.md §6/§7). Codegen consumes these to
 * emit `$` calls; the interpreter consumes them to dispatch `$` calls directly.
 */

/** Source namespace → ExecutionContext property holding its runtime impl. */
export const NS_RUNTIME: Record<string, string> = {
  ta: 'ta',
  math: 'math',
  str: 'str',
  color: 'color',
  input: 'input',
  array: 'array',
  map: 'map',
  matrix: 'matrix',
  line: 'line',
  label: 'label',
  box: 'box',
  table: 'table',
  linefill: 'linefill',
  polyline: 'polyline',
  chart: 'chart',
  barstate: 'barstate',
  plot: 'plotNs',
  shape: 'shape',
  location: 'location',
  hline: 'hlineNs',
  display: 'display',
  position: 'position',
  size: 'size',
  xloc: 'xloc',
  extend: 'extend',
  format: 'format',
  font: 'font',
  text: 'text',
  currency: 'currency',
  barmerge: 'barmerge',
  session: 'session',
  scale: 'scale',
  syminfo: 'syminfo',
  timeframe: 'timeframe',
  order: 'order',
  log: 'log',
  ticker: 'ticker',
  strategy: 'strategy',
  yloc: 'yloc',
  adjustment: 'adjustment',
  earnings: 'earnings',
  dividends: 'dividends',
  splits: 'splits',
  request: 'request',
  runtime: 'runtime',
  alert: 'alert',
  backadjustment: 'backadjustment',
  settlement_as_close: 'settlement_as_close',
};

/** Date/time functions taking a time arg → `$.dateAt('<name>', t)`. */
export const DATE_FNS = new Set(['year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear']);

/** Namespaces whose member/call lower to `$.<rt>.<member>`. */
export function nsRuntime(ns: string): string | undefined {
  return NS_RUNTIME[ns];
}

export const STATEFUL_TA = true; // every ta.* is stateful (gets a site)

/** ta.* members usable as no-paren built-in *variables* (stateful, get a site). */
export const TA_VARS = new Set(['tr', 'obv', 'accdist', 'iii', 'wvad', 'wad', 'nvi', 'pvi', 'pvt']);

/**
 * Built-in collection/drawing method names dispatched by receiver shape at runtime
 * (`$.method`). The inliner must NOT rewrite `recv.<name>(…)` into a user-method
 * call for these — `arr.push(x)` is always the built-in. A user `method` whose name
 * collides with one of these is reachable only in function form `name(recv, …)`.
 */
export const BUILTIN_METHODS = new Set([
  // array / map / matrix
  'abs', 'add_col', 'add_row', 'avg', 'binary_search', 'binary_search_leftmost',
  'binary_search_rightmost', 'clear', 'col', 'columns', 'concat', 'contains', 'copy',
  'covariance', 'det', 'diff', 'every', 'fill', 'first', 'from', 'get', 'includes',
  'indexof', 'insert', 'inv', 'join', 'keys', 'kron', 'last', 'lastindexof', 'max',
  'median', 'min', 'mode', 'mult', 'percentile_linear_interpolation',
  'percentile_nearest_rank', 'percentrank', 'pop', 'pow', 'push', 'put', 'put_all',
  'range', 'rank', 'remove', 'remove_col', 'remove_row', 'reshape', 'reverse', 'row',
  'rows', 'set', 'shift', 'size', 'slice', 'some', 'sort', 'sort_indices',
  'standardize', 'stdev', 'submatrix', 'sum', 'swap_columns', 'swap_rows', 'trace',
  'transpose', 'unshift', 'values', 'variance',
  // line / label / box / table / linefill / polyline
  'cell', 'cell_set_bgcolor', 'cell_set_height', 'cell_set_text', 'cell_set_text_color',
  'cell_set_text_font_family', 'cell_set_text_halign', 'cell_set_text_size',
  'cell_set_text_valign', 'cell_set_tooltip', 'cell_set_width', 'delete', 'get_bottom',
  'get_left', 'get_line1', 'get_line2', 'get_price', 'get_right', 'get_text', 'get_top',
  'get_x', 'get_x1', 'get_x2', 'get_y', 'get_y1', 'get_y2', 'merge_cell', 'merge_cells',
  'set_bgcolor', 'set_border_color', 'set_border_style', 'set_border_width', 'set_bottom',
  'set_color', 'set_extend', 'set_frame_color', 'set_frame_width', 'set_left',
  'set_lefttop', 'set_position', 'set_right', 'set_rightbottom', 'set_size', 'set_style',
  'set_text', 'set_text_color', 'set_text_font_family', 'set_text_halign', 'set_text_size',
  'set_text_valign', 'set_textcolor', 'set_top', 'set_width', 'set_x', 'set_x1', 'set_x2',
  'set_xloc', 'set_xy', 'set_xy1', 'set_xy2', 'set_y', 'set_y1', 'set_y2', 'set_yloc',
]);

/**
 * Normalize the *value* arguments for a ta.* call to the arity our Ta methods
 * expect (the `site` id is appended separately by the caller). Generic over the
 * arg representation: codegen passes JS-source strings, the interpreter passes
 * runtime values; `one` is the representation of the literal default `1`.
 */
export function normalizeTaArgs<T>(fn: string, args: T[], one: T, zero: T): T[] {
  switch (fn) {
    case 'tr':
      return args.length ? [args[0]] : []; // optional handle_na (bare `ta.tr` ≡ tr(false))
    case 'change':
      return args.length >= 2 ? [args[0], args[1]] : [args[0] ?? one, one]; // src, len(default 1)
    case 'valuewhen':
      return args.length >= 3 ? [args[0], args[1], args[2]] : [args[0], args[1], zero]; // cond, src, occurrence(default 0)
    default:
      return args;
  }
}

export const OUTPUT_FNS = new Set([
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar',
  'hline', 'fill', 'bgcolor', 'barcolor',
]);
/** plotshape/plotchar/plotarrow → marker kind. */
export const MARKER_KIND: Record<string, 'shape' | 'char' | 'arrow'> = {
  plotshape: 'shape', plotchar: 'char', plotarrow: 'arrow',
};
export const NOOP_FNS = new Set(['indicator', 'strategy', 'library']);
export const CAST_FNS: Record<string, string> = { int: 'toInt', float: 'toFloat', bool: 'toBool' };
/** Type-cast to a drawing/handle type, e.g. `box(x)` / `line(x)` — identity (an id is that type). */
export const DRAWING_CASTS = new Set(['line', 'label', 'box', 'table', 'linefill', 'polyline']);

/**
 * Ordered POSITIONAL parameter names for namespace constructors whose positional
 * params may also be passed BY NAME (TradingView lets any arg be named, e.g.
 * `box.new(left=.., top=.., right=.., bottom=..)`). Keyed by `<ns>.<fn>`.
 *
 * `nsArgs`/`nsArgValues` use this to slot a named arg matching a positional param
 * into that param's position; any remaining named args bundle into the trailing
 * `opts` object (the constructor spreads it as drawing props). Without it, a fully
 * (or partially) named call dumps everything into the opts bag, which then lands
 * in the FIRST parameter — corrupting `left`/`x1`/… (see test/drawing.test.ts).
 * Only the names listed here are true positional params of the runtime builtin;
 * styling args (bgcolor, color, …) intentionally stay in `opts`.
 */
export const NS_CALL_PARAMS: Record<string, readonly string[]> = {
  'line.new': ['x1', 'y1', 'x2', 'y2'],
  'label.new': ['x', 'y', 'text'],
  'box.new': ['left', 'top', 'right', 'bottom'],
  'table.new': ['position', 'columns', 'rows'],
  'polyline.new': ['points'],
  'linefill.new': ['line1', 'line2', 'color'],
};

/**
 * Ordered Pine POSITIONAL parameters that follow the runtime coord params (NS_CALL_PARAMS)
 * and must fold into the trailing `opts` object BY POSITION. The runtime constructors take
 * only `(coords…, opts)`, but Pine's signatures carry styling params positionally before the
 * named ones — e.g. `box.new(l, t, r, b, na, bgcolor = …)` puts `na` at the 5th positional,
 * which is `border_color`, NOT the opts bag. Without this the extra positional is swallowed
 * as `opts` (dropping the real styling and corrupting the drawing).
 */
export const NS_OPTS_POSITIONAL: Record<string, readonly string[]> = {
  'line.new': ['xloc', 'extend', 'color', 'style', 'width', 'force_overlay'],
  'label.new': ['xloc', 'yloc', 'color', 'style', 'textcolor', 'size', 'textalign', 'tooltip', 'text_font_family', 'force_overlay'],
  'box.new': ['border_color', 'border_width', 'border_style', 'extend', 'xloc', 'bgcolor', 'text', 'text_size', 'text_color', 'text_halign', 'text_valign', 'text_wrap', 'text_font_family', 'force_overlay'],
  'table.new': ['bgcolor', 'frame_color', 'frame_width', 'border_color', 'border_width', 'force_overlay'],
  'polyline.new': ['curved', 'closed', 'xloc', 'line_color', 'fill_color', 'line_style', 'line_width', 'force_overlay'],
};
