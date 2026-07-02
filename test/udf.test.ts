import { describe, it, expect } from 'bun:test';
import { compile, CompileError, Engine, ArrayFeed, type Bar } from '../src/index.js';

const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({
  time: i * 60000, open: 100 + i, high: 110 + i, low: 90 + i, close: 100 + i * 2, volume: 1000 + i,
}));
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;

async function bothBackends(src: string, data = bars) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) throw new Error(`diverge plot ${id} bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
    }
  }
  return js;
}

describe('user-defined functions — basics', () => {
  it('single-line function', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\ndbl(x) => x * 2.0\nplot(dbl(close))\n');
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(bars[5].close * 2);
  });

  it('a method arg referencing the caller `this` resolves to the caller, not the receiver', async () => {
    // Regression: make() reads this.name and passes it to d.show(this.name); the inliner used
    // to bind the receiver `this` BEFORE the sibling arg, so this.name read the RECEIVER (d)
    // instead of the caller (i) → na. (LuxAlgo "Trading Sessions" session labels hit this.)
    const src = `//@version=6
indicator("u", overlay=true)
type Disp
    label lbl
type Info
    color color
    string name
method show(Disp this, string nm) =>
    label.set_text(this.lbl, nm)
method make(Info this) =>
    d = Disp.new(label.new(bar_index, high, ""))
    d.show(this.name)
i = Info.new(color.red, "Tokyo")
if barstate.islast
    i.make()
plot(close)
`;
    for (const backend of ['js', 'interp'] as const) {
      const eng = new Engine(compile(src), new ArrayFeed(bars), { backend });
      await eng.run({ symbol: 'T', timeframe: '1' });
      const lbl = eng.drawings.find((d) => d.type === 'label')!;
      expect(lbl.props.text).toBe('Tokyo'); // not na — caller's this.name
    }
  });
  it('multi-line function with locals and a return expression', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nrange(h, l) =>\n    d = h - l\n    d * 2.0\nplot(range(high, low))\n');
    expect(eng.outputs.plots.get(0)!.data[5]).toBe((bars[5].high - bars[5].low) * 2);
  });
  it('default parameter', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nma(src, len = 3) => ta.sma(src, len)\nplot(ma(close))\nplot(ma(close, 5))\n');
    // plot0 uses len=3, plot1 uses len=5 → differ once both warmed
    expect(eng.outputs.plots.get(0)!.data[6]).not.toBe(eng.outputs.plots.get(1)!.data[6]);
  });
  it('named arguments (order-independent)', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nsub(a, b) => a - b\nplot(sub(b = open, a = close))\n');
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(bars[5].close - bars[5].open);
  });
  it('nested function calls', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nadd1(x) => x + 1.0\ndbl(x) => x * 2.0\nplot(dbl(add1(close)))\n');
    expect(eng.outputs.plots.get(0)!.data[5]).toBe((bars[5].close + 1) * 2);
  });
  it('an argument referencing a caller variable named like an earlier parameter does not capture it', async () => {
    // Regression: params were bound as same-named sequential decls, so in f(1, a) the
    // second argument `a` read the freshly-bound parameter `a` (1) instead of the
    // caller's `a` (100) → 0 instead of -99. Args now bind to fresh temps first.
    const eng = await bothBackends('//@version=6\nindicator("u")\nf(a, b) => a - b\na = 100.0\nplot(f(1, a))\n');
    for (let i = 0; i < bars.length; i++) expect(eng.outputs.plots.get(0)!.data[i]).toBe(-99);
  });
  it('multi-return tuple destructuring', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nmm(src, len) => [ta.sma(src, len), ta.stdev(src, len)]\n[m, s] = mm(close, 5)\nplot(m)\nplot(s)\n');
    expect(Number.isNaN(eng.outputs.plots.get(0)!.data[8])).toBe(false);
  });
});

describe('user-defined functions — per-call-site state (monomorphization)', () => {
  it('two calls keep INDEPENDENT stateful series (no shared accumulator)', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\ncounter() => ta.cum(1.0)\nx = counter()\ny = counter()\nplot(x)\nplot(y)\n');
    const x = eng.outputs.plots.get(0)!.data;
    const y = eng.outputs.plots.get(1)!.data;
    // independent cum accumulators → each advances once/bar → x == y == bar+1
    for (let i = 0; i < bars.length; i++) {
      expect(x[i]).toBe(i + 1);
      expect(y[i]).toBe(i + 1);
    }
  });
  it('different args to the same function produce independent results', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\navg(src, len) => ta.sma(src, len)\nplot(avg(close, 3))\nplot(ta.sma(close, 3))\n');
    const viaUdf = eng.outputs.plots.get(0)!.data;
    const direct = eng.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) expect(eqNaN(viaUdf[i], direct[i])).toBe(true);
  });
  it('a stateful argument is evaluated exactly once (bound to a local)', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\ndbl(v) => v + v\nplot(dbl(ta.cum(1.0)))\n');
    // cum advances once/bar (arg bound once) → result = 2*(bar+1), not 2x-advanced
    const r = eng.outputs.plots.get(0)!.data;
    for (let i = 0; i < bars.length; i++) expect(r[i]).toBe(2 * (i + 1));
  });
  it('internal var persists independently per call site', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\nrun(x) =>\n    var float acc = 0.0\n    acc := acc + x\n    acc\nplot(run(1.0))\nplot(run(2.0))\n');
    expect(eng.outputs.plots.get(0)!.data[bars.length - 1]).toBe(bars.length);       // sum of 1s
    expect(eng.outputs.plots.get(1)!.data[bars.length - 1]).toBe(2 * bars.length);   // sum of 2s — independent
  });
  it('a function whose last statement is an assignment returns the assigned value', async () => {
    // f returns the value of `g := g + x` (the new g), not na.
    const eng = await bothBackends('//@version=6\nindicator("u")\nvar float g = 0.0\nf(x) =>\n    g := g + x\nplot(f(2.0))\n');
    const p = eng.outputs.plots.get(0)!.data;
    for (let i = 0; i < bars.length; i++) expect(p[i]).toBe(2 * (i + 1)); // running sum returned each bar
  });
  it('parameter history works and the arg runs once', async () => {
    const eng = await bothBackends('//@version=6\nindicator("u")\ndelta(src) => src - src[1]\nplot(delta(close))\n');
    const d = eng.outputs.plots.get(0)!.data;
    expect(d[0]).toBeNaN();
    for (let i = 1; i < bars.length; i++) expect(d[i]).toBe(bars[i].close - bars[i - 1].close);
  });
});

describe('user-defined functions — diagnostics', () => {
  it('rejects direct recursion', () => {
    expect(() => compile('//@version=6\nindicator("u")\nf(x) => f(x) + 1.0\nplot(f(close))\n')).toThrow(/recurs/i);
  });
  it('rejects mutual recursion', () => {
    expect(() => compile('//@version=6\nindicator("u")\nf(x) => g(x) + 1.0\ng(x) => f(x) + 1.0\nplot(f(close))\n')).toThrow(CompileError);
  });
  it('does NOT spuriously warn about stateful calls inside the (always-run) inlined body', () => {
    const c = compile('//@version=6\nindicator("u")\nrsi14(src) => ta.rsi(src, 14)\nplot(rsi14(close))\n');
    expect(c.diagnostics.some((d) => d.severity === 'warning' && /stateful/.test(d.message))).toBe(false);
  });
});

describe('user-defined methods (dot-call dispatch)', () => {
  const HEAD = '//@version=6\nindicator("m")\ntype Rect\n    float w\n    float h\n';
  it('receiver.method() binds the receiver as `this`', async () => {
    const eng = await bothBackends(`${HEAD}method area(Rect this) => this.w * this.h\nr = Rect.new(close, 2.0)\nplot(r.area())\n`);
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(bars[5].close * 2);
  });
  it('method with extra args, and a method returning a UDT, chained', async () => {
    const eng = await bothBackends(`${HEAD}method area(Rect this) => this.w * this.h\nmethod scale(Rect this, float k) => Rect.new(this.w * k, this.h * k)\nr = Rect.new(close, 2.0)\nplot(r.scale(3.0).area())\n`);
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(bars[5].close * 18); // (close*3)*(2*3)
  });
  it('the same method is also callable in function form', async () => {
    const eng = await bothBackends(`${HEAD}method area(Rect this) => this.w * this.h\nr = Rect.new(close, 2.0)\nplot(area(r))\n`);
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(bars[5].close * 2);
  });
  it('per-call-site state: stateful body advances independently per dot-call site', async () => {
    // each `.smooth()` call site gets its own ta.sma window (monomorphization)
    const eng = await bothBackends(`${HEAD}method smooth(Rect this) => ta.sma(this.w, 3)\nr = Rect.new(close, 0.0)\nplot(r.smooth())\nplot(r.smooth())\n`);
    const a = eng.outputs.plots.get(0)!.data, b = eng.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) expect(a[i]).toBe(b[i]); // identical yet independent state
  });
  it('a user method named like a str.* function does not hijack the namespace call', async () => {
    // Regression: `str.tonumber("2")` was rewritten to `tonumber(str, "2")` whenever a
    // user `method tonumber` existed (`tonumber` is not in BUILTIN_METHODS). A bare
    // builtin-namespace receiver must never get method sugar; the dot-call on a real
    // receiver still dispatches to the user method.
    const eng = await bothBackends(`${HEAD}method tonumber(Rect this) => this.w * 10.0\nr = Rect.new(2.0, 0.0)\nplot(str.tonumber("2") + 1)\nplot(r.tonumber())\n`);
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(3); // builtin: numeric add, not concat
    expect(eng.outputs.plots.get(1)!.data[5]).toBe(20); // user method via dot-call
  });
  it('a user method named like a built-in does not shadow the built-in (arr.push stays built-in)', async () => {
    const eng = await bothBackends(`${HEAD}method push(Rect this, float x) => this.w + x\nvar a = array.new<float>(0)\narray.push(a, close)\nr = Rect.new(10.0, 0.0)\nplot(array.size(a))\nplot(na(r.push(close)) ? -1.0 : r.push(close))\n`);
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(6); // builtin push ran each bar (6 bars in)
    expect(eng.outputs.plots.get(1)!.data[5]).toBe(-1); // builtin-named user method → na via dot-call
  });
});
