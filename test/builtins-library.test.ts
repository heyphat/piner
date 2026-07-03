/**
 * Pine built-in *library* breadth & runtime behavior (beyond the core indicator
 * units in `ta.test.ts` and the context builtins in `builtins-ext.test.ts`):
 *  - extended `ta.*` single-value (roc/mom/rising/falling/variance/median/swma/
 *    linreg/vwma/stoch) and tuple-returning (`macd`, `bb`) functions,
 *  - the `array.*` / `map.*` / `matrix.*` collection namespaces,
 *  - generic `.new<T>()` construction and the method-call form `recv.method(...)`,
 *  - `alertcondition`,
 *  - realtime rollback of mutable `var` collections (deep-clone snapshot).
 *
 * Compile-and-run tests cross-check the codegen and interpreter backends.
 */
import { describe, it, expect } from 'bun:test';
import {
  compile,
  Engine,
  ArrayFeed,
  Ta,
  ArrayNs,
  MapNs,
  MatrixNs,
  isNa,
  type Bar,
} from '../src/index.js';

const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 105 + Math.sin(i),
  low: 95 + Math.cos(i),
  close: 100 + (i % 6) - 3,
  volume: 1000 + i * 10,
}));
const eqNaN = (a: number, b: number) =>
  (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;

async function bothBackends(src: string, data = bars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i]))
        throw new Error(`diverge plot ${id} bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
    }
  }
  return js;
}

describe('extended ta.* single-value functions', () => {
  it('roc / mom', () => {
    const ta = new Ta();
    ta.roc(10, 1, 0);
    expect(ta.roc(11, 1, 0)).toBeCloseTo(10, 9); // (11-10)/10*100
    const m = new Ta();
    m.mom(10, 1, 0);
    expect(m.mom(13, 1, 0)).toBe(3);
  });
  it('rising / falling over the window', () => {
    const r = new Ta();
    r.rising(1, 2, 0);
    r.rising(2, 2, 0);
    expect(r.rising(3, 2, 0)).toBe(true); // 1<2<3
    const f = new Ta();
    f.falling(3, 2, 0);
    f.falling(2, 2, 0);
    expect(f.falling(1, 2, 0)).toBe(true);
  });
  it('variance / median / percentrank', () => {
    const v = new Ta();
    v.variance(2, 3, 0);
    v.variance(4, 3, 0);
    expect(v.variance(6, 3, 0)).toBeCloseTo(8 / 3, 9);
    const md = new Ta();
    md.median(3, 3, 0);
    md.median(1, 3, 0);
    expect(md.median(2, 3, 0)).toBe(2); // sorted [1,2,3]
  });
  it('swma fixed weights [1,2,2,1]/6', () => {
    const ta = new Ta();
    ta.swma(1, 0);
    ta.swma(2, 0);
    ta.swma(3, 0);
    expect(ta.swma(4, 0)).toBeCloseTo((1 + 4 + 6 + 4) / 6, 9); // 1*1+2*2+3*2+4*1
  });
  it('linreg of a perfect line returns the line value', () => {
    const ta = new Ta();
    [1, 2, 3, 4].forEach((v) => ta.linreg(v, 5, 0, 0));
    expect(ta.linreg(5, 5, 0, 0)).toBeCloseTo(5, 6); // window [1..5], current point
  });
  it('vwma of constant price equals the price', () => {
    const ta = new Ta();
    const host = { open: 0, high: 0, low: 0, close: 0, volume: 500, time: 0 };
    ta.host = host;
    ta.vwma(50, 3, 0);
    ta.vwma(50, 3, 0);
    expect(ta.vwma(50, 3, 0)).toBeCloseTo(50, 9);
  });
  it('stoch is 100 at the window high and 0 at the low', () => {
    const ta = new Ta();
    ta.stoch(5, 10, 0, 3, 0);
    ta.stoch(5, 10, 0, 3, 0);
    expect(ta.stoch(10, 10, 0, 3, 0)).toBeCloseTo(100, 9);
    const lo = new Ta();
    lo.stoch(5, 10, 0, 3, 0);
    lo.stoch(5, 10, 0, 3, 0);
    expect(lo.stoch(0, 10, 0, 3, 0)).toBeCloseTo(0, 9);
  });
});

describe('tuple-returning ta.* (macd, bb)', () => {
  it('macd returns [line, signal, hist]; constant input → all 0', () => {
    const ta = new Ta();
    let r: number[] = [];
    for (let i = 0; i < 40; i++) r = ta.macd(100, 12, 26, 9, 0);
    expect(r.length).toBe(3);
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[2]).toBeCloseTo(0, 9);
  });
  it('bb returns [basis, upper, lower]; constant input → all equal', () => {
    const ta = new Ta();
    let r: number[] = [];
    for (let i = 0; i < 6; i++) r = ta.bb(50, 5, 2, 0);
    expect(r).toEqual([50, 50, 50]);
  });
  it('macd/bb destructure and cross-check across backends', async () => {
    await bothBackends(`//@version=6
indicator("osc")
[m, s, h] = ta.macd(close, 3, 6, 4)
[mid, up, lo] = ta.bb(close, 5, 2.0)
plot(m)
plot(s)
plot(h)
plot(mid)
plot(up)
plot(lo)
`);
  });
});

describe('array.* namespace', () => {
  it('core operations', () => {
    const a = ArrayNs.new_float(0);
    ArrayNs.push(a, 10);
    ArrayNs.push(a, 20);
    ArrayNs.push(a, 30);
    expect(ArrayNs.size(a)).toBe(3);
    expect(ArrayNs.get(a, 1)).toBe(20);
    expect(ArrayNs.sum(a)).toBe(60);
    expect(ArrayNs.avg(a)).toBe(20);
    expect(ArrayNs.min(a)).toBe(10);
    expect(ArrayNs.max(a)).toBe(30);
    ArrayNs.set(a, 0, 5);
    expect(ArrayNs.get(a, 0)).toBe(5);
    expect(ArrayNs.pop(a)).toBe(30);
    expect(ArrayNs.size(a)).toBe(2);
    expect(ArrayNs.get(a, 99)).toBeNaN(); // out of range
  });
  it('remaining operations (typed ctors, ends, insert/remove, search)', () => {
    expect(ArrayNs.new_int(2, 0)).toEqual([0, 0]);
    expect(ArrayNs.new_bool(1, true)).toEqual([true]);
    expect(ArrayNs.new_string(1, 'x')).toEqual(['x']);
    expect(ArrayNs.new_color(1)).toEqual(['#00000000']);
    const a = ArrayNs.new_float(0);
    ArrayNs.push(a, 2);
    ArrayNs.unshift(a, 1); // [1,2]
    ArrayNs.insert(a, 1, 9); // [1,9,2]
    expect(a).toEqual([1, 9, 2]);
    expect(ArrayNs.first(a)).toBe(1);
    expect(ArrayNs.last(a)).toBe(2);
    expect(ArrayNs.indexof(a, 9)).toBe(1);
    expect(ArrayNs.includes(a, 9)).toBe(true);
    expect(ArrayNs.remove(a, 1)).toBe(9); // [1,2]
    expect(ArrayNs.shift(a)).toBe(1); // [2]
    ArrayNs.reverse(a);
    expect(ArrayNs.size(a)).toBe(1);
    ArrayNs.clear(a);
    expect(ArrayNs.size(a)).toBe(0);
    expect(ArrayNs.pop(a)).toBeNaN(); // empty
  });
  it('compiles and cross-checks a growing var array', async () => {
    const eng = await bothBackends(`//@version=6
indicator("arr")
var prices = array.new_float(0)
array.push(prices, close)
n = array.size(prices)
avg = array.avg(prices)
plot(n)
plot(avg)
`);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(10); // grew once per bar
  });
});

describe('map.* namespace', () => {
  it('put / get / contains / remove / keys / values / size', () => {
    const m = MapNs.new();
    MapNs.put(m, 'a', 1);
    MapNs.put(m, 'b', 2);
    expect(MapNs.get(m, 'a')).toBe(1);
    expect(isNa(MapNs.get(m, 'z'))).toBe(true);
    expect(MapNs.contains(m, 'b')).toBe(true);
    expect(MapNs.size(m)).toBe(2);
    expect(MapNs.keys(m)).toEqual(['a', 'b']);
    expect(MapNs.values(m)).toEqual([1, 2]);
    expect(MapNs.remove(m, 'a')).toBe(1);
    expect(MapNs.size(m)).toBe(1);
    MapNs.clear(m);
    expect(MapNs.size(m)).toBe(0);
  });
});

describe('matrix.* namespace', () => {
  it('new / get / set / rows / columns / add_row / sum', () => {
    const m = MatrixNs.new(2, 2, 0);
    expect(MatrixNs.rows(m)).toBe(2);
    expect(MatrixNs.columns(m)).toBe(2);
    MatrixNs.set(m, 0, 0, 5);
    MatrixNs.set(m, 1, 1, 7);
    expect(MatrixNs.get(m, 0, 0)).toBe(5);
    expect(isNa(MatrixNs.get(m, 9, 9))).toBe(true);
    // matrix.sum is element-wise (matrix+scalar → new matrix), per Pine v6.
    expect(MatrixNs.get(MatrixNs.sum(m, 1), 0, 0)).toBe(6);
    MatrixNs.add_row(m, 2, [1, 1]); // insert at index 2 (append) with values
    expect(MatrixNs.rows(m)).toBe(3);
    expect(MatrixNs.get(m, 2, 0)).toBe(1);
  });
});

describe('generic .new<T>() syntax compiles and runs', () => {
  it('array.new<float>, map.new<string,float>, matrix.new<float>', async () => {
    const eng = await bothBackends(`//@version=6
indicator("gen")
var a = array.new<float>(0)
array.push(a, close)
var m = map.new<string, float>()
map.put(m, "last", close)
var mx = matrix.new<float>(1, 1, 0.0)
matrix.set(mx, 0, 0, close)
plot(array.size(a))
plot(map.get(m, "last"))
plot(matrix.get(mx, 0, 0))
`);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(10); // array grew each bar
    expect(eng.outputs.plots.get(1)!.data[9]).toBe(bars[9].close);
    expect(eng.outputs.plots.get(2)!.data[9]).toBe(bars[9].close);
  });

  it('`a < b` after a non-member ident is still a comparison (no false type-arg parse)', async () => {
    await bothBackends(`//@version=6
indicator("cmp")
x = close
y = open
plot(x < y ? 1.0 : 0.0)
`);
  });
});

describe('method-call form (recv.method(args))', () => {
  it('array methods via dot-call, cross-checked', async () => {
    const eng = await bothBackends(`//@version=6
indicator("mc")
var prices = array.new<float>(0)
prices.push(close)
plot(prices.size())
plot(prices.get(0))
`);
    expect(eng.outputs.plots.get(0)!.data[9]).toBe(10);
    expect(eng.outputs.plots.get(1)!.data[9]).toBe(bars[0].close); // first element
  });
  it('map and matrix methods via dot-call', async () => {
    await bothBackends(`//@version=6
indicator("mc2")
var m = map.new<string, float>()
m.put("k", close)
var mx = matrix.new<float>(1, 1, 0.0)
mx.set(0, 0, close)
plot(m.get("k"))
plot(m.size())
plot(mx.get(0, 0))
plot(mx.rows())
`);
  });
  it('drawing methods via dot-call', async () => {
    const eng = new Engine(
      compile(`//@version=6
indicator("d")
var l = line.new(bar_index, low, bar_index, high)
l.set_y2(close)
l.set_color(color.red)
plot(close)
`),
      new ArrayFeed(bars),
    );
    await eng.run({ symbol: 'T', timeframe: '1' });
    const l = eng.drawings[0];
    expect(l.props.y2).toBe(bars[bars.length - 1].close);
    expect(l.props.color).toMatch(/^#/);
  });
});

describe('alertcondition', () => {
  it('records an alert on bars where the condition is true', async () => {
    const c = compile(`//@version=6
indicator("al")
alertcondition(close > open, title="up", message="long signal")
plot(close)
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    const expected = bars.filter((b) => b.close > b.open).length;
    expect(eng.outputs.alerts.length).toBe(expected);
    if (expected) expect(eng.outputs.alerts[0].message).toBe('long signal');
  });
});

