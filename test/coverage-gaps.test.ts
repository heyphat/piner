/**
 * Intensive both-backend coverage for the v6 gap fills (docs/v6-coverage-gap.md):
 *  - `dayofweek.*` day constants (and the `dayofweek` leaf, unchanged),
 *  - `alert.freq_*` constants + the `alert()` call (now a callable namespace),
 *  - `chart.is_*` chart-type flags, theme colors, visible-range bar times,
 *  - `session.isfirstbar(_regular)` / `islastbar(_regular)`,
 *  - `last_bar_time`, `timenow`, `time_tradingday` leaves,
 *  - `syminfo.minmove` / `pricescale`, `timeframe.isticks` / `main_period`,
 *  - `backadjustment.*` / `settlement_as_close.*`,
 *  - `ta.pvt`,
 *  - strategy performance statistics (percent / averages / extremes / bare stats),
 *  - `label.style_*` / `line.style_*` constants, `linefill.all` / `polyline.all`.
 *
 * Every compile-and-run test cross-checks the codegen and interpreter backends
 * (the §7 byte-for-byte invariant); value assertions then pin the semantics.
 */
import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// Multi-day 6h bars from 2021-01-01 UTC, so trading-day boundaries (and thus
// session first/last-bar flags) actually occur within the dataset.
const SIXH = 6 * 3600_000;
const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({
  time: Date.UTC(2021, 0, 1) + i * SIXH,
  open: 100 + i, high: 110 + i, low: 90 + i, close: 100 + (i % 7), volume: 1000 + i * 3,
}));
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;

/** Compile once, run both backends, cross-check every plot, return the js engine. */
async function bothBackends(src: string, opts: { symbol?: string; timeframe?: string; inputs?: Record<string, unknown> } = {}) {
  const c = compile(src);
  const symbol = opts.symbol ?? 'BINANCE:BTCUSDT';
  const timeframe = opts.timeframe ?? '360';
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js', inputs: opts.inputs });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp', inputs: opts.inputs });
  await js.run({ symbol, timeframe });
  await ip.run({ symbol, timeframe });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) {
        throw new Error(`backend diverge plot "${jp.title}"(${id}) bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
      }
    }
  }
  return js;
}
const plot = (e: Engine, title: string) => {
  for (const [, p] of e.outputs.plots) if (p.title === title) return p.data;
  throw new Error(`no plot titled "${title}"`);
};
const last = (e: Engine, title: string) => { const d = plot(e, title); return d[d.length - 1]; };

describe('dayofweek constants', () => {
  it('the day constants are Sunday=1 … Saturday=7', async () => {
    const e = await bothBackends(`//@version=6
indicator("d")
plot(dayofweek.sunday, "sun")
plot(dayofweek.monday, "mon")
plot(dayofweek.tuesday, "tue")
plot(dayofweek.wednesday, "wed")
plot(dayofweek.thursday, "thu")
plot(dayofweek.friday, "fri")
plot(dayofweek.saturday, "sat")`);
    expect([last(e, 'sun'), last(e, 'mon'), last(e, 'tue'), last(e, 'wed'), last(e, 'thu'), last(e, 'fri'), last(e, 'sat')])
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('the `dayofweek` leaf still returns the current bar day (1..7) and compares to the constant', async () => {
    const e = await bothBackends(`//@version=6
indicator("d")
plot(dayofweek, "dow")
plot(dayofweek == dayofweek.friday ? 1 : 0, "isfri")`);
    const dow = plot(e, 'dow');
    expect(dow.every((v) => v >= 1 && v <= 7)).toBe(true);
    // 2021-01-01 is a Friday → first bar's dow must equal dayofweek.friday (6).
    expect(dow[0]).toBe(6);
    expect(plot(e, 'isfri')[0]).toBe(1);
  });
});

describe('qualified type names in declarations (chart.point …)', () => {
  // Real-script gap (auto-pitchfork): `var chart.point p = na`, `f(chart.point a, chart.point b) =>`.
  // isTypeStart() now recognizes a dotted type name followed by a declared name, in both the
  // `var`-decl and function-parameter slots; parseBaseType() already consumed the dotted name.
  it('parses + runs a `var chart.point` decl and qualified-type function params (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("qt", overlay = true)
var chart.point p = na
p := chart.point.from_index(bar_index, close)
midPrice(chart.point a, chart.point b) =>
    (a.price + b.price) / 2
q = chart.point.from_index(bar_index, open)
plot(midPrice(p, q), "mid")`);
    // mid of close & open per bar; just assert it's a finite, bar-length series that agrees
    // across backends (bothBackends already cross-checks every plot).
    const mid = plot(e, 'mid');
    expect(mid.length).toBe(bars.length);
    expect(mid.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('chart.point.copy clones a point (na-safe) and chart.point.now defaults to close', async () => {
    // Real-script gap (auto-pitchfork): `chart.point.copy(prev2P)` then mutating the copy's
    // price — the original must not move. copy(na) is na; now() takes price = close.
    const e = await bothBackends(`//@version=6
indicator("cpc")
p = chart.point.from_index(bar_index, close)
c = chart.point.copy(p)
c.price := c.price + 1
plot(p.price, "orig")
plot(c.price, "copy")
chart.point q = na
plot(na(chart.point.copy(q)) ? 1 : 0, "na-safe")
plot(chart.point.now().price, "now")`);
    const orig = plot(e, 'orig'), copy = plot(e, 'copy'), nasafe = plot(e, 'na-safe'), now = plot(e, 'now');
    for (let i = 0; i < bars.length; i++) {
      expect(copy[i]).toBeCloseTo(orig[i] + 1, 9); // the copy moved…
      expect(orig[i]).toBeCloseTo(bars[i].close, 9); // …the original did not
      expect(now[i]).toBeCloseTo(bars[i].close, 9);
    }
    expect(nasafe.every((v) => v === 1)).toBe(true);
  });
});

