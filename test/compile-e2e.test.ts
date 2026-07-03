import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// Deterministic sample OHLCV.
function makeBars(n: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 3) * 2 + (i % 5) - 2;
    const close = price;
    const open = price - Math.cos(i / 4);
    const high = Math.max(open, close) + 1.5;
    const low = Math.min(open, close) - 1.5;
    bars.push({ time: i * 60000, open, high, low, close, volume: 1000 + i });
  }
  return bars;
}

const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

/** Run a compiled script through both backends and assert identical plot/shape output. */
function crossCheck(src: string, bars: Bar[]) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  // run synchronously via the same feed
  return Promise.all([
    js.run({ symbol: 'T', timeframe: '1' }),
    ip.run({ symbol: 'T', timeframe: '1' }),
  ]).then(() => {
    for (const [id, jsPlot] of js.outputs.plots) {
      const ipPlot = ip.outputs.plots.get(id)!;
      expect(ipPlot).toBeDefined();
      expect(jsPlot.data.length).toBe(ipPlot.data.length);
      for (let i = 0; i < jsPlot.data.length; i++) {
        if (!eqNaN(jsPlot.data[i], ipPlot.data[i])) {
          throw new Error(
            `backend divergence in plot ${id} ('${jsPlot.title}') at bar ${i}: js=${jsPlot.data[i]} interp=${ipPlot.data[i]}`,
          );
        }
      }
    }
    for (const [id, jsMark] of js.outputs.markers) {
      const ipMark = ip.outputs.markers.get(id)!;
      for (let i = 0; i < jsMark.data.length; i++) {
        expect(!!jsMark.data[i]).toBe(!!ipMark.data[i]); // marker shown/hidden parity
      }
    }
    return js;
  });
}

const bars = makeBars(60);

describe('compile → run (end to end)', () => {
  it('SMA crossover (overlay metadata, plots, plotshape)', async () => {
    const src = `//@version=6
indicator("SMA Cross", overlay=true)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
plot(fast, title="fast")
plot(slow, title="slow")
up = ta.crossover(fast, slow)
plotshape(up, title="up")
`;
    const c = compile(src);
    expect(c.metadata.title).toBe('SMA Cross');
    expect(c.metadata.overlay).toBe(true);
    const eng = await crossCheck(src, bars);
    const fast = eng.outputs.plots.get(0)!;
    // first 4 bars have < 5 samples → na, then numeric
    expect(fast.data[0]).toBeNaN();
    expect(Number.isNaN(fast.data[10])).toBe(false);
  });

  it('var persistence + history (close[1]) cross-checks', async () => {
    const src = `//@version=6
indicator("Cumulative")
var float total = 0.0
total := total + close
diff = close - close[1]
plot(total, title="t")
plot(diff, title="d")
`;
    const eng = await crossCheck(src, bars);
    const total = eng.outputs.plots.get(0)!.data;
    // running sum is monotonic in count of additions; equals sum of closes
    let acc = 0;
    for (let i = 0; i < bars.length; i++) {
      acc += bars[i].close;
      expect(total[i]).toBeCloseTo(acc, 6);
    }
    expect(eng.outputs.plots.get(1)!.data[0]).toBeNaN(); // close[1] na on first bar
  });

  it('RSI + hline cross-checks', () =>
    crossCheck(
      `//@version=6
indicator("RSI")
r = ta.rsi(close, 14)
plot(r, title="rsi")
hline(70, title="ob")
`,
      bars,
    ));

  it('Bollinger bands (sma + stdev) cross-checks', () =>
    crossCheck(
      `//@version=6
indicator("BB")
length = 20
basis = ta.sma(close, length)
dev = 2.0 * ta.stdev(close, length)
plot(basis, title="basis")
plot(basis + dev, title="upper")
plot(basis - dev, title="lower")
`,
      bars,
    ));

  it('ternary / math / nz / comparisons cross-check', () =>
    crossCheck(
      `//@version=6
indicator("misc")
x = close > open ? high : low
y = math.max(close, open)
z = nz(close[1], close)
w = close > open and volume > 1000 ? 1.0 : 0.0
plot(x)
plot(y)
plot(z)
plot(w)
`,
      bars,
    ));

  it('if-expression and for-loop cross-check', () =>
    crossCheck(
      `//@version=6
indicator("control")
sumv = 0.0
for i = 1 to 3
    sumv := sumv + close[i]
avg = if bar_index > 5
    sumv / 3.0
else
    close
plot(avg)
`,
      bars,
    ));

  it('multiline string reaches the runtime intact (length counts the \\n)', async () => {
    // """ab<newline>cd""" → "ab\ncd" → str.length 5. Proves the lexed value flows
    // through parse → codegen → both backends unchanged.
    const eng = await crossCheck(
      `//@version=6
indicator("ml")
msg = """ab
cd"""
plot(str.length(msg))
`,
      bars,
    );
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(5);
  });
});

describe('diagnostics', () => {
  it('flags `== na` as a warning', () => {
    const c = compile(`//@version=6
indicator("x")
b = close == na
plot(b ? 1.0 : 0.0)
`);
    expect(c.diagnostics.some((d) => d.severity === 'warning' && /na/.test(d.message))).toBe(true);
  });

  it('errors on undefined variable', () => {
    expect(() =>
      compile(`//@version=6
indicator("x")
plot(undefinedVar)
`),
    ).toThrow(/undefined variable/);
  });
});

describe('compiled script repaints on realtime ticks', () => {
  it('rolls back a var running-sum each tick', async () => {
    const src = `//@version=6
indicator("c")
var float total = 0.0
total := total + close
plot(total, title="t")
`;
    const c = compile(src);
    const eng = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    await eng.run({ symbol: 'T', timeframe: '1' });
    const committedSum = eng.outputs.plots.get(0)!.data[bars.length - 1];

    const t = bars.length;
    eng.tick({ time: t * 60000, open: 50, high: 60, low: 40, close: 50, volume: 1 }, false);
    const afterFirst = eng.outputs.plots.get(0)!.data[t];
    expect(afterFirst).toBeCloseTo(committedSum + 50, 6);
    // update tick: must roll back (not add on top of the previous tick)
    eng.tick({ time: t * 60000, open: 50, high: 70, low: 40, close: 70, volume: 1 }, false);
    expect(eng.outputs.plots.get(0)!.data[t]).toBeCloseTo(committedSum + 70, 6);
  });
});