describe('var collections survive realtime rollback (deep-clone snapshot)', () => {
  it('a var array: a developing tick does not permanently grow the committed array', async () => {
    const c = compile(`//@version=6
indicator("arr")
var prices = array.new_float(0)
array.push(prices, close)
plot(array.size(prices))
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    const committed = eng.outputs.plots.get(0)!.data[bars.length - 1];
    expect(committed).toBe(bars.length);
    const t = bars.length;
    eng.tick({ time: t * 60000, open: 1, high: 1, low: 1, close: 1, volume: 1 }, false);
    expect(eng.outputs.plots.get(0)!.data[t]).toBe(committed + 1); // one push on the realtime bar
    // a second update must roll back the array, not push on top
    eng.tick({ time: t * 60000, open: 1, high: 2, low: 1, close: 2, volume: 1 }, false);
    expect(eng.outputs.plots.get(0)!.data[t]).toBe(committed + 1);
  });

  it('a var map: a map mutated on a developing tick rolls back', async () => {
    const c = compile(`//@version=6
indicator("m")
var counts = map.new<string, float>()
map.put(counts, "n", nz(map.get(counts, "n"), 0.0) + 1.0)
plot(map.get(counts, "n"))
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    const committed = eng.outputs.plots.get(0)!.data[bars.length - 1];
    expect(committed).toBe(bars.length);
    const t = bars.length;
    eng.tick({ time: t * 60000, open: 1, high: 2, low: 0, close: 1, volume: 1 }, false);
    expect(eng.outputs.plots.get(0)!.data[t]).toBe(committed + 1);
    eng.tick({ time: t * 60000, open: 1, high: 3, low: 0, close: 2, volume: 1 }, false);
    expect(eng.outputs.plots.get(0)!.data[t]).toBe(committed + 1); // rolled back, not +2
  });
});
