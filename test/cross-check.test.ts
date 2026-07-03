import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar, type CompiledScript } from '../src/index.js';

// ── deterministic data & RNG ────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeBars(n: number, seed = 1): Bar[] {
  const r = mulberry32(seed);
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price = Math.max(1, price + (r() - 0.5) * 6);
    const open = price + (r() - 0.5) * 2;
    const close = price + (r() - 0.5) * 2;
    const high = Math.max(open, close) + r() * 2;
    const low = Math.min(open, close) - r() * 2;
    bars.push({ time: i * 60000, open, high, low, close, volume: Math.floor(r() * 5000) });
  }
  return bars;
}

const eqNaN = (a: unknown, b: unknown) =>
  (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) || a === b;

/** Run both backends historically (+ optional realtime ticks) and assert identical outputs. */
async function crossCheck(c: CompiledScript, bars: Bar[], ticks: [Bar, boolean][] = []) {
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [bar, close] of ticks) {
    js.tick(bar, close);
    ip.tick(bar, close);
  }

  expect([...ip.outputs.plots.keys()].sort()).toEqual([...js.outputs.plots.keys()].sort());
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    expect(jp.data.length).toBe(ipp.data.length);
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) {
        throw new Error(
          `plot ${id} '${jp.title}' diverged at bar ${i}: js=${jp.data[i]} interp=${ipp.data[i]}`,
        );
      }
    }
  }
  return js;
}

const bars = makeBars(80, 7);

// ── hand-written battery ────────────────────────────────────
const SCRIPTS: Record<string, string> = {
  'all ta functions': `//@version=6
indicator("ta")
plot(ta.sma(close, 5), title="sma")
plot(ta.ema(close, 5), title="ema")
plot(ta.rma(close, 5), title="rma")
plot(ta.wma(close, 5), title="wma")
plot(ta.rsi(close, 14), title="rsi")
plot(ta.atr(14), title="atr")
plot(ta.tr(), title="tr")
plot(ta.highest(high, 10), title="hh")
plot(ta.lowest(low, 10), title="ll")
plot(ta.stdev(close, 20), title="sd")
plot(ta.change(close), title="ch")
plot(ta.cum(volume), title="cum")
`,
  'nested ternary + logical short-circuit': `//@version=6
indicator("t")
a = close > open and high > close ? 1.0 : close < open or low < open ? -1.0 : 0.0
b = na(close[5]) ? close : close[5]
plot(a)
plot(b)
`,
  'if-expression and switch-expression': `//@version=6
indicator("c")
trend = if ta.sma(close, 5) > ta.sma(close, 20)
    1.0
else if close > open
    0.5
else
    0.0
sw = switch
    close > high[1] => 2.0
    close < low[1] => -2.0
    => 0.0
plot(trend)
plot(sw)
`,
  'for loop accumulation + history': `//@version=6
indicator("f")
s = 0.0
for i = 0 to 4
    s := s + close[i]
plot(s / 5.0)
`,
  'var + varip + compound assignment': `//@version=6
indicator("v")
var float total = 0.0
total += close
var int n = 0
n := n + 1
plot(total / n)
`,
  'math + casts + nz': `//@version=6
indicator("m")
x = math.max(close, open) - math.min(close, open)
y = math.abs(close - open)
k = int(close / 10.0)
plot(x)
plot(y)
plot(nz(close[3], 0.0))
plot(k)
`,
  'while loop with dynamic history offset': `//@version=6
indicator("w")
i = 0
s = 0.0
while i < 3
    s := s + close[i]
    i := i + 1
plot(s / 3.0)
`,
  'switch statement with reassignment + derived-leaf history': `//@version=6
indicator("sw")
var float sig = 0.0
switch
    close > open => sig := 1.0
    close < open => sig := -1.0
    => sig := 0.0
trend = hl2 - hl2[2]
plot(sig)
plot(trend)
plotshape(sig > 0.0, title="long")
hline(0.0, title="zero")
`,
};

