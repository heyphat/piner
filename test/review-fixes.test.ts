/**
 * Regression tests for the 18 confirmed findings from the adversarial review.
 * Each test reproduces the review's evidence and asserts the corrected behavior.
 */
import { describe, it, expect } from 'bun:test';
import { tokenize, LexError } from '../src/lexer/lexer.js';
import { TokenKind } from '../src/lexer/token.js';
import { parse } from '../src/parser/parser.js';
import { analyze } from '../src/sema/analyze.js';
import { compile, CompileError, Engine, ArrayFeed, Ta, type Bar } from '../src/index.js';
import type { VarDecl, Binary } from '../src/parser/ast.js';

const HEAD = '//@version=6\nindicator("x")\n';
const bars: Bar[] = Array.from({ length: 10 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 105 + i,
  low: 95 + i,
  close: 100 + i * 2,
  volume: 1000,
}));

const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;
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

describe('#1 lexer: bare exponent marker is not a NaN float', () => {
  it('`1e` lexes as Int 1 followed by Ident e', () => {
    const t = tokenize('x = 1e\n').tokens;
    const nums = t.filter((x) => x.kind === TokenKind.Int || x.kind === TokenKind.Float);
    expect(nums.every((n) => !Number.isNaN(n.literal as number))).toBe(true);
    expect(t.some((x) => x.kind === TokenKind.Ident && x.value === 'e')).toBe(true);
  });
  it('valid scientific notation still lexes', () => {
    expect(
      tokenize('x = 1.6e-19\n').tokens.find((x) => x.kind === TokenKind.Float)!.literal,
    ).toBeCloseTo(1.6e-19, 30);
  });
});

describe('#2 parser: const/simple/series qualifiers', () => {
  it('parses `const int LEN = 14` as one qualified declaration', () => {
    const p = parse(tokenize(HEAD + 'const int LEN = 14\n'));
    const d = p.body[1] as VarDecl;
    expect(d.kind).toBe('VarDecl');
    expect(d.declType?.kind).toBe('int');
    expect(d.name).toBe('LEN');
  });
  it('parses `var simple int s = 1`', () => {
    const d = parse(tokenize(HEAD + 'var simple int s = 1\n')).body[1] as VarDecl;
    expect(d.mode).toBe('var');
    expect(d.declType?.kind).toBe('int');
  });
});

describe('#3 parser: UDT-typed declarations do not crash', () => {
  it('parses `MyType t = na`', () => {
    const d = parse(tokenize(HEAD + 'MyType t = na\n')).body[1] as VarDecl;
    expect(d.declType).toEqual({ kind: 'udt', name: 'MyType' });
  });
  it('a UDT instance via .new() is rejected cleanly (deferred), not crashed', () => {
    expect(() => compile(HEAD + 'MyType t = MyType.new()\nplot(close)\n')).toThrow(CompileError);
  });
});

