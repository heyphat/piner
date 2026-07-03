import { describe, it, expect } from 'bun:test';
import { tokenize } from '../src/lexer/lexer.js';
import { parse } from '../src/parser/parser.js';
import type {
  VarDecl,
  Binary,
  Call,
  Ternary,
  IfNode,
  FuncDef,
  TupleDecl,
  TypeDef,
} from '../src/parser/ast.js';

const prog = (src: string) => parse(tokenize(src));

describe('parser', () => {
  it('parses a var decl with a call initializer', () => {
    const p = prog('//@version=6\nindicator("x")\nlen = 14\nbasis = ta.sma(close, len)\n');
    expect(p.version).toBe(6);
    const basis = p.body[2] as VarDecl;
    expect(basis.kind).toBe('VarDecl');
    expect(basis.name).toBe('basis');
    const call = basis.init as Call;
    expect(call.kind).toBe('Call');
    expect((call.callee as any).property).toBe('sma'); // ta.sma
    expect(call.args.length).toBe(2);
  });

  it('respects operator precedence (a + b * c)', () => {
    const p = prog('//@version=6\nindicator("x")\ny = a + b * c\n');
    const y = p.body[1] as VarDecl;
    const bin = y.init as Binary;
    expect(bin.op).toBe('+');
    expect((bin.right as Binary).op).toBe('*'); // b*c binds tighter
  });

  it('parses history, member, and named args', () => {
    const p = prog(
      '//@version=6\nindicator("x")\nz = close[1]\nplot(z, title="t", color=color.red)\n',
    );
    const z = p.body[1] as VarDecl;
    expect(z.init.kind).toBe('History');
    const plot = (p.body[2] as any).expr as Call;
    expect(plot.args[1].name).toBe('title');
    expect(plot.args[2].name).toBe('color');
  });

  it('parses ternary (right-assoc)', () => {
    const p = prog('//@version=6\nindicator("x")\nq = a ? b : c ? d : e\n');
    const t = (p.body[1] as VarDecl).init as Ternary;
    expect(t.kind).toBe('Ternary');
    expect((t.else as Ternary).kind).toBe('Ternary'); // nests on the right
  });

  it('parses if/else blocks via INDENT/DEDENT', () => {
    const p = prog('//@version=6\nindicator("x")\nif close > open\n    a = 1\nelse\n    a = 2\n');
    const node = p.body[1] as IfNode;
    expect(node.kind).toBe('If');
    expect(node.then.length).toBe(1);
    expect(node.else?.length).toBe(1);
  });

  it('parses a multi-line user function', () => {
    const p = prog('//@version=6\nindicator("x")\nf(x, y) =>\n    s = x + y\n    s * 2\n');
    const f = p.body[1] as FuncDef;
    expect(f.kind).toBe('FuncDef');
    expect(f.params.map((q) => q.name)).toEqual(['x', 'y']);
    expect(f.body.length).toBe(2);
  });

  it('parses tuple destructuring', () => {
    const p = prog('//@version=6\nindicator("x")\n[a, b] = f()\n');
    expect(p.body[1].kind).toBe('TupleDecl');
    expect((p.body[1] as any).names).toEqual(['a', 'b']);
  });

  it('parses a var declaration with persistence + reassignment', () => {
    const p = prog('//@version=6\nindicator("x")\nvar float sum = 0.0\nsum := sum + close\n');
    const decl = p.body[1] as VarDecl;
    expect(decl.mode).toBe('var');
    expect(decl.declType?.kind).toBe('float');
    expect(p.body[2].kind).toBe('Reassign');
  });

  // Real-script gap (auto-pitchfork): TradingView names params and variables with
  // keywords — `type`, `color`, `extend`, `series`. They must parse both as
  // standalone parameter names and as identifier references in expressions.
  it('accepts keywords as standalone parameter names (color/width/style/extend/type)', () => {
    const p = prog(
      '//@version=6\nindicator("x")\nf(chart.point start, color, width, style, extend, type) =>\n    width\n',
    );
    const f = p.body[1] as FuncDef;
    expect(f.kind).toBe('FuncDef');
    expect(f.params.map((pp) => pp.name)).toEqual([
      'start',
      'color',
      'width',
      'style',
      'extend',
      'type',
    ]);
    // `start` is typed (chart.point); the keyword-named params are untyped.
    expect(f.params[0].declType).toBeDefined();
    expect(f.params[1].declType).toBeUndefined();
  });

  it('accepts a keyword (type) as an identifier reference in an expression', () => {
    const p = prog('//@version=6\nindicator("x")\ng(type) =>\n    type == "Original" ? 1 : 0\n');
    const g = p.body[1] as FuncDef;
    expect(g.params[0].name).toBe('type');
    const ret = (g.body[0] as any).expr as Ternary;
    expect(ret.kind).toBe('Ternary');
    expect((ret.cond as Binary).op).toBe('==');
    expect(((ret.cond as Binary).left as any).name).toBe('type'); // identifier ref, not a keyword error
  });

  // Real-script gap (LuxAlgo "Liquidity Structure & Order Flow"): a STATEMENT-leading
  // qualified built-in type — `chart.point p = …` and the legacy array form
  // `chart.point[] ps = …` — must be recognized as a typed var-decl, not parsed as an
  // expression (which choked on `[]`). A trailing member CALL (`chart.point.from_index(…)`)
  // must still parse as an expression statement, not a decl.
  it('parses statement-leading qualified-type decls (chart.point / chart.point[])', () => {
    const p = prog(
      '//@version=6\nindicator("x")\nchart.point a = chart.point.from_index(0, 0.0)\nchart.point[] b = array.new<chart.point>()\n',
    );
    const a = p.body[1] as VarDecl;
    expect(a.kind).toBe('VarDecl');
    expect(a.name).toBe('a');
    expect(a.declType).toEqual({ kind: 'udt', name: 'chart.point' });
    const b = p.body[2] as VarDecl;
    expect(b.kind).toBe('VarDecl');
    expect(b.name).toBe('b');
    expect(b.declType).toEqual({ kind: 'array', of: { kind: 'udt', name: 'chart.point' } });
  });

  it('does not misread a qualified member call (chart.point.from_index) as a decl', () => {
    const p = prog('//@version=6\nindicator("x")\nchart.point.from_index(bar_index, close)\n');
    expect(p.body[1].kind).toBe('ExprStmt');
  });

  // Parser bug: a block-form `if`/`switch` expression already consumed its block's
  // NL+DEDENT, so the next statement's leading `[` / `(` must not be treated as a
  // postfix operator on the if-expression (spurious "expected ]").
  it("does not postfix a block-form if expression with the next statement's leading [", () => {
    const p = prog(
      '//@version=6\nindicator("x")\nv = if useA\n    1\nelse\n    2\n[macdLine, signalLine] = ta.macd(close, 12, 26, 9)\n',
    );
    const v = p.body[1] as VarDecl;
    expect(v.kind).toBe('VarDecl');
    expect(v.init.kind).toBe('If');
    const tup = p.body[2] as TupleDecl;
    expect(tup.kind).toBe('TupleDecl');
    expect(tup.names).toEqual(['macdLine', 'signalLine']);
  });

  it("does not postfix a block-form switch expression with the next statement's leading (", () => {
    const p = prog(
      '//@version=6\nindicator("x")\nw = switch\n    close > open => 1\n    => 2\n(close + open)\n',
    );
    const w = p.body[1] as VarDecl;
    expect(w.init.kind).toBe('Switch'); // NOT a Call on the switch-expression
    expect(p.body.length).toBe(3);
    expect(p.body[2].kind).toBe('ExprStmt');
    expect(((p.body[2] as any).expr as Binary).op).toBe('+');
  });

  // Parser bug: UDT fields with dotted builtin types (`chart.point point`) failed the
  // "has type prefix" gate — peek(1) checked name/`<`/`[` but not `.`.
  it('parses UDT fields with dotted builtin types (chart.point / chart.point[])', () => {
    const p = prog(
      '//@version=6\nindicator("x")\ntype Pivot\n    chart.point point\n    chart.point[] pts\n    float price\n',
    );
    const td = p.body[1] as TypeDef;
    expect(td.kind).toBe('TypeDef');
    expect(td.fields.map((f) => f.name)).toEqual(['point', 'pts', 'price']);
    expect(td.fields[0].declType).toEqual({ kind: 'udt', name: 'chart.point' });
    expect(td.fields[1].declType).toEqual({
      kind: 'array',
      of: { kind: 'udt', name: 'chart.point' },
    });
    expect(td.fields[2].declType?.kind).toBe('float');
  });

  it('still parses qualified params (series int x) without treating the qualifier as the name', () => {
    const p = prog('//@version=6\nindicator("x")\nh(series int x, simple float y) =>\n    x + y\n');
    const h = p.body[1] as FuncDef;
    expect(h.params.map((pp) => pp.name)).toEqual(['x', 'y']);
    expect(h.params[0].declQual).toBeDefined();
    expect(h.params[0].declType?.kind).toBe('int');
  });
});
