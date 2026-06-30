/**
 * Constant namespaces (enum-like): plot.style_*, shape.*, location.*,
 * hline.style_*, display.*, etc. Values are opaque string tags carried through
 * to outputs; only their identity matters to the engine.
 */
export const PlotNs = {
  style_line: 'line',
  style_stepline: 'stepline',
  style_histogram: 'histogram',
  style_cross: 'cross',
  style_area: 'area',
  style_columns: 'columns',
  style_circles: 'circles',
  style_linebr: 'linebr',
  style_areabr: 'areabr',
  style_stepline_diamond: 'stepline_diamond',
  style_steplinebr: 'steplinebr',
};

export const ShapeNs = {
  triangleup: 'triangleup',
  triangledown: 'triangledown',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  circle: 'circle',
  cross: 'cross',
  diamond: 'diamond',
  flag: 'flag',
  labelup: 'labelup',
  labeldown: 'labeldown',
  square: 'square',
  xcross: 'xcross',
};

export const LocationNs = {
  abovebar: 'abovebar',
  belowbar: 'belowbar',
  top: 'top',
  bottom: 'bottom',
  absolute: 'absolute',
};

export const HlineNs = {
  style_solid: 'solid',
  style_dotted: 'dotted',
  style_dashed: 'dashed',
};

export const PositionNs = {
  top_left: 'top_left',
  top_center: 'top_center',
  top_right: 'top_right',
  middle_left: 'middle_left',
  middle_center: 'middle_center',
  middle_right: 'middle_right',
  bottom_left: 'bottom_left',
  bottom_center: 'bottom_center',
  bottom_right: 'bottom_right',
};

export const SizeNs = {
  auto: 'auto', tiny: 'tiny', small: 'small', normal: 'normal', large: 'large', huge: 'huge',
};

export const XlocNs = { bar_index: 'bar_index', bar_time: 'bar_time' };
export const ExtendNs = { none: 'none', right: 'right', left: 'left', both: 'both' };
export const FormatNs = {
  price: 'price', volume: 'volume', percent: 'percent', mintick: 'mintick', inherit: 'inherit',
};
export const FontNs = { family_default: 'Default', family_monospace: 'Monospace' };
export const TextNs = {
  align_left: 'left', align_center: 'center', align_right: 'right',
  align_top: 'top', align_bottom: 'bottom', wrap_auto: 'auto', wrap_none: 'none',
  format_bold: 'bold', format_italic: 'italic', format_none: 'none',
};
export const CurrencyNs = {
  NONE: '', USD: 'USD', EUR: 'EUR', GBP: 'GBP', JPY: 'JPY', CHF: 'CHF', AUD: 'AUD',
  CAD: 'CAD', NZD: 'NZD', HKD: 'HKD', SGD: 'SGD', BTC: 'BTC', ETH: 'ETH', USDT: 'USDT',
  EGP: 'EGP', INR: 'INR', KRW: 'KRW', MYR: 'MYR', NOK: 'NOK', PKR: 'PKR',
  PLN: 'PLN', RUB: 'RUB', SEK: 'SEK', TRY: 'TRY', ZAR: 'ZAR',
};
export const DayofweekNs = {
  sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7,
};
export const BarmergeNs = {
  lookahead_on: true, lookahead_off: false, gaps_on: true, gaps_off: false,
};
export const SessionNs = { regular: 'regular', extended: 'extended' };
export const ScaleNs = { right: 'right', left: 'left', none: 'none' };
export const OrderNs = { ascending: 'ascending', descending: 'descending' };

export const DisplayNs = {
  none: 'none',
  all: 'all',
  data_window: 'data_window',
  pane: 'pane',
  status_line: 'status_line',
  price_scale: 'price_scale',
};

export const YlocNs = { price: 'price', abovebar: 'abovebar', belowbar: 'belowbar' };
export const AdjustmentNs = { none: 'adjustment_none', splits: 'adjustment_splits', dividends: 'adjustment_dividends' };
export const BackAdjustmentNs = { on: 'on', off: 'off', inherit: 'inherit' };
export const SettlementNs = { on: 'on', off: 'off', inherit: 'inherit' };
// request.* enum selectors (data families are na-stubbed; the selectors still resolve).
export const EarningsNs = { actual: 'actual', estimate: 'estimate', standardized: 'standardized' };
export const DividendsNs = { gross: 'gross', net: 'net' };
export const SplitsNs = { denominator: 'denominator', numerator: 'numerator' };
export const AlertNs = {
  freq_all: 'all', freq_once_per_bar: 'once_per_bar', freq_once_per_bar_close: 'once_per_bar_close',
};