describe('#4/#6/#7 for-loop bound/step fixed at entry (both backends agree)', () => {
  it('mutating the `to` bound in the body does not change the iteration count', async () => {
    const eng = await bothBackends(
      HEAD + 'n = 3\nacc = 0.0\nfor i = 1 to n\n    acc := acc + 1.0\n    n := 1\nplot(acc)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(3); // bound was 3 at entry
  });
  it('mutating the `step` in the body does not change the iteration count', async () => {
    const eng = await bothBackends(
      HEAD +
        'st = 1\nacc = 0.0\nfor i = 0 to 6 by st\n    acc := acc + 1.0\n    st := st + 1\nplot(acc)\n',
    );
    expect(eng.outputs.plots.get(0)!.data[5]).toBe(7); // i = 0..6 with step fixed at 1
  });
});

describe('#5 tuple-destructured var with [] writes its history column', () => {
  it('a[1] yields the previous bar value', async () => {
    const eng = await bothBackends(HEAD + '[a, b] = [close, open]\nd = a[1]\nplot(d)\nplot(a)\n');
    const d = eng.outputs.plots.get(0)!.data;
    const a = eng.outputs.plots.get(1)!.data;
    expect(d[0]).toBeNaN();
    for (let i = 1; i < bars.length; i++) expect(d[i]).toBe(a[i - 1]);
  });
});

describe('#8 fixnan state is rolled back on realtime ticks', () => {
  it('does not leak a speculative tick value into the next tick', async () => {
    const data: Bar[] = [
      { time: 0, open: 100, high: 110, low: 99, close: 105, volume: 1 }, // src=105 → f=105
      { time: 60000, open: 90, high: 95, low: 88, close: 90, volume: 1 }, // src=na → f=105
    ];
    const c = compile(
      '//@version=6\nindicator("fx")\nsrc = close > 100.0 ? close : na\nf = fixnan(src)\nplot(f)\n',
    );
    const eng = new Engine(c, new ArrayFeed(data));
    await eng.run({ symbol: 'T', timeframe: '1' });
    eng.tick({ time: 120000, open: 100, high: 125, low: 100, close: 120, volume: 1 }, false); // src=120 → f=120
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(120);
    eng.tick({ time: 120000, open: 100, high: 105, low: 80, close: 80, volume: 1 }, false); // src=na → rollback → f=105
    expect(eng.outputs.plots.get(0)!.data[2]).toBe(105);
  });
});

describe('#9/#10/#15/#16 lexer indentation & directive hardening', () => {
  it('#9 a dedent to a non-enclosing level is a LexError', () => {
    expect(() => tokenize('if c\n        x = 1\n    y = 2\n')).toThrow(LexError);
  });
  it('#10 a tab and four spaces are the same indent level (TradingView semantics)', () => {
    // Sibling statements in one block may mix a tab and 4 spaces — both are level 1.
    expect(() => tokenize('if c\n\ty = 1\n    z = 2\n')).not.toThrow();
    // But combining tabs and spaces *within one line's* indentation is still an error.
    expect(() => tokenize('if c\n \ty = 1\n')).toThrow(LexError);
  });
  it('#15 a misindented first line is a LexError (nothing to continue)', () => {
    expect(() => tokenize('  x = 1\n')).toThrow(LexError);
  });
  it('#16 //@version is ignored after code or when indented', () => {
    expect(tokenize('x = 1\n//@version=5\ny = 2\n').version).toBe(6);
    expect(tokenize('    //@version=5\nx = 1\n').version).toBe(6);
  });
});

describe('#11 parser: `a < b` is a comparison expression statement', () => {
  it('does not get mis-routed to a typed declaration', () => {
    const s = parse(tokenize(HEAD + 'a < b\n')).body[1];
    expect(s.kind).toBe('ExprStmt');
    expect((s as any).expr.kind).toBe('Binary');
    expect((s as any).expr.op).toBe('<');
  });
});

describe('#12 sema: if/switch expression type unifies branches (string → concat)', () => {
  it('an if-expression with string branches makes `+` concatenate', () => {
    const r = analyze(
      parse(tokenize(HEAD + 'a = if close > open\n    "up"\nelse\n    "down"\nm = a + "!"\n')),
    );
    const m = r.program.body[2] as VarDecl;
    expect((m.init as Binary).type?.kind).toBe('string');
  });
});

describe('#13 sema: stateful call in and/or RHS warns', () => {
  it('warns for `... and ta.rsi(...) > 50`', () => {
    const d = analyze(
      parse(tokenize(HEAD + 'c = close > open and ta.rsi(close, 14) > 50.0\n')),
    ).diagnostics;
    expect(d.some((x) => x.severity === 'warning' && /stateful/.test(x.message))).toBe(true);
  });
});

describe('#14 runtime: ta.highest/lowest/change skip na inputs', () => {
  it('a leading na does not poison the window', () => {
    const ta = new Ta();
    expect(ta.highest(NaN, 3, 0)).toBeNaN();
    ta.highest(5, 3, 0);
    ta.highest(6, 3, 0);
    expect(ta.highest(7, 3, 0)).toBe(7); // window [5,6,7], na was skipped
  });
});

describe('#17 sema: [] on a local-scope variable warns', () => {
  it('warns for history of a block-local variable', () => {
    const d = analyze(
      parse(
        tokenize(
          HEAD + 'out = 0.0\nif close > open\n    inner = close\n    out := inner[1]\nplot(out)\n',
        ),
      ),
    ).diagnostics;
    expect(d.some((x) => x.severity === 'warning' && /local/.test(x.message))).toBe(true);
  });
});

describe('#18 backends agree when a ta.* dropped arg contains a stateful call', () => {
  it('valuewhen with a stateful (dropped) occurrence arg cross-checks', async () => {
    await bothBackends(
      HEAD + 'v = ta.valuewhen(close > open, close, int(ta.cum(1.0)) % 1)\nplot(v)\n',
    );
  });
});