describe('inline-expression history (expr)[n]', () => {
  // Real-script gap (ict-killzones): `f(x) != f(x)[1]`. An inline expression referenced with
  // `[n]` is materialized into an auto-history slot written at the use site each bar — so
  // `(close+open)[2]` equals `close[2]+open[2]` and the assign-to-a-var form, on both backends.
  it('(close+open)[2] equals close[2]+open[2] and the var-assigned form (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("ieh")
plot((close + open)[2], "inline")
x = close + open
plot(x[2], "viaVar")
plot(close[2] + open[2], "manual")`);
    const inline = plot(e, 'inline'), viaVar = plot(e, 'viaVar'), manual = plot(e, 'manual');
    for (let i = 0; i < inline.length; i++) {
      expect(eqNaN(inline[i], viaVar[i])).toBe(true);
      expect(eqNaN(inline[i], manual[i])).toBe(true);
    }
    // a couple of concrete spot checks (first two bars are na, then real history)
    expect(Number.isNaN(inline[0])).toBe(true);
    expect(inline[5]).toBeCloseTo(manual[5], 9);
  });

  it('history on a call result `ta.sma(close,3)[1]` compiles + runs (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("ieh2")
plot(ta.sma(close, 3)[1], "smaPrev")`);
    expect(plot(e, 'smaPrev').length).toBe(bars.length);
  });
});

describe('non-numeric series history (x[n] for arrays / strings)', () => {
  // History slots are polymorphic: a reference value (array, string, color, UDT) read via x[n]
  // must come back as the value, not the NaN a numeric Float64Array column would coerce it to.
  // (This unblocks LuxAlgo supply-demand-range, which walks v[j] over request.security_lower_tf.)
  it('array-valued history reads back the prior bar\'s array (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("ah")
arr = array.new_float(0)
array.push(arr, close)
plot(array.size(arr), "sizeNow")
plot(bar_index > 0 ? array.get(arr[1], 0) : na, "prevClose")`);
    expect(plot(e, 'sizeNow').every((v) => v === 1)).toBe(true); // a fresh 1-element array each bar
    const pc = plot(e, 'prevClose');
    expect(Number.isNaN(pc[0])).toBe(true);          // no prior bar
    // coverage-gaps `bars`: close = 100 + (i % 7), so prevClose[i] = 100 + ((i-1) % 7)
    expect(pc[1]).toBe(100);
    expect(pc[5]).toBe(104);
    expect(pc[8]).toBe(100);
  });

  it('string-valued history reads back the prior bar\'s string (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("sh")
s = str.tostring(bar_index)
plot(bar_index > 0 and s[1] == str.tostring(bar_index - 1) ? 1 : 0, "ok")`);
    expect(plot(e, 'ok').slice(1).every((v) => v === 1)).toBe(true);
  });
});

