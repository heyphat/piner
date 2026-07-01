/**
 * Library import/export — UDTs, enums, methods, transitive graphs, scoping, and the
 * full error matrix. Feature: library-import-export.
 */
import { describe, it, expect } from 'bun:test';
import { compile, CompileError, ParseError, Engine, ArrayFeed, type Bar, type LibraryRegistry, type CompiledScript } from '../src/index.js';
import { LibraryResolver, indexRegistry, normalizeIdentity } from '../src/sema/library.js';

function bars(n = 40): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 5) * 10 + i * 0.2;
    return { time: i * 60000, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i };
  });
}
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;

async function bothBackends(c: CompiledScript, data = bars()) {
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) throw new Error(`plot ${id} bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
    }
  }
  return js;
}

const throwsCompile = (fn: () => unknown): CompileError => {
  try { fn(); } catch (e) {
    if (e instanceof CompileError) return e;
    throw new Error(`expected CompileError, got ${(e as Error).name}: ${(e as Error).message}`);
  }
  throw new Error('expected CompileError, but no error was thrown');
};

// ───────────────────────── UDTs / enums / methods ─────────────────────────
describe('library import — UDTs, enums, methods', () => {
  it('imported UDT constructor + field access (both backends)', async () => {
    const reg: LibraryRegistry = [{ key: 'u/geo/1', source: `//@version=6
library("Geo")
export type Point
    float x = 0.0
    float y = 0.0
export mk(float a, float b) => Point.new(a, b)
` }];
    const c = compile(`//@version=6
indicator("c")
import u/geo/1 as geo
geo.Point p = geo.mk(close, high)
plot(p.x + p.y, title="sum")
`, { libraries: reg });
    const js = await bothBackends(c);
    const last = 39;
    const d = bars();
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(d[last].close + d[last].high, 9);
  });

  it('imported method via receiver dispatch (both backends)', async () => {
    const reg: LibraryRegistry = [{ key: 'u/vec/1', source: `//@version=6
library("Vec")
export type V
    float x = 0.0
    float y = 0.0
export method mag(V self) => math.sqrt(self.x * self.x + self.y * self.y)
` }];
    const c = compile(`//@version=6
indicator("c")
import u/vec/1 as vec
v = vec.V.new(close, high)
plot(v.mag(), title="m")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(Math.hypot(d[last].close, d[last].high), 9);
  });

  it('exported constant (v6) is referenceable as alias.CONST (both backends)', async () => {
    const reg: LibraryRegistry = [{ key: 'u/consts2/1', source: `//@version=6
library("Consts2")
export FACTOR = 2.5
export scaled(float x) => x * FACTOR
` }];
    const c = compile(`//@version=6
indicator("c")
import u/consts2/1 as k
plot(close * k.FACTOR, title="direct")
plot(k.scaled(close), title="viaFn")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(d[last].close * 2.5, 9);
    expect(js.outputs.plots.get(1)!.data[last]).toBeCloseTo(d[last].close * 2.5, 9);
  });

  it('imported enum member access resolves to its constant', async () => {
    const reg: LibraryRegistry = [{ key: 'u/side/1', source: `//@version=6
library("Side")
export enum Dir
    Up
    Down
export pick(bool up) => up ? "Up" : "Down"
` }];
    const c = compile(`//@version=6
indicator("c")
import u/side/1 as s
plot(s.pick(close > open) == s.Dir.Up ? 1.0 : 0.0, title="d")
`, { libraries: reg });
    await bothBackends(c);
  });
});

// ───────────────────────── transitive graph ─────────────────────────
describe('library import — transitive resolution + scoping', () => {
  const base = { key: 'u/base/1', source: `//@version=6
library("Base")
export inc(float x) => x + 1.0
` };
  const mid = { key: 'u/mid/1', source: `//@version=6
library("Mid")
import u/base/1 as b
export twice(float x) => b.inc(x) * 2.0
` };

  it('resolves transitive imports and both backends agree', async () => {
    const c = compile(`//@version=6
indicator("c")
import u/mid/1 as m
plot(m.twice(close), title="t")
`, { libraries: [base, mid] });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo((d[last].close + 1) * 2, 9);
  });

  it('a shared library on a diamond graph is resolved exactly once (Req 8.2)', () => {
    const left = { key: 'u/left/1', source: `//@version=6
library("Left")
import u/base/1 as b
export l(float x) => b.inc(x)
` };
    const right = { key: 'u/right/1', source: `//@version=6
library("Right")
import u/base/1 as b
export r(float x) => b.inc(x) + 10.0
` };
    const reg = indexRegistry([base, left, right]);
    const graph = new LibraryResolver(reg).resolve([
      { kind: 'Import', user: 'u', lib: 'left', version: 1 },
      { kind: 'Import', user: 'u', lib: 'right', version: 1 },
    ]);
    // base, left, right — three distinct libraries, base resolved once.
    expect(graph.libraries.size).toBe(3);
    expect(graph.libraries.has('u/base/1')).toBe(true);
  });

  it('consumer cannot see a transitively-imported library it did not import directly (Req 8.6)', () => {
    const e = throwsCompile(() => compile(`//@version=6
indicator("c")
import u/mid/1 as m
plot(b.inc(close))
`, { libraries: [base, mid] }));
    expect(e.message).toContain('b'); // 'b' (Mid's private alias) is undefined in the consumer
  });
});

// ───────────────────────── error matrix ─────────────────────────
describe('library import — error handling', () => {
  const lib = { key: 'u/lib/1', source: '//@version=6\nlibrary("L")\nexport f(float x) => x\n' };
  const HEAD = '//@version=6\nindicator("c")\n';

  it('missing library (direct) names the identity (Req 2.8)', () => {
    const e = throwsCompile(() => compile(HEAD + 'import u/nope/1 as n\nplot(n.f(close))\n', { libraries: [lib] }));
    expect(e.message).toContain('u/nope/1');
  });

  it('missing library (transitive) names both the missing and importing identity (Req 8.4)', () => {
    const mid = { key: 'u/mid/1', source: '//@version=6\nlibrary("Mid")\nimport u/gone/2 as g\nexport h(float x) => g.f(x)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/mid/1 as m\nplot(m.h(close))\n', { libraries: [mid] }));
    expect(e.message).toContain('u/gone/2');
    expect(e.message).toContain('u/mid/1');
  });

  it('version mismatch reports requested vs available (Req 3.5)', () => {
    const e = throwsCompile(() => compile(HEAD + 'import u/lib/2 as l\nplot(l.f(close))\n', { libraries: [lib] }));
    expect(e.message).toContain('u/lib/2'); // requested
    expect(e.message).toContain('"1"');      // available version
    expect(e.message.toLowerCase()).toContain('version');
  });

  it('duplicate alias — neither import binds (Req 3.6)', () => {
    const lib2 = { key: 'u/other/1', source: '//@version=6\nlibrary("O")\nexport g(float x) => x\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/lib/1 as x\nimport u/other/1 as x\nplot(x.f(close))\n', { libraries: [lib, lib2] }));
    expect(e.message.toLowerCase()).toContain('duplicate');
  });

  it('alias shadowing a builtin namespace (Req 3.7)', () => {
    const e = throwsCompile(() => compile(HEAD + 'import u/lib/1 as math\nplot(math.f(close))\n', { libraries: [lib] }));
    expect(e.message).toContain('math');
  });

  it('unresolved symbol (Req 4.4)', () => {
    const e = throwsCompile(() => compile(HEAD + 'import u/lib/1 as l\nplot(l.nope(close))\n', { libraries: [lib] }));
    expect(e.message).toContain('nope');
  });

  it('private symbol is not exported (Req 4.5)', () => {
    const priv = { key: 'u/p/1', source: '//@version=6\nlibrary("P")\nhidden(float x) => x\nexport pub(float x) => hidden(x)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/p/1 as p\nplot(p.hidden(close))\n', { libraries: [priv] }));
    expect(e.message).toContain('hidden');
    expect(e.message).toContain('not exported');
  });

  it('undeclared enum member (Req 4.10)', () => {
    const en = { key: 'u/e/1', source: '//@version=6\nlibrary("E")\nexport enum Dir\n    Up\n    Down\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/e/1 as en\nplot(en.Dir.Sideways == en.Dir.Up ? 1.0 : 0.0)\n', { libraries: [en] }));
    expect(e.message).toContain('Sideways');
  });

  it('cyclic dependency graph is rejected in cycle order (Req 8.3)', () => {
    const a = { key: 'u/a/1', source: '//@version=6\nlibrary("A")\nimport u/b/1 as b\nexport fa(float x) => b.fb(x)\n' };
    const b = { key: 'u/b/1', source: '//@version=6\nlibrary("B")\nimport u/a/1 as a\nexport fb(float x) => a.fa(x)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/a/1 as a\nplot(a.fa(close))\n', { libraries: [a, b] }));
    expect(e.message.toLowerCase()).toContain('cyclic');
    expect(e.message).toContain('u/a/1');
    expect(e.message).toContain('u/b/1');
  });

  it('export constraint: plot() inside an exported function (Req 7.1)', () => {
    const bad = { key: 'u/bad/1', source: '//@version=6\nlibrary("Bad")\nexport draw(float x) =>\n    plot(x)\n    x\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/bad/1 as bad\nplot(bad.draw(close))\n', { libraries: [bad] }));
    expect(e.message).toContain('plot');
  });

  it('export constraint fires transitively through a private symbol (Req 7.1)', () => {
    const bad = { key: 'u/bad/1', source: '//@version=6\nlibrary("Bad")\nsecret(float x) =>\n    plotshape(x)\n    x\nexport draw(float x) => secret(x)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/bad/1 as bad\nplot(bad.draw(close))\n', { libraries: [bad] }));
    expect(e.message).toContain('plotshape');
  });

  it('cross-module recursion is rejected (Req 5.3)', () => {
    // A graph cycle (rb imports ra imports rb) is caught earlier as a cyclic import;
    // genuine self-recursion inside an exported function is caught by the inliner guard.
    const selfrec = { key: 'u/rec/1', source: '//@version=6\nlibrary("Rec")\nexport f(float x) => f(x) + 1.0\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/rec/1 as r\nplot(r.f(close))\n', { libraries: [selfrec] }));
    expect(e.message.toLowerCase()).toContain('recurs');
  });

  it('malformed registry key (Req 2.7)', () => {
    const e = throwsCompile(() => compile(HEAD + 'plot(close)\n', { libraries: [{ key: 'only/two', source: 'x' }] }));
    expect(e.message.toLowerCase()).toContain('malformed');
  });

  it('duplicate identity in the registry (Req 2.6)', () => {
    const e = throwsCompile(() => compile(HEAD + 'plot(close)\n', {
      libraries: [
        { key: 'u/l/1', source: '//@version=6\nlibrary("L")\nexport f(float x)=>x\n' },
        { key: { user: 'u', lib: 'l', version: '1' }, source: '//@version=6\nlibrary("L2")\nexport g(float x)=>x\n' },
      ],
    }));
    expect(e.message.toLowerCase()).toContain('duplicate');
  });

  it('imported script that is not a library is rejected', () => {
    const notlib = { key: 'u/ind/1', source: '//@version=6\nindicator("NotALib")\nplot(close)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/ind/1 as x\nplot(x.f(close))\n', { libraries: [notlib] }));
    expect(e.message.toLowerCase()).toContain('not a library');
  });

  it('library with a parse error is attributed to its identity (Req 9.1)', () => {
    const broken = { key: 'u/broke/1', source: '//@version=6\nlibrary("B")\nexport f(float x) => (((\n' };
    let err: unknown;
    try { compile(HEAD + 'import u/broke/1 as b\nplot(b.f(close))\n', { libraries: [broken] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).library?.canonical).toBe('u/broke/1');
  });

  it('library title validation: non-string title (Req 1.7)', () => {
    const e = throwsCompile(() => compile(HEAD + 'import u/t/1 as t\nplot(t.f(close))\n', {
      libraries: [{ key: 'u/t/1', source: '//@version=6\nlibrary(123)\nexport f(float x)=>x\n' }],
    }));
    expect(e.message.toLowerCase()).toContain('title');
  });

  it('method dispatch with no matching arity is rejected (Req 4.8)', () => {
    const v = { key: 'u/mv/1', source: '//@version=6\nlibrary("MV")\nexport type V\n    float x = 0.0\nexport method scaleBy(V self, float k) => self.x * k\n' };
    // v.scaleBy() supplies 0 extra args (arity 1) but scaleBy needs the receiver + k (arity 2).
    const e = throwsCompile(() => compile(HEAD + 'import u/mv/1 as mv\nv = mv.V.new(close)\nplot(v.scaleBy())\n', { libraries: [v] }));
    expect(e.message).toContain('scaleBy');
    expect(e.message.toLowerCase()).toMatch(/no method|matching/);
  });

  it('missing required argument for an imported function is rejected (Req 5.5)', () => {
    const two = { key: 'u/two/1', source: '//@version=6\nlibrary("Two")\nexport add(float a, float b) => a + b\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/two/1 as t\nplot(t.add(close))\n', { libraries: [two] }));
    expect(e.message.toLowerCase()).toContain('missing');
    expect(e.message).toContain('b');
  });

  it('transitive import depth beyond 32 is rejected (Req 8.1, 8.5)', () => {
    // Build a linear chain lib0 -> lib1 -> ... -> lib40, each importing the next.
    const N = 40;
    const libs: LibraryRegistry = Array.from({ length: N + 1 }, (_, i) => ({
      key: `u/L${i}/1`,
      source: i < N
        ? `//@version=6\nlibrary("L${i}")\nimport u/L${i + 1}/1 as n\nexport f(float x) => n.f(x)\n`
        : `//@version=6\nlibrary("L${i}")\nexport f(float x) => x\n`,
    }));
    const e = throwsCompile(() => compile(HEAD + 'import u/L0/1 as l\nplot(l.f(close))\n', { libraries: libs }));
    expect(e.message).toMatch(/depth|nesting/i);
  });

  it('a transitive export-constraint violation carries the import chain (Req 9.4)', () => {
    const deep = { key: 'u/deep/1', source: '//@version=6\nlibrary("Deep")\nexport bad(float x) =>\n    plot(x)\n    x\n' };
    const mid = { key: 'u/midc/1', source: '//@version=6\nlibrary("MidC")\nimport u/deep/1 as d\nexport go(float x) => d.bad(x)\n' };
    const e = throwsCompile(() => compile(HEAD + 'import u/midc/1 as m\nplot(m.go(close))\n', { libraries: [deep, mid] }));
    const d = e.diagnostics.find((x) => x.library?.canonical === 'u/deep/1');
    expect(d).toBeDefined();
    expect(d!.importChain?.map((c) => c.canonical)).toEqual(['u/midc/1', 'u/deep/1']);
  });
});

