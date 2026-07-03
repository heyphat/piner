import { describe, it, expect } from 'bun:test';
import { tokenize } from '../src/lexer/lexer.js';
import { parse } from '../src/parser/parser.js';
import { analyze } from '../src/sema/analyze.js';
import { compile, CompileError, Engine, ArrayFeed, type Bar } from '../src/index.js';
import type { VarDecl, Binary } from '../src/parser/ast.js';

const an = (src: string) => analyze(parse(tokenize(src)));
const HEAD = '//@version=6\nindicator("x")\n';
const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 100 + i,
  volume: 1,
}));

describe('type inference (drives + vs concat)', () => {
  const declType = (src: string) => {
    const r = an(HEAD + src);
    const d = r.program.body[1] as VarDecl; // body[0] is indicator(...)
    return (d.init as Binary).type?.kind;
  };
  it('int + int → int, float involved → float, / → float', () => {
    expect(declType('y = 1 + 2\n')).toBe('int');
    expect(declType('y = 1.0 + 2\n')).toBe('float');
    expect(declType('y = 4 / 2\n')).toBe('float');
  });
  it('string + anything → string (concat)', () => {
    expect(declType('y = "v=" + close\n')).toBe('string');
  });
  it('str.* return types: tonumber float, pos/length int, contains bool, tostring string', () => {
    expect(declType('y = str.tonumber("2") + 1\n')).toBe('float'); // numeric add, not concat
    expect(declType('y = str.pos("abc", "b") + 1\n')).toBe('int');
    expect(declType('y = str.length("abc") + 1\n')).toBe('int');
    const r = an(HEAD + 'y = str.contains("abc", "b")\n');
    expect((r.program.body[1] as VarDecl).init.type?.kind).toBe('bool');
    expect(declType('y = str.tostring(close) + "!"\n')).toBe('string');
  });
  it('builtin string members type as string (drives concat)', () => {
    expect(declType('y = syminfo.prefix + syminfo.ticker\n')).toBe('string');
    expect(declType('y = timeframe.period + "!"\n')).toBe('string');
    const r = an(HEAD + 'y = syminfo.mintick + 1\n');
    expect((r.program.body[1] as VarDecl).init.type?.kind).not.toBe('string');
  });
});

describe('diagnostics', () => {
  it('warns on == na and != na', () => {
    const w = an(HEAD + 'b = close == na\nc = close != na\n').diagnostics.filter(
      (d) => d.severity === 'warning',
    );
    expect(w.length).toBeGreaterThanOrEqual(2);
  });
  it('errors on undefined variables', () => {
    expect(
      an(HEAD + 'y = nope + 1\n').diagnostics.some(
        (d) => d.severity === 'error' && /undefined/.test(d.message),
      ),
    ).toBe(true);
  });
  it('warns on a stateful call inside a conditional branch', () => {
    const w = an(HEAD + 'v = close > open ? ta.sma(close, 5) : 0.0\n').diagnostics;
    expect(w.some((d) => d.severity === 'warning' && /stateful/.test(d.message))).toBe(true);
  });
  it('rejects deferred features with a clear error', () => {
    expect(() => compile(HEAD + 'import user/lib/1 as lib\nplot(lib.f(close))\n')).toThrow(
      CompileError,
    ); // library import/export still deferred
  });

  it('chained / inline-expression history compiles (materialized into an auto-history slot)', () => {
    // `close[1][2]` == `(close[1])[2]` — the inline base `close[1]` is recorded each bar, so the
    // outer `[2]` reads it two bars back (≡ close[3]). Once unsupported, now materialized.
    expect(() => compile(HEAD + 'x = close[1][2]\nplot(x)\n')).not.toThrow();
  });
});

describe('slot allocation', () => {
  it('a var that is also []-referenced gets BOTH a var slot and a history column', () => {
    const r = an(HEAD + 'var float run = 0.0\nrun := run + close\nprev = run[1]\n');
    const decl = r.program.body[2] as VarDecl;
    expect(decl.sym?.varSlot).toBeDefined();
    expect(decl.sym?.historySlot).not.toBeNull();
    expect(typeof decl.sym?.historySlot).toBe('number');
    // history column id is past the 6 reserved builtin slots
    expect(r.historySlotCount).toBeGreaterThan(6);
  });

  it('assigns one state site per textual stateful call', () => {
    const r = an(HEAD + 'a = ta.sma(close, 5)\nb = ta.sma(close, 5)\nc = ta.ema(close, 5)\n');
    expect(r.stateSiteCount).toBe(3); // identical calls are NOT merged
  });

  it('builtin OHLCV history reuses the fixed builtin slot (no new column)', () => {
    const r = an(HEAD + 'd = close - close[1]\n');
    expect(r.historySlotCount).toBe(6); // no extra history column allocated
  });

  it('UDT constructor args are analyzed exactly once (no duplicate inputs / state slots)', () => {
    const r = an(
      HEAD +
        'type P\n    float v\n    float w\np = P.new(input.float(1.0, "Length"), ta.sma(close, 5))\n',
    );
    expect(r.inputs.length).toBe(1);
    expect(r.inputs[0].key).toBe('Length'); // no phantom "Length (2)" key
    expect(r.stateSiteCount).toBe(1); // the ta.sma arg got ONE site, not two
  });
});

describe('history back-patch and var+history run correctly', () => {
  it('prev = run[1] yields the previous bar value of a var', async () => {
    const c = compile(
      HEAD +
        'var float run = 0.0\nrun := run + close\nprev = run[1]\nplot(run, title="run")\nplot(prev, title="prev")\n',
    );
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    const run = eng.outputs.plots.get(0)!.data;
    const prev = eng.outputs.plots.get(1)!.data;
    expect(prev[0]).toBeNaN(); // no prior bar
    for (let i = 1; i < bars.length; i++) expect(prev[i]).toBeCloseTo(run[i - 1], 9);
  });
});