describe('cross-check battery (codegen == interpreter)', () => {
  for (const [name, src] of Object.entries(SCRIPTS)) {
    it(name, async () => {
      await crossCheck(compile(src), bars);
    });
  }
});

// ── randomized fuzzer ───────────────────────────────────────
function makeGenerator(seed: number) {
  const r = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const series = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'volume'];
  const len = () => String(2 + Math.floor(r() * 5));

  function numeric(depth: number): string {
    if (depth <= 0 || r() < 0.3) {
      const k = r();
      if (k < 0.4) return pick(series);
      if (k < 0.55) return `${pick(series)}[${Math.floor(r() * 4)}]`;
      return (r() * 50).toFixed(2);
    }
    const form = r();
    if (form < 0.3)
      return `(${numeric(depth - 1)} ${pick(['+', '-', '*', '/'])} ${numeric(depth - 1)})`;
    if (form < 0.55) {
      const fn = pick([
        'ta.sma',
        'ta.ema',
        'ta.rma',
        'ta.wma',
        'ta.stdev',
        'ta.highest',
        'ta.lowest',
        'ta.rsi',
      ]);
      return `${fn}(${pick(series)}, ${len()})`;
    }
    if (form < 0.65) return `ta.atr(${len()})`;
    if (form < 0.72) return `ta.change(${pick(series)})`;
    if (form < 0.82)
      return `${pick(['math.max', 'math.min'])}(${numeric(depth - 1)}, ${numeric(depth - 1)})`;
    if (form < 0.9) return `math.abs(${numeric(depth - 1)})`;
    if (form < 0.96) return `(${cond(depth - 1)} ? ${numeric(depth - 1)} : ${numeric(depth - 1)})`;
    return `nz(${numeric(depth - 1)}, ${numeric(depth - 1)})`;
  }
  function cond(depth: number): string {
    if (depth <= 0 || r() < 0.5)
      return `${numeric(depth)} ${pick(['<', '>', '<=', '>=', '==', '!='])} ${numeric(depth)}`;
    return `(${cond(depth - 1)} ${pick(['and', 'or'])} ${cond(depth - 1)})`;
  }
  return { numeric };
}

describe('cross-check fuzzer (40 random scripts, codegen == interpreter)', () => {
  for (let s = 0; s < 40; s++) {
    it(`random script seed=${s}`, async () => {
      const gen = makeGenerator(s + 1);
      const plots = Array.from({ length: 4 }, (_, i) => `plot(${gen.numeric(3)}, title="p${i}")`);
      const src = `//@version=6\nindicator("fuzz")\n${plots.join('\n')}\n`;
      await crossCheck(compile(src), makeBars(50, s + 100));
    });
  }
});

// ── realtime rollback / varip replay ────────────────────────
describe('cross-check under realtime tick replay (rollback + varip)', () => {
  it('var rolls back per tick; varip persists across ticks; both backends agree', async () => {
    const src = `//@version=6
indicator("rt")
var int bars = 0
bars := bars + 1
varip int ticks = 0
ticks := ticks + 1
total = ta.sma(close, 5)
plot(bars, title="bars")
plot(ticks, title="ticks")
plot(total, title="sma")
`;
    const t = bars.length;
    const ticks: [Bar, boolean][] = [
      [{ time: t * 60000, open: 50, high: 55, low: 48, close: 52, volume: 1 }, false],
      [{ time: t * 60000, open: 50, high: 60, low: 48, close: 58, volume: 1 }, false],
      [{ time: t * 60000, open: 50, high: 62, low: 48, close: 61, volume: 1 }, true],
    ];
    const js = await crossCheck(compile(src), bars, ticks);
    // sanity: on the realtime bar, var "bars" advanced exactly once past the committed count
    const barsPlot = js.outputs.plots.get(0)!.data;
    expect(barsPlot[t]).toBe(t + 1);
    // varip "ticks" persists across ALL executions: one per historical bar (t) plus
    // the 3 realtime ticks (it escapes rollback) → t + 3.
    expect(js.outputs.plots.get(1)!.data[t]).toBe(t + 3);
  });
});
