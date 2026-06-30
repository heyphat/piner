import { describe, it, expect } from 'bun:test';
import { tokenize, LexError } from '../src/lexer/lexer.js';
import { parse, ParseError } from '../src/parser/parser.js';
import { compile, CompileError, Engine, ArrayFeed, ExecutionBudgetError, type Bar } from '../src/index.js';

const HEAD = '//@version=6\nindicator("x")\n';
const oneBar: Bar[] = [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];

describe('lexer rejects malformed input with LexError (no crash)', () => {
  const cases: [string, string][] = [
    ['unterminated string', HEAD + 'a = "oops\n'],
    ['invalid color literal', HEAD + 'a = #12\n'],
    ['mixed tabs and spaces', HEAD + 'if close\n \tx = 1\n'],
    ['unexpected character', HEAD + 'a = close @ open\n'],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      expect(() => tokenize(src)).toThrow(LexError);
    });
  }
});

describe('parser rejects malformed input with ParseError (no crash)', () => {
  const cases: [string, string][] = [
    ['missing close paren', HEAD + 'a = ta.sma(close, 5\n'],
    ['missing expression after =', HEAD + 'a = \n'],
    ['dangling operator', HEAD + 'a = close +\n'],
    ['bad assignment target', HEAD + '1 := 2\n'],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      expect(() => parse(tokenize(src))).toThrow(ParseError);
    });
  }
});

describe('compiler rejects unsupported / invalid programs with CompileError', () => {
  const cases: [string, string][] = [
    ['undefined variable', HEAD + 'plot(nope)\n'],
    ['library import (deferred)', HEAD + 'import user/lib/1 as lib\nplot(lib.f(close))\n'],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      expect(() => compile(src)).toThrow(CompileError);
    });
  }

  it('CompileError carries structured diagnostics', () => {
    try {
      compile(HEAD + 'plot(nope)\n');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as CompileError).diagnostics.some((d) => d.severity === 'error')).toBe(true);
    }
  });
});

describe('valid edge-case programs compile and run cleanly', () => {
  it('a script with only a declaration (no plots) compiles', () => {
    const c = compile(HEAD);
    expect(typeof c.main).toBe('function');
    expect(c.metadata.title).toBe('x');
  });
  it('comments, blank lines, and trailing comments are ignored', () => {
    const c = compile(`//@version=6
// header comment
indicator("y")

a = close // trailing comment
plot(a)
`);
    expect(c.metadata.title).toBe('y');
  });
  it('generated JS source is non-empty and references $', () => {
    const c = compile(HEAD + 'plot(ta.sma(close, 5))\n');
    expect(c.source).toContain('$.ta.sma');
    expect(c.source.length).toBeGreaterThan(20);
  });
  it('deep expression nesting does not overflow', () => {
    let expr = 'close';
    for (let i = 0; i < 200; i++) expr = `(${expr} + 1.0)`;
    expect(() => compile(HEAD + `plot(${expr})\n`)).not.toThrow();
  });
});

describe('execution budget rejects runaway user loops', () => {
  async function runWithTinyBudget(src: string, backend: 'js' | 'interp') {
    const eng = new Engine(compile(src), new ArrayFeed(oneBar), {
      backend,
      loopIterationBudget: 3,
    });
    await eng.run({ symbol: 'T', timeframe: '1' });
  }

  for (const backend of ['js', 'interp'] as const) {
    it(`${backend}: while loop exceeds budget`, async () => {
      await expect(runWithTinyBudget(HEAD + 'i = 0\nwhile true\n    i := i + 1\nplot(i)\n', backend))
        .rejects.toThrow(ExecutionBudgetError);
    });

    it(`${backend}: numeric for loop exceeds budget`, async () => {
      await expect(runWithTinyBudget(HEAD + 's = 0\nfor i = 0 to 10\n    s := s + i\nplot(s)\n', backend))
        .rejects.toThrow(ExecutionBudgetError);
    });

    it(`${backend}: for-in loop exceeds budget`, async () => {
      await expect(runWithTinyBudget(HEAD + 'a = array.new_float(5, close)\ns = 0.0\nfor v in a\n    s := s + v\nplot(s)\n', backend))
        .rejects.toThrow(ExecutionBudgetError);
    });
  }
});

describe('prototype pollution hardening', () => {
  it('rejects reserved prototype member access at compile time', () => {
    expect(() => compile(HEAD + `type T
    float x
t = T.new(1.0)
t.__proto__.polluted := 1
plot(t.x)
`)).toThrow(CompileError);
  });

  it('generated UDT constructors create null-prototype records', () => {
    const c = compile(HEAD + `type T
    float x
t = T.new(1.0)
plot(t.x)
`);
    expect(c.source).toContain('Object.create(null)');
  });
});
