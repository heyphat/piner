import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';
import { Ta } from '../src/runtime/builtins/ta.js';
import { ArrayNs } from '../src/runtime/builtins/array.js';
import { MatrixNs } from '../src/runtime/builtins/matrix.js';

const bars: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 6 + (i % 5);
  return { time: i * 60000, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i * 10 };
});
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;
async function crossCheck(src: string, data = bars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '60' });
  await ip.run({ symbol: 'BTCUSD', timeframe: '60' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) if (!eqNaN(jp.data[i], ipp.data[i])) throw new Error(`diverge plot ${id} bar ${i}`);
  }
  return js;
}

describe('NA representation (clone-safe) — regression for the structuredClone bug', () => {
  it('a reference-typed var left as na does not break the rollback snapshot', async () => {
    // Previously threw "The object can not be cloned" (NA was a Symbol).
    await crossCheck('//@version=6\nindicator("x")\nvar line myLine = na\nvar label lb = na\nplot(close)\n');
  });
});

describe('date/time builtins (leaves + functions)', () => {
  it('reads year/month/dayofmonth/hour/minute from the bar time', async () => {
    const t0 = Date.UTC(2021, 5, 15, 10, 30, 0); // Jun 15 2021 10:30 UTC
    const dbars: Bar[] = [{ time: t0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const c = compile('//@version=6\nindicator("x")\nplot(year)\nplot(month)\nplot(dayofmonth)\nplot(hour)\nplot(minute)\nplot(year(time))\n');
    const eng = new Engine(c, new ArrayFeed(dbars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(2021);
    expect(eng.outputs.plots.get(1)!.data[0]).toBe(6);
    expect(eng.outputs.plots.get(2)!.data[0]).toBe(15);
    expect(eng.outputs.plots.get(3)!.data[0]).toBe(10);
    expect(eng.outputs.plots.get(4)!.data[0]).toBe(30);
    expect(eng.outputs.plots.get(5)!.data[0]).toBe(2021); // year(time) function form
  });
});

describe('syminfo.* / timeframe.* from the run', () => {
  it('exposes symbol and timeframe info', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(timeframe.in_seconds())\nplot(timeframe.isintraday ? 1.0 : 0.0)\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(60 * 60); // "60" minutes → 3600s
    expect(eng.outputs.plots.get(1)!.data[0]).toBe(1);
    expect(c.metadata.title).toBe('x');
  });
});

describe('expanded ta.* (cross-checked) + key properties', () => {
  it('hma/cog/cmo/bbw/cci/wpr/vwap/sar/alma + tuple kc/dmi/supertrend cross-check', () =>
    crossCheck(`//@version=6
indicator("ta+")
plot(ta.hma(close, 9))
plot(ta.cog(close, 10))
plot(ta.cmo(close, 9))
plot(ta.bbw(close, 20, 2.0))
plot(ta.cci(hlc3, 20))
plot(ta.wpr(14))
plot(ta.vwap(hlc3))
plot(ta.sar(0.02, 0.02, 0.2))
plot(ta.alma(close, 9, 0.85, 6))
plot(math.sum(close, 5))
[kmid, kup, klo] = ta.kc(close, 20, 2.0)
plot(kmid)
[dip, dim, adx] = ta.dmi(14, 14)
plot(adx)
[st, dir] = ta.supertrend(3.0, 10)
plot(st)
ph = ta.pivothigh(2, 2)
plot(ph)
`));
  it('supertrend direction uses TV sign: -1 in an uptrend, +1 in a downtrend', () => {
    // Regression for the inverted-signal bug (LuxAlgo "Apex Signals"): TradingView's
    // ta.supertrend returns direction = -1 for an uptrend (trail below price) and +1 for a
    // downtrend (trail above price) — the convention the `trendUp = dir < 0` idiom relies on.
    const ta = new Ta();
    const feed = (c: number) => { ta.host = { open: c, high: c + 1, low: c - 1, close: c, volume: 1000, time: 0 }; return ta.supertrend(3.0, 10, 0); };
    let dir = NaN, line = NaN;
    for (let i = 0; i < 40; i++) [line, dir] = feed(100 + i * 2); // strong, sustained uptrend
    expect(dir).toBe(-1);
    expect(line).toBeLessThan(ta.host.close); // trail sits below price in an uptrend
    for (let i = 0; i < 40; i++) [line, dir] = feed(180 - i * 2); // reverse into a downtrend
    expect(dir).toBe(1);
    expect(line).toBeGreaterThan(ta.host.close); // trail sits above price in a downtrend
  });
  it('requestUpAndDownVolume classifies a bar by candle direction (down vol negative)', () => {
    // TradingView/ta library fn. Without intrabar data piner returns the single-bar degenerate:
    // up volume on a green bar, NEGATIVE down volume on a red bar (callers take math.abs).
    const ta = new Ta();
    ta.host = { open: 10, high: 12, low: 9, close: 11, volume: 500, time: 0 };
    expect(ta.requestUpAndDownVolume('1', 0)).toEqual([500, 0, 500]);
    ta.host = { open: 11, high: 12, low: 8, close: 9, volume: 500, time: 0 };
    expect(ta.requestUpAndDownVolume('1', 0)).toEqual([0, -500, -500]);
  });
  it('cmo is +100 for a strictly rising series', () => {
    const ta = new Ta();
    let r = NaN;
    for (let i = 1; i <= 12; i++) r = ta.cmo(i, 9, 0);
    expect(r).toBe(100);
  });
  it('math.sum is the rolling window sum', () => {
    const ta = new Ta();
    ta.sum(1, 3, 0); ta.sum(2, 3, 0);
    expect(ta.sum(3, 3, 0)).toBe(6); // 1+2+3
    expect(ta.sum(4, 3, 0)).toBe(9); // 2+3+4
  });
});

describe('collection methods (array / matrix)', () => {
  it('array: copy/slice/concat/sort/median/stdev/covariance', () => {
    const a = [3, 1, 2];
    expect(ArrayNs.copy(a)).toEqual([3, 1, 2]);
    expect(ArrayNs.slice(a, 1, 3)).toEqual([1, 2]);
    const b = ArrayNs.copy(a);
    ArrayNs.concat(b, [9]);
    expect(b).toEqual([3, 1, 2, 9]);
    const s = [3, 1, 2];
    ArrayNs.sort(s);
    expect(s).toEqual([1, 2, 3]);
    expect(ArrayNs.median([1, 2, 3])).toBe(2);
    expect(ArrayNs.stdev([2, 2, 2])).toBeCloseTo(0, 12);
    expect(ArrayNs.covariance([1, 2, 3], [1, 2, 3])).toBeCloseTo(2 / 3, 9);
  });
  it('matrix: copy/transpose/row/col', () => {
    const m = MatrixNs.new(2, 2, 0);
    MatrixNs.set(m, 0, 1, 5);
    const t = MatrixNs.transpose(m);
    expect(MatrixNs.get(t, 1, 0)).toBe(5);
    expect(MatrixNs.row(m, 0)).toEqual([0, 5]);
    expect(MatrixNs.col(m, 1)).toEqual([5, 0]);
    expect(MatrixNs.copy(m).data).toEqual(m.data);
  });
});

describe('constant namespaces resolve (compile-only)', () => {
  it('xloc/extend/format/font/text/currency/barmerge/order/math constants', () => {
    expect(() => compile(`//@version=6
indicator("x")
var l = line.new(bar_index, high, bar_index, low, xloc = xloc.bar_time, extend = extend.both)
arr = array.from(3.0, 1.0, 2.0)
array.sort(arr, order.descending)
c = math.pi + math.e
plot(c)
`)).not.toThrow();
  });
});
