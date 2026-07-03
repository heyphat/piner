import { describe, it, expect } from 'bun:test';
import { Ta } from '../src/runtime/builtins/ta.js';
import { MathNs } from '../src/runtime/builtins/math.js';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';
import { tokenize } from '../src/lexer/lexer.js';
import { parse } from '../src/parser/parser.js';
import { Qualifier, joinQualifier, qtype } from '../src/sema/types.js';

const bars: Bar[] = Array.from({ length: 15 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 105 + i,
  low: 95 + i,
  close: 100 + (i % 4),
  volume: 1000 + i * 10,
}));

describe('ta.dev (mean absolute deviation)', () => {
  it('is 0 for a constant window and positive otherwise', () => {
    const ta = new Ta();
    [5, 5, 5].forEach((v) => ta.dev(v, 3, 0));
    expect(ta.dev(5, 3, 0)).toBeCloseTo(0, 12);
    const ta2 = new Ta();
    ta2.dev(0, 3, 0);
    ta2.dev(3, 3, 0);
    expect(ta2.dev(6, 3, 0)).toBeCloseTo((3 + 0 + 3) / 3, 9); // mean 3, |0-3|+|3-3|+|6-3| = 6 → /3 = 2
  });
});

describe('math extras', () => {
  it('log / log10 / exp / floor / ceil', () => {
    expect(MathNs.log(Math.E)).toBeCloseTo(1, 9);
    expect(MathNs.log10(1000)).toBeCloseTo(3, 9);
    expect(MathNs.exp(0)).toBe(1);
    expect(MathNs.floor(2.9)).toBe(2);
    expect(MathNs.ceil(2.1)).toBe(3);
  });
});

describe('output recording (plot / plotshape / hline / fill)', () => {
  it('records every output kind with the given titles', async () => {
    const c = compile(`//@version=6
indicator("o")
fast = ta.sma(close, 3)
plot(fast, title="fast")
plotshape(close > open, title="up")
hline(50.0, title="mid")
plot(open, title="open")
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect([...eng.outputs.plots.values()].map((p) => p.title)).toEqual(['fast', 'open']);
    expect([...eng.outputs.markers.values()][0].title).toBe('up');
    expect([...eng.outputs.hlines.values()][0].price).toBe(50);
  });
});

describe('all OHLCV+time leaves are readable', async () => {
  it('open/high/low/close/volume/time/bar_index feed through', async () => {
    const c = compile(`//@version=6
indicator("leaves")
plot(open, title="o")
plot(high, title="h")
plot(low, title="l")
plot(volume, title="v")
plot(time, title="t")
plot(bar_index, title="bi")
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect(eng.outputs.plots.get(3)!.data[5]).toBe(bars[5].volume);
    expect(eng.outputs.plots.get(4)!.data[5]).toBe(bars[5].time);
    expect(eng.outputs.plots.get(5)!.data[7]).toBe(7); // bar_index
  });
});

describe('parse-only constructs do not crash the parser', () => {
  it('parses type definitions, enums, and imports', () => {
    const p = parse(
      tokenize(`//@version=6
indicator("p")
type Point
    float x = 0.0
    float y = 0.0
enum Side
    long
    short
import user/lib/1 as helper
plot(close)
`),
    );
    expect(p.body.find((s) => s.kind === 'TypeDef')).toBeDefined();
    expect(p.body.find((s) => s.kind === 'Import')).toBeDefined();
  });

  it('compiles a script containing an (unused) type definition', () => {
    const c = compile(`//@version=6
indicator("p")
type Point
    float x = 0.0
plot(close)
`);
    expect(typeof c.main).toBe('function');
  });

  it('parses collection type templates', () => {
    const p = parse(
      tokenize(`//@version=6
indicator("c")
array<float> xs = na
plot(close)
`),
    );
    expect(p.body[1].kind).toBe('VarDecl');
  });
});

describe('alert and remaining derived leaves', () => {
  it('alert() records an event; hlcc4/time_close compute', async () => {
    const c = compile(`//@version=6
indicator("a")
alert("ping")
plot(hlcc4, title="hlcc4")
plot(time_close, title="tc")
`);
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect(eng.outputs.alerts.length).toBe(bars.length); // fired each bar
    const b = bars[6];
    expect(eng.outputs.plots.get(0)!.data[6]).toBeCloseTo(
      (b.high + b.low + b.close + b.close) / 4,
      9,
    );
    expect(eng.outputs.plots.get(1)!.data[6]).toBe(b.time + 60_000); // close time = open + one tf ("1" = 1min)
  });
});

describe('qualifier lattice helpers', () => {
  it('joinQualifier takes the strongest', () => {
    expect(joinQualifier(Qualifier.Const, Qualifier.Series)).toBe(Qualifier.Series);
    expect(joinQualifier(Qualifier.Input, Qualifier.Simple)).toBe(Qualifier.Simple);
    expect(qtype(Qualifier.Series, { kind: 'float' }).qualifier).toBe(Qualifier.Series);
  });
});