// ───────────────────────── merge-correctness regressions ─────────────────────────
describe('library import — merge correctness (imported ≡ local)', () => {
  it('a private (non-export) top-level library constant is mangled and referenceable', async () => {
    const reg: LibraryRegistry = [{ key: 'u/consts/1', source: `//@version=6
library("Consts")
GOLD = 1.5
export scale(float x) => x * GOLD
` }];
    const c = compile(`//@version=6
indicator("c")
import u/consts/1 as k
plot(k.scale(close), title="s")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(d[last].close * 1.5, 9);
  });

  it('a library private var does NOT leak to / from a same-named consumer var', async () => {
    const reg: LibraryRegistry = [{ key: 'u/consts/1', source: `//@version=6
library("Consts")
GOLD = 1.5
export scale(float x) => x * GOLD
` }];
    // The consumer declares its own GOLD = 1000; the library must use its OWN 1.5.
    const c = compile(`//@version=6
indicator("c")
import u/consts/1 as k
GOLD = 1000.0
plot(k.scale(close), title="s")
plot(GOLD, title="g")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(d[last].close * 1.5, 9); // library's GOLD
    expect(js.outputs.plots.get(1)!.data[last]).toBeCloseTo(1000, 9); // consumer's GOLD
  });

  it('a function parameter that shadows a sibling declaration name is not self-mangled', async () => {
    const reg: LibraryRegistry = [{ key: 'u/shadow/1', source: `//@version=6
library("Sh")
helper(float z) => z + 1.0
export calc(float helper) => helper * 2.0
` }];
    const c = compile(`//@version=6
indicator("c")
import u/shadow/1 as s
plot(s.calc(close), title="v")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo(d[last].close * 2, 9);
  });

  it('a local variable shadowing a sibling function name is not self-mangled', async () => {
    const reg: LibraryRegistry = [{ key: 'u/shadow2/1', source: `//@version=6
library("Sh2")
scale(float z) => z * 10.0
export run(float x) =>
    scale = x + 5.0
    scale * 2.0
` }];
    const c = compile(`//@version=6
indicator("c")
import u/shadow2/1 as s
plot(s.run(close), title="v")
`, { libraries: reg });
    const js = await bothBackends(c);
    const d = bars();
    const last = 39;
    expect(js.outputs.plots.get(0)!.data[last]).toBeCloseTo((d[last].close + 5) * 2, 9);
  });
});

// ───────────────────────── identity normalization units ─────────────────────────
describe('identity normalization (Req 2.2, 2.3)', () => {
  it('string and object keys normalize to the same canonical identity', () => {
    const a = normalizeIdentity('pub/lib/3');
    const b = normalizeIdentity({ user: 'pub', lib: 'lib', version: '3' });
    expect(a.canonical).toBe('pub/lib/3');
    expect(a.canonical).toBe(b.canonical);
    expect(a.publisher).toBe('pub');
    expect(a.lib).toBe('lib');
    expect(a.version).toBe('3');
  });
  it('rejects malformed string keys', () => {
    expect(() => normalizeIdentity('a/b')).toThrow(CompileError);
    expect(() => normalizeIdentity('a//c')).toThrow(CompileError);
    expect(() => normalizeIdentity('a/b/c/d')).toThrow(CompileError);
  });
  it('rejects object keys with empty parts', () => {
    expect(() => normalizeIdentity({ user: '', lib: 'b', version: '1' })).toThrow(CompileError);
  });
});