describe('request.security_lower_tf (intrabar) — host-injected lower-TF bars', () => {
  // Real-script gap (LuxAlgo supply-demand-range): the script's whole visual is built from
  // intrabar volume via request.security_lower_tf. piner doesn't fetch — the host injects the
  // lower-TF bars under securityBars["<symbol>@<tf>"]; piner buckets them into each chart bar
  // (the inverse of HTF) and evaluates the expr per intrabar. A tuple expr → a tuple of arrays.
  it('buckets injected lower-TF bars per chart bar; tuple expr → tuple of arrays (both backends)', async () => {
    const H = 3600_000;
    const T = Date.UTC(2024, 0, 1);
    // 3 chart bars at 60-min.
    const chart: Bar[] = [0, 1, 2].map((c) => ({ time: T + c * H, open: 100 + c, high: 110 + c, low: 90 + c, close: 105 + c, volume: 0 }));
    // 3 intrabars per chart bar with distinct volumes 1..9 (bar0: 1,2,3 · bar1: 4,5,6 · bar2: 7,8,9).
    const ltf: Bar[] = [];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
      ltf.push({ time: T + c * H + k * (H / 3), open: 100, high: 110 + k, low: 90 - k, close: 100 + k, volume: c * 3 + k + 1 });
    }
    const src = `//@version=6
indicator("ltf")
get_hlv() => [high, low, volume]
[h, l, v] = request.security_lower_tf(syminfo.tickerid, "1", get_hlv())
plot(array.size(v), "n")
plot(array.size(v) > 0 ? array.sum(v) : na, "vsum")
plot(array.size(h) > 0 ? array.get(h, 0) : na, "h0")
one = request.security_lower_tf(syminfo.tickerid, "1", close)
plot(array.size(one), "scalarN")`;
    const c = compile(src);
    expect((c.diagnostics ?? []).filter((d) => d.severity === 'error').length).toBe(0);
    const runOne = async (backend: 'js' | 'interp') => {
      const e = new Engine(c, new ArrayFeed(chart), { backend });
      e.ctx.securityBars.set('X@1', ltf); // host injection (what fractal will do)
      await e.run({ symbol: 'X', timeframe: '60' });
      return e;
    };
    const js = await runOne('js');
    const ip = await runOne('interp');
    // byte-for-byte backend agreement (§7)
    for (const [id, jp] of js.outputs.plots) {
      const ipp = ip.outputs.plots.get(id)!;
      for (let i = 0; i < jp.data.length; i++) {
        if (!eqNaN(jp.data[i], ipp.data[i])) throw new Error(`backend diverge "${jp.title}" bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
      }
    }
    expect(plot(js, 'n')).toEqual([3, 3, 3]);              // 3 intrabars bucketed per chart bar
    expect(plot(js, 'vsum')).toEqual([6, 15, 24]);          // Σ volumes per bar: 1+2+3, 4+5+6, 7+8+9
    expect(plot(js, 'h0')).toEqual([110, 110, 110]);        // first intrabar high (110+0) each bar
    expect(plot(js, 'scalarN')).toEqual([3, 3, 3]);         // scalar expr → one array per chart bar
  });

  it('no injected lower-TF bars → [] per chart bar (graceful, pre-feed behavior)', async () => {
    const H = 3600_000, T = Date.UTC(2024, 0, 1);
    const chart: Bar[] = [0, 1, 2].map((c) => ({ time: T + c * H, open: 100, high: 110, low: 90, close: 100, volume: 1 }));
    const c = compile(`//@version=6
indicator("ltf0")
v = request.security_lower_tf(syminfo.tickerid, "1", close)
plot(array.size(v), "n")`);
    const e = new Engine(c, new ArrayFeed(chart), { backend: 'js' });
    await e.run({ symbol: 'X', timeframe: '60' });
    expect(plot(e, 'n')).toEqual([0, 0, 0]);
  });

  it('EMPTY (auto) timeframe with no injection → one intrabar per chart bar (the bar itself)', async () => {
    // Real-script gap (LuxAlgo S&D Visible Range uses input.timeframe('')): an empty/auto lower
    // tf means "most granular available". With no finer bars injected, the chart bar IS the floor,
    // so security_lower_tf returns a single intrabar per bar (the bar's own values) — letting the
    // volume-profile render from chart data alone instead of accumulating nothing. An EXPLICIT tf
    // ("1") with no data still returns [] (see the test above).
    const H = 3600_000, T = Date.UTC(2024, 0, 1);
    const chart: Bar[] = [0, 1, 2].map((c) => ({ time: T + c * H, open: 100 + c, high: 110 + c, low: 90 + c, close: 105 + c, volume: 7 + c }));
    const c = compile(`//@version=6
indicator("ltfauto")
get_hlv() => [high, low, volume]
[h, l, v] = request.security_lower_tf(syminfo.tickerid, "", get_hlv())
plot(array.size(v), "n")
plot(array.size(v) > 0 ? array.get(v, 0) : na, "v0")
plot(array.size(h) > 0 ? array.get(h, 0) : na, "h0")`);
    const e = new Engine(c, new ArrayFeed(chart), { backend: 'js' });
    await e.run({ symbol: 'X', timeframe: '60' });
    expect(plot(e, 'n')).toEqual([1, 1, 1]);           // one intrabar = the chart bar itself
    expect(plot(e, 'v0')).toEqual([7, 8, 9]);          // its own volume
    expect(plot(e, 'h0')).toEqual([110, 111, 112]);    // its own high
  });
});

describe('UDT type definitions with array / template fields', () => {
  // Real-script gap (LuxAlgo supply-demand-range): `type` blocks whose fields are arrays —
  // legacy `T[]` and `array<T>`. The field-decl guard now treats a type-start token followed
  // by `[` (legacy array) or `<` (template) as a typed field, not a bare field name.
  it('parses + runs a UDT with legacy `T[]`, template `array<T>`, and plain typed fields (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("udt", overlay = true)
type Zone
    box[] boxes
    float[] tops
    array<float> bottoms
    int touches = 0
var z = Zone.new(array.new_box(), array.new_float(), array.new_float(), 0)
z.touches := array.size(z.tops)
plot(z.touches, "touches")`);
    const touches = plot(e, 'touches');
    expect(touches.length).toBe(bars.length);
    // no rows pushed → array.size stays 0 across the run
    expect(touches.every((v) => v === 0)).toBe(true);
  });
});

describe('if / switch as a user-function body (implicit return)', () => {
  // Regression: a UDF whose last statement is a `switch`/`if` returns that expression's value
  // (Pine if/switch are expressions). Previously blockValue ran it as a side-effect statement and
  // returned na — e.g. the built-in SMA script's `ma(src,len,type) => switch type ...` was all-na.
  it('returns the matched switch branch and the taken if branch (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("uf")
pick(t) =>
    switch t
        "a" => 10.0
        "b" => 20.0
        => 0.0
chooseIf(x) =>
    if x > 0
        100.0
    else
        -100.0
plot(pick("b"), "sw")
plot(chooseIf(close), "if")`);
    expect(last(e, 'sw')).toBe(20);   // switch "b" branch
    expect(last(e, 'if')).toBe(100);  // close > 0 → the `if` branch
  });
});

describe('alert (callable namespace) + alert.freq_* constants', () => {
  it('alert() records an alert and the freq constants resolve to their tags', async () => {
    const e = await bothBackends(`//@version=6
indicator("a")
plot(alert.freq_all == "all" ? 1 : 0, "all")
plot(alert.freq_once_per_bar == "once_per_bar" ? 1 : 0, "opb")
plot(alert.freq_once_per_bar_close == "once_per_bar_close" ? 1 : 0, "opbc")
if barstate.islast
    alert("fired", alert.freq_once_per_bar)`);
    expect([last(e, 'all'), last(e, 'opb'), last(e, 'opbc')]).toEqual([1, 1, 1]);
    expect(e.outputs.alerts.length).toBe(1);
    expect(e.outputs.alerts[0].message).toBe('fired');
  });

  // Regression: alertcondition records the message arg; with no message it falls back to the
  // title (a prior bug emitted "" for an absent arg, defeating `message ?? title`). Both backends.
  it('alertcondition: message wins, title is the fallback, false never fires (both backends)', async () => {
    const c = compile(`//@version=6
indicator("ac")
alertcondition(barstate.islast, title = "TitleOnly")
alertcondition(barstate.islast, title = "t", message = "MsgWins")
alertcondition(false, title = "Never", message = "no")
plot(close)`);
    const msgs = async (backend: 'js' | 'interp') => {
      const e = new Engine(c, new ArrayFeed(bars), { backend });
      await e.run({ symbol: 'X', timeframe: '360' });
      return e.outputs.alerts.map((a) => a.message);
    };
    const js = await msgs('js');
    expect(js).toEqual(await msgs('interp')); // backends agree
    expect(js).toEqual(['TitleOnly', 'MsgWins']); // title fallback + message-wins; false never fires
  });
});

describe('chart.* flags, colors, visible range', () => {
  it('is_standard is true and the non-standard chart-type flags are false', async () => {
    const e = await bothBackends(`//@version=6
indicator("c")
plot(chart.is_standard ? 1 : 0, "std")
plot(chart.is_heikinashi ? 1 : 0, "ha")
plot(chart.is_renko ? 1 : 0, "rk")
plot(chart.is_kagi ? 1 : 0, "kg")
plot(chart.is_pnf ? 1 : 0, "pnf")
plot(chart.is_range ? 1 : 0, "rng")
plot(chart.is_linebreak ? 1 : 0, "lb")`);
    expect(last(e, 'std')).toBe(1);
    for (const t of ['ha', 'rk', 'kg', 'pnf', 'rng', 'lb']) expect(last(e, t)).toBe(0);
  });
  it('bg_color/fg_color are color strings and visible-range times bound the dataset', async () => {
    const e = await bothBackends(`//@version=6
indicator("c")
plot(str.length(chart.bg_color) > 0 ? 1 : 0, "bg")
plot(str.length(chart.fg_color) > 0 ? 1 : 0, "fg")
plot(chart.left_visible_bar_time, "left")
plot(chart.right_visible_bar_time, "right")
plot(last_bar_time, "lbt")`);
    expect([last(e, 'bg'), last(e, 'fg')]).toEqual([1, 1]);
    expect(plot(e, 'left')[0]).toBe(bars[0].time);                 // leftmost = first bar
    expect(last(e, 'right')).toBe(bars[bars.length - 1].time);     // rightmost = last bar
    expect(last(e, 'right')).toBe(last(e, 'lbt'));                 // == last_bar_time
  });
});

describe('session first/last-bar flags', () => {
  it('isfirstbar/islastbar fire at trading-day boundaries; *_regular mirrors them (24h dataset)', async () => {
    const e = await bothBackends(`//@version=6
indicator("s")
plot(session.isfirstbar ? 1 : 0, "sfb")
plot(session.islastbar ? 1 : 0, "slb")
plot(session.isfirstbar_regular ? 1 : 0, "sfbr")
plot(session.islastbar_regular ? 1 : 0, "slbr")
plot(session.regular == "regular" ? 1 : 0, "reg")`);
    const sfb = plot(e, 'sfb'), slb = plot(e, 'slb');
    expect(sfb[0]).toBe(1);                       // very first bar starts a session
    expect(slb[slb.length - 1]).toBe(1);          // last bar ends its session
    // 4×6h bars per UTC day → a new session every 4th bar (bars 0,4,8,… are first).
    expect(sfb[4]).toBe(1);
    expect(sfb[5]).toBe(0);
    expect(plot(e, 'sfbr')).toEqual(sfb);         // regular == extended on a 24h feed
    expect(plot(e, 'slbr')).toEqual(slb);
    expect(last(e, 'reg')).toBe(1);
  });
});

describe('time leaves', () => {
  it('last_bar_time / timenow / time_tradingday', async () => {
    const e = await bothBackends(`//@version=6
indicator("t")
plot(last_bar_time, "lbt")
plot(timenow, "now")
plot(time_tradingday, "ttd")`);
    const lastT = bars[bars.length - 1].time;
    // last_bar_time is the dataset's final bar time on every bar.
    expect(plot(e, 'lbt').every((v) => v === lastT)).toBe(true);
    // timenow (deterministic): last bar close = last_bar_time + one 6h timeframe.
    expect(last(e, 'now')).toBe(lastT + SIXH);
    // time_tradingday: UTC midnight of the current bar's date.
    const d = new Date(lastT);
    expect(last(e, 'ttd')).toBe(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  });
});

describe('syminfo / timeframe additions', () => {
  it('syminfo.minmove=1, pricescale=100, and mintick == minmove/pricescale', async () => {
    const e = await bothBackends(`//@version=6
indicator("s")
plot(syminfo.minmove, "mm")
plot(syminfo.pricescale, "ps")
plot(syminfo.mintick, "mt")`);
    expect(last(e, 'mm')).toBe(1);
    expect(last(e, 'ps')).toBe(100);
    expect(last(e, 'mt')).toBeCloseTo(last(e, 'mm') / last(e, 'ps'), 12);
  });
  it('timeframe.isticks is false for a minute timeframe; main_period equals the period', async () => {
    const e = await bothBackends(`//@version=6
indicator("tf")
plot(timeframe.isticks ? 1 : 0, "ticks")
plot(timeframe.main_period == timeframe.period ? 1 : 0, "mainper")`, { timeframe: '360' });
    expect(last(e, 'ticks')).toBe(0);
    expect(last(e, 'mainper')).toBe(1);
  });
});

describe('backadjustment / settlement_as_close constants', () => {
  it('resolve to their string tags', async () => {
    const e = await bothBackends(`//@version=6
indicator("b")
plot(backadjustment.on == "on" ? 1 : 0, "bon")
plot(backadjustment.off == "off" ? 1 : 0, "boff")
plot(backadjustment.inherit == "inherit" ? 1 : 0, "binh")
plot(settlement_as_close.on == "on" ? 1 : 0, "son")
plot(settlement_as_close.inherit == "inherit" ? 1 : 0, "sinh")`);
    for (const t of ['bon', 'boff', 'binh', 'son', 'sinh']) expect(last(e, t)).toBe(1);
  });
});

describe('ta.pvt (Price Volume Trend)', () => {
  it('cross-checks both backends and matches the cumulative Σ(Δclose/close[1])·volume formula', async () => {
    const e = await bothBackends(`//@version=6
indicator("pvt")
plot(ta.pvt, "pvt")`);
    // independent reference computation over the same bars
    let ref = 0, prev = NaN;
    const got = plot(e, 'pvt');
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      if (!Number.isNaN(prev) && prev !== 0) ref += ((c - prev) / prev) * bars[i].volume;
      prev = c;
      expect(got[i]).toBeCloseTo(ref, 9);
    }
  });
});

describe('strategy performance statistics', () => {
  // A deterministic two-trade backtest: one winner (long), one loser (short).
  const STRAT = `//@version=6
strategy("s", default_qty_type=strategy.fixed, default_qty_value=2)
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 6
    strategy.close("L")
if bar_index == 10
    strategy.entry("S", strategy.short)
if bar_index == 14
    strategy.close("S")
plot(strategy.netprofit_percent, "npp")
plot(strategy.openprofit_percent, "opp")
plot(strategy.grossprofit_percent, "gpp")
plot(strategy.grossloss_percent, "glp")
plot(strategy.max_drawdown_percent, "mddp")
plot(strategy.max_runup, "mru")
plot(strategy.max_runup_percent, "mrup")
plot(strategy.avg_trade, "avt")
plot(strategy.avg_trade_percent, "avtp")
plot(strategy.avg_winning_trade, "awt")
plot(strategy.avg_winning_trade_percent, "awtp")
plot(strategy.avg_losing_trade, "alt")
plot(strategy.avg_losing_trade_percent, "altp")
plot(strategy.max_contracts_held_all, "mcha")
plot(strategy.max_contracts_held_long, "mchl")
plot(strategy.max_contracts_held_short, "mchs")
plot(strategy.margin_liquidation_price, "mlp")
plot(strategy.closedtrades.first_index, "cfi")
plot(strategy.opentrades.capital_held, "och")`;

  it('cross-checks both backends and the stats agree with the report ledger', async () => {
    const e = await bothBackends(STRAT);
    const r = e.strategy;
    const cap = r.initialCapital;
    // percent stats are the dollar figures relative to initial capital
    expect(last(e, 'npp')).toBeCloseTo((r.netProfit / cap) * 100, 9);
    expect(last(e, 'gpp')).toBeCloseTo((r.grossProfit / cap) * 100, 9);
    expect(last(e, 'glp')).toBeCloseTo((r.grossLoss / cap) * 100, 9);
    expect(last(e, 'opp')).toBeCloseTo(0, 9);                              // flat at the end
    // averages
    expect(last(e, 'avt')).toBeCloseTo(r.netProfit / r.closedTrades.length, 9);
    expect(last(e, 'awt')).toBeCloseTo(r.grossProfit / r.wins, 9);
    expect(last(e, 'alt')).toBeCloseTo(r.grossLoss / r.losses, 9);
    // extremes
    expect(last(e, 'mddp')).toBeGreaterThanOrEqual(0);
    expect(last(e, 'mru')).toBeGreaterThanOrEqual(0);
    expect(last(e, 'mrup')).toBeGreaterThanOrEqual(0);
    // fixed qty 2 → max contracts held is 2 (long side), 2 (short side)
    expect(last(e, 'mcha')).toBe(2);
    expect(last(e, 'mchl')).toBe(2);
    expect(last(e, 'mchs')).toBe(2);
    // margin not modeled → na; first closed-trade index = 0; flat → capital_held = 0
    expect(Number.isNaN(last(e, 'mlp'))).toBe(true);
    expect(last(e, 'cfi')).toBe(0);
    expect(last(e, 'och')).toBe(0);
  });

  it('position_entry_name tracks the open entry id and clears when flat', async () => {
    const e = await bothBackends(`//@version=6
strategy("s", default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 2
    strategy.entry("MyLong", strategy.long)
if bar_index == 8
    strategy.close("MyLong")
plot(str.length(strategy.position_entry_name), "len")
plot(strategy.position_entry_name == "MyLong" ? 1 : 0, "isml")`);
    const len = plot(e, 'len'), isml = plot(e, 'isml');
    expect(len[1]).toBe(0);          // before entry → empty
    expect(isml[4]).toBe(1);         // while holding → "MyLong"
    expect(len[len.length - 1]).toBe(0); // after close → empty again
  });

  it('opentrades.capital_held reflects the open position cost basis while in a trade', async () => {
    const e = await bothBackends(`//@version=6
strategy("s", default_qty_type=strategy.fixed, default_qty_value=3)
if bar_index == 2
    strategy.entry("L", strategy.long)
plot(strategy.opentrades.capital_held, "och")
plot(strategy.position_size, "sz")
plot(strategy.position_avg_price, "ap")`);
    const sz = plot(e, 'sz'), ap = plot(e, 'ap'), och = plot(e, 'och');
    const i = sz.length - 1;
    expect(sz[i]).toBe(3);
    expect(och[i]).toBeCloseTo(Math.abs(sz[i] * ap[i]), 6); // |size · avgPrice|
  });
});

describe('drawing style constants + .all collections', () => {
  it('label.style_* / line.style_* constants resolve to their tags', async () => {
    const e = await bothBackends(`//@version=6
indicator("d", overlay=true)
plot(label.style_circle == "circle" ? 1 : 0, "lc")
plot(label.style_label_up == "label_up" ? 1 : 0, "llu")
plot(label.style_none == "none" ? 1 : 0, "ln")
plot(line.style_solid == "solid" ? 1 : 0, "ls")
plot(line.style_dashed == "dashed" ? 1 : 0, "ld")
plot(line.style_arrow_both == "arrow_both" ? 1 : 0, "lab")`);
    for (const t of ['lc', 'llu', 'ln', 'ls', 'ld', 'lab']) expect(last(e, t)).toBe(1);
  });
  it('linefill.all / polyline.all return live-id arrays', async () => {
    const e = await bothBackends(`//@version=6
indicator("d", overlay=true)
var line l1 = na
var line l2 = na
var linefill lf = na
if barstate.islast
    l1 := line.new(bar_index - 2, low, bar_index, high)
    l2 := line.new(bar_index - 2, high, bar_index, low)
    lf := linefill.new(l1, l2, color.new(color.blue, 80))
plot(array.size(linefill.all), "nfills")
plot(array.size(polyline.all), "npoly")`);
    expect(last(e, 'nfills')).toBe(1);   // one linefill created on the last bar
    expect(plot(e, 'nfills')[0]).toBe(0); // none before
    expect(last(e, 'npoly')).toBe(0);    // no polylines created
  });
});

describe('time(timeframe, session, timezone) — in-session filtering', () => {
  // bars are 6h UTC: i%4 → 00:00 / 06:00 / 12:00 / 18:00.
  it('returns na outside the session window and the bar time inside (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("s")
inSess = not na(time("", "0900-1500", "UTC")) ? 1.0 : 0.0
plot(inSess, "in")
`);
    const d = plot(e, 'in');
    expect(d[0]).toBe(0); // 00:00 UTC — outside
    expect(d[1]).toBe(0); // 06:00 — outside
    expect(d[2]).toBe(1); // 12:00 — inside 09:00-15:00
    expect(d[3]).toBe(0); // 18:00 — outside
  });
  it('evaluates the window in the given timezone (this fixed the LuxAlgo sessions overlap)', async () => {
    const e = await bothBackends(`//@version=6
indicator("s")
utc = not na(time("", "0900-1500", "UTC")) ? 1.0 : 0.0
tok = not na(time("", "0900-1500", "Asia/Tokyo")) ? 1.0 : 0.0
plot(utc, "utc")
plot(tok, "tok")
`);
    // 00:00 UTC = 09:00 Tokyo (+9): inside the Tokyo window, outside the UTC window.
    expect(plot(e, 'utc')[0]).toBe(0);
    expect(plot(e, 'tok')[0]).toBe(1);
    // 12:00 UTC = 21:00 Tokyo: inside UTC, outside Tokyo.
    expect(plot(e, 'utc')[2]).toBe(1);
    expect(plot(e, 'tok')[2]).toBe(0);
  });
});

describe('for-loop direction (descending / explicit step magnitude)', () => {
  // Real-script gap (auto-fib pivot refinement, auto-pitchfork): `for i = n to 0`
  // must count DOWN. Both backends previously hardcoded `i <= to` + step 1, so a
  // descending loop ran zero iterations — and since both were wrong identically the
  // cross-check never caught it. Direction now comes from from/to; `by k` is a magnitude.
  it('counts down for from>to, up for from<to, and treats `by` as a magnitude (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("loops")
desc() =>
    int n = 0
    float s = 0
    for i = 4 to 0
        n += 1
        s += i
    [n, s]
[dn, ds] = desc()
plot(dn, "dn")
plot(ds, "ds")
asc() =>
    int n = 0
    for i = 0 to 4
        n += 1
    n
plot(asc(), "asc")
downBy() =>
    int n = 0
    for i = 10 to 0 by 2
        n += 1
    n
plot(downBy(), "downBy")
single() =>
    int n = 0
    for i = 3 to 3
        n += 1
    n
plot(single(), "single")`);
    expect(last(e, 'dn')).toBe(5);   // 4,3,2,1,0
    expect(last(e, 'ds')).toBe(10);  // 4+3+2+1+0
    expect(last(e, 'asc')).toBe(5);  // 0,1,2,3,4
    expect(last(e, 'downBy')).toBe(6); // 10,8,6,4,2,0
    expect(last(e, 'single')).toBe(1); // from==to runs once
  });
});

describe('line.new / box.new two-chart.point overload', () => {
  // Real-script gap (auto-fib): `line.new(point1, point2, color=…, xloc=…)` and the
  // box analog. With only the 4-scalar form handled, the two points landed in x1/y1
  // and the trailing opts object in x2 → garbage coords, nothing rendered. Now the
  // constructors detect two chart.points and map index/time→x and price→y per xloc.
  const drawPool = (e: Engine) =>
    (e as unknown as { ctx: { drawPool: { objects: Map<number, { type: string; props: Record<string, unknown> }> } } }).ctx.drawPool;
  const ofType = (e: Engine, t: string) => [...drawPool(e).objects.values()].filter((o) => o.type === t).map((o) => o.props);

  it('line.new(point, point, opts): index-form uses .index, time-form uses .time (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("lp", overlay=true)
if barstate.islast
    p1 = chart.point.from_index(10, 100.0)
    p2 = chart.point.from_index(20, 200.0)
    line.new(p1, p2, color=color.red, width=2, style=line.style_dashed)
    t1 = chart.point.from_time(time, 50.0)
    t2 = chart.point.from_time(time, 60.0)
    line.new(t1, t2, xloc=xloc.bar_time)
plot(close)`);
    const lines = ofType(e, 'line');
    expect(lines.length).toBe(2);
    const idx = lines.find((p) => p.xloc !== 'bar_time')!;
    expect(idx).toMatchObject({ x1: 10, y1: 100, x2: 20, y2: 200, width: 2, style: 'dashed' });
    expect(idx.color).toBeDefined();
    const tline = lines.find((p) => p.xloc === 'bar_time')!;
    expect(tline.y1).toBe(50);
    expect(tline.y2).toBe(60);
    expect(typeof tline.x1).toBe('number'); // a real time value, not the opts object
    expect(Number.isFinite(tline.x1 as number)).toBe(true);
  });

  it('box.new(top_left, bottom_right, opts): corners map to left/top + right/bottom (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("bp", overlay=true)
if barstate.islast
    tl = chart.point.from_index(5, 300.0)
    br = chart.point.from_index(15, 250.0)
    box.new(tl, br, bgcolor=color.blue, border_width=1)
plot(close)`);
    const boxes = ofType(e, 'box');
    expect(boxes.length).toBe(1);
    expect(boxes[0]).toMatchObject({ left: 5, top: 300, right: 15, bottom: 250, border_width: 1 });
    expect(boxes[0].bgcolor).toBeDefined();
  });

  it('label.new(point, text, xloc, opts): text & xy map correctly (both backends)', async () => {
    // Was the bug: only the 3-scalar form label.new(x, y, text) was handled, so the
    // point overload label.new(point, text, xloc, …) shifted the text into the y slot and
    // the xloc string into the text slot — every structure/swing label (BOS/CHoCH, HH/LL,
    // EQH/EQL in LuxAlgo SMC) rendered the literal "bar_index" at a NaN y.
    const e = await bothBackends(`//@version=6
indicator("lbl", overlay=true)
if barstate.islast
    p = chart.point.from_index(12, 175.0)
    label.new(p, 'BOS', xloc.bar_index, color=color.red, textcolor=color.white, style=label.style_label_down)
plot(close)`);
    const labels = ofType(e, 'label');
    expect(labels.length).toBe(1);
    expect(labels[0]).toMatchObject({ x: 12, y: 175, text: 'BOS', style: 'label_down' });
    expect(labels[0].color).toBeDefined();
  });

  it('line.new/box.new(point, point, POSITIONAL xloc, named opts): keeps coords, xloc AND opts', async () => {
    // Was the bug: the LuxAlgo SMC structure form line.new(p1, p2, xloc.bar_time, color=, style=)
    // put the positional xloc string in the x2 slot and the named-opts object in the y2 slot, so
    // the overload (which only checked x2 for opts) dropped color/style and resolved x to the
    // point's na index → BOS/CHoCH lines were invisible and uncolored.
    const e = await bothBackends(`//@version=6
indicator("pxloc", overlay=true)
if barstate.islast
    p1 = chart.point.from_time(time[3], 100.0)
    p2 = chart.point.from_time(time,    100.0)
    line.new(p1, p2, xloc.bar_time, color=color.red, style=line.style_dashed)
    b1 = chart.point.from_time(time[3], 120.0)
    b2 = chart.point.from_time(time,     90.0)
    box.new(b1, b2, xloc.bar_time, bgcolor=color.blue)
plot(close)`);
    const line = ofType(e, 'line')[0];
    expect(typeof line.x1).toBe('number');
    expect(typeof line.x2).toBe('number');
    expect(line).toMatchObject({ y1: 100, y2: 100, xloc: 'bar_time', style: 'dashed' });
    expect(line.color).toBeDefined();
    const box = ofType(e, 'box')[0];
    expect(typeof box.left).toBe('number');
    expect(typeof box.right).toBe('number');
    expect(box).toMatchObject({ top: 120, bottom: 90, xloc: 'bar_time' });
    expect(box.bgcolor).toBeDefined();
  });
});

describe('fundamental-type keyword used as a variable name', () => {
  // Real-script gap (LuxAlgo ICT Concepts): `color = cond ? color.lime : color.red` declares a
  // local named `color`. The parser saw the `color` type keyword followed by `=` and tried to
  // parse a typed decl (`color <name>`), erroring "expected Ident (got Op '=')". A type keyword
  // followed by `=` / `:=` is a variable NAME; it now falls through to the expression-led path.
  const drawPool = (e: Engine) =>
    (e as unknown as { ctx: { drawPool: { objects: Map<number, { type: string; props: Record<string, unknown> }> } } }).ctx.drawPool;

  it('parses `color = …` and resolves it as a local shadowing the namespace (both backends)', async () => {
    const e = await bothBackends(`//@version=6
indicator("kw", overlay=true)
f(up) =>
    color = up ? color.lime : color.red
    line.new(bar_index - 1, low, bar_index, low, color = color)
if barstate.islast
    f(close > open)
plot(close)`);
    const lines = [...drawPool(e).objects.values()].filter((o) => o.type === 'line');
    expect(lines.length).toBe(1);
    expect(lines[0].props.color).toBeDefined(); // resolved to the local color (lime/red), not dropped
  });

  it('parses `:=` reassignment of a type-keyword-named variable', async () => {
    const e = await bothBackends(`//@version=6
indicator("kw2")
float = 1.0
float := float + close
plot(float, "f")`);
    expect(typeof last(e, 'f')).toBe('number');
  });
});

describe('drawing object caps (max_*_count) — most-recent-N retention', () => {
  // Real-script gap (LuxAlgo FVG Sessions): a script that draws a few lines per session
  // accumulates unboundedly over history. TradingView keeps only the most recent N of each
  // type (max_lines_count / …, default 50) and FIFO-evicts the oldest; piner kept everything,
  // so the host re-rendered thousands of objects. The pool now enforces the cap.
  const liveOfType = (e: Engine, t: string) =>
    [...(e as unknown as { ctx: { drawPool: { objects: Map<number, { type: string }> } } }).ctx.drawPool.objects.values()]
      .filter((o) => o.type === t).length;

  it('keeps only the last max_lines_count lines (FIFO eviction)', async () => {
    const c = compile(`//@version=6
indicator("cap", overlay=true, max_lines_count=3)
line.new(bar_index, low, bar_index, high)
plot(close)`);
    const e = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    await e.run({ symbol: 'X', timeframe: '60' });
    expect(liveOfType(e, 'line')).toBe(3); // one line per bar, capped at 3
  });

  it('defaults to 50 when no max_*_count is declared', async () => {
    const c = compile(`//@version=6
indicator("capd", overlay=true)
box.new(bar_index, high, bar_index, low)
plot(close)`);
    const e = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    await e.run({ symbol: 'X', timeframe: '60' });
    expect(liveOfType(e, 'box')).toBe(Math.min(50, bars.length));
  });
});
