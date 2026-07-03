/**
 * Regression tests for the July-2026 library import/export audit fixes.
 * Each `it` pins a bug that a code review found and this pass fixed.
 */
import { describe, it, expect } from 'bun:test';
import {
  compile,
  CompileError,
  Engine,
  ArrayFeed,
  type Bar,
  type LibraryRegistry,
  type CompiledScript,
} from '../src/index.js';

function bars(n = 10): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 60000,
    open: 10,
    high: 12,
    low: 8,
    close: 10,
    volume: 1,
  }));
}
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;
async function bothBackends(c: CompiledScript, data = bars()) {
  const js = new Engine(c, new ArrayFeed(data), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(data), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i]))
        throw new Error(`plot ${id} bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
    }
  }
  return js;
}
const throwsCompile = (fn: () => unknown): CompileError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CompileError) return e;
    throw new Error(`expected CompileError, got ${(e as Error).name}: ${(e as Error).message}`);
  }
  throw new Error('expected CompileError, but no error was thrown');
};

describe('library audit fixes', () => {
  it('method overloads distinguished by container element type are NOT a duplicate export', () => {
    const reg: LibraryRegistry = [
      {
        key: 'a/arrlib/1',
        source: `//@version=6
library("arrlib")
export method total(array<float> a) => array.sum(a)
export method total(array<string> a) => array.size(a)
`,
      },
    ];
    expect(() =>
      compile(
        `//@version=6
indicator("c")
import a/arrlib/1 as al
plot(1)
`,
        { libraries: reg },
      ),
    ).not.toThrow();
  });

  it('a genuine duplicate export (identical receiver type + arity) is still rejected', () => {
    const reg: LibraryRegistry = [
      {
        key: 'a/arrlib/1',
        source: `//@version=6
library("arrlib")
export method total(array<float> a) => array.sum(a)
export method total(array<float> a) => array.size(a)
`,
      },
    ];
    const err = throwsCompile(() =>
      compile(
        `//@version=6
indicator("c")
import a/arrlib/1 as al
plot(1)
`,
        { libraries: reg },
      ),
    );
    expect(err.message).toMatch(/duplicate export 'total'/);
  });

  it('a builtin call (array.get) is not misattributed to a private fn that shares its name', () => {
    const reg: LibraryRegistry = [
      {
        key: 'u/lib/1',
        source: `//@version=6
library("lib")
get(float x) => x * 2.0
export f(array<float> a, int i) => array.get(a, i)
`,
      },
    ];
    // Exported f legitimately calls array.get; a private helper is also named "get".
    // The export-purity check must not follow array.get into the private helper.
    expect(() =>
      compile(
        `//@version=6
indicator("c")
import u/lib/1 as l
plot(l.f(array.new<float>(3), 0))
`,
        { libraries: reg },
      ),
    ).not.toThrow();
  });

  it('a library import alias colliding with its own top-level declaration is rejected', () => {
    const reg: LibraryRegistry = [
      { key: 'u/base/1', source: '//@version=6\nlibrary("base")\nexport f() => 42.0\n' },
      {
        key: 'u/mid/1',
        source: `//@version=6
library("mid")
import u/base/1 as helper
helper(float x) => x + 1
export g() => helper.f() + helper(1)
`,
      },
    ];
    const err = throwsCompile(() =>
      compile(
        `//@version=6
indicator("c")
import u/mid/1 as m
plot(m.g())
`,
        { libraries: reg },
      ),
    );
    expect(err.message).toMatch(/is also an import alias/);
  });

  it('a builtin-receiver method exported by two libraries is an ambiguity error, not a silent na', () => {
    const reg: LibraryRegistry = [
      {
        key: 'a/x/1',
        source:
          '//@version=6\nlibrary("x")\nexport method clamp(float v, float lo, float hi) => math.max(lo, math.min(hi, v))\n',
      },
      {
        key: 'b/y/1',
        source:
          '//@version=6\nlibrary("y")\nexport method clamp(float v, float lo, float hi) => v\n',
      },
    ];
    const err = throwsCompile(() =>
      compile(
        `//@version=6
indicator("c")
import a/x/1 as ax
import b/y/1 as yl
v = 10.0
plot(v.clamp(0.0, 1.0))
`,
        { libraries: reg },
      ),
    );
    expect(err.message).toMatch(/ambiguous method 'clamp'/);
  });

  it("a consumer's own method wins over an imported same-name library method", async () => {
    const reg: LibraryRegistry = [
      {
        key: 'a/x/1',
        source: '//@version=6\nlibrary("x")\nexport method scale(float x, float f) => x * f\n',
      },
    ];
    const c = compile(
      `//@version=6
indicator("c")
import a/x/1 as ax
method scale(float x, float f) => x / f
v = 10.0
plot(v.scale(2.0))
`,
      { libraries: reg },
    );
    const js = await bothBackends(c);
    // Local method divides: 10 / 2 = 5 (the imported method would multiply → 20).
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(5, 9);
  });

  it('an unannotated variable from a library factory function dispatches methods (was na)', async () => {
    const reg: LibraryRegistry = [
      {
        key: 'u/vec/1',
        source: `//@version=6
library("vec")
export type V
    float x = 0.0
export method mag(V self) => self.x * 2.0
export mk(float a) => V.new(a)
`,
      },
    ];
    const c = compile(
      `//@version=6
indicator("c")
import u/vec/1 as vec
v = vec.mk(close)
plot(v.mag())
`,
      { libraries: reg },
    );
    const js = await bothBackends(
      c,
      bars().map((b) => ({ ...b, close: 3 })),
    );
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(6, 9); // 3 * 2
  });

  it('a namespaced method overload resolves when the receiver arg is itself a call', async () => {
    const reg: LibraryRegistry = [
      {
        key: 'u/shape/1',
        source: `//@version=6
library("shape")
export type Circle
    float r = 0.0
export type Square
    float s = 0.0
export mkCircle(float r) => Circle.new(r)
export method area(Circle c) => 3.14159265 * c.r * c.r
export method area(Square q) => q.s * q.s
`,
      },
    ];
    const c = compile(
      `//@version=6
indicator("c")
import u/shape/1 as sh
plot(sh.area(sh.mkCircle(2.0)))
`,
      { libraries: reg },
    );
    const js = await bothBackends(c);
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(3.14159265 * 4, 6);
  });
});

// ── absolute-receiver method dispatch (cross-library types) ──
const POINT_LIB = {
  key: 'u/pointlib/1',
  source: `//@version=6
library("pointlib")
export type Point
    float x = 0.0
    float y = 0.0
`,
};
const MAG_LIB = {
  key: 'u/mathlib/1',
  source: `//@version=6
library("mathlib")
import u/pointlib/1 as t
export method mag(t.Point p) => p.x * p.x + p.y * p.y
`,
};
const MAG2_LIB = {
  key: 'u/mathlib2/1',
  source: `//@version=6
library("mathlib2")
import u/pointlib/1 as t
export method mag(t.Point p) => p.x + p.y
`,
};

describe('library audit fixes — absolute-receiver method dispatch', () => {
  it('a method exported by library A on a type owned by library B dispatches (was na)', async () => {
    // The consumer reaches the type via alias `tp`; the method's declaration spells it
    // `t.Point`. Dispatch compares absolute type identities, not alias-relative names.
    const c = compile(
      `//@version=6
indicator("c")
import u/pointlib/1 as tp
import u/mathlib/1 as a
p = tp.Point.new(3.0, 4.0)
plot(p.mag())
`,
      { libraries: [POINT_LIB, MAG_LIB] },
    );
    const js = await bothBackends(c);
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(25, 9); // 3² + 4²
  });

  it('two libraries exporting the same method on the same type is an ambiguity error, not na', () => {
    const err = throwsCompile(() =>
      compile(
        `//@version=6
indicator("c")
import u/pointlib/1 as tp
import u/mathlib/1 as a
import u/mathlib2/1 as b
p = tp.Point.new(3.0, 4.0)
plot(p.mag())
`,
        { libraries: [POINT_LIB, MAG_LIB, MAG2_LIB] },
      ),
    );
    expect(err.message).toMatch(/ambiguous method 'mag'/);
  });

  it('the explicit alias form disambiguates a cross-library method collision', async () => {
    const src = (alias: string) => `//@version=6
indicator("c")
import u/pointlib/1 as tp
import u/mathlib/1 as a
import u/mathlib2/1 as b
p = tp.Point.new(3.0, 4.0)
plot(${alias}.mag(p))
`;
    const reg = [POINT_LIB, MAG_LIB, MAG2_LIB];
    const a = await bothBackends(compile(src('a'), { libraries: reg }));
    const b = await bothBackends(compile(src('b'), { libraries: reg }));
    expect(a.outputs.plots.get(0)!.data[9]).toBeCloseTo(25, 9); // mathlib: x² + y²
    expect(b.outputs.plots.get(0)!.data[9]).toBeCloseTo(7, 9); //  mathlib2: x + y
  });

  it("a library's own method on an imported type dispatches inside its own body", async () => {
    const lib3 = {
      key: 'u/mathlib3/1',
      source: `//@version=6
library("mathlib3")
import u/pointlib/1 as t
export method mag(t.Point p) => p.x * p.x + p.y * p.y
export magOf(float x, float y) =>
    p = t.Point.new(x, y)
    p.mag()
`,
    };
    const c = compile(
      `//@version=6
indicator("c")
import u/mathlib3/1 as m
plot(m.magOf(3.0, 4.0))
`,
      { libraries: [POINT_LIB, lib3] },
    );
    const js = await bothBackends(c);
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(25, 9);
  });

  it("a method on a library's own module-level UDT var dispatches (was na)", async () => {
    const reg: LibraryRegistry = [
      {
        key: 'u/lib/1',
        source: `//@version=6
library("lib")
export type P
    float x = 0.0
export method mag(P self) => self.x * 2.0
var P gp = P.new(3.0)
export f() => gp.mag()
`,
      },
    ];
    const c = compile(
      `//@version=6
indicator("c")
import u/lib/1 as l
plot(l.f())
`,
      { libraries: reg },
    );
    const js = await bothBackends(c);
    expect(js.outputs.plots.get(0)!.data[9]).toBeCloseTo(6, 9);
  });
});
