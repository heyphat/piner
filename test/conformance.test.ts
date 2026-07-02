/**
 * Phase 9 — conformance & hardening.
 *
 * Three guards:
 *  1. Backend parity: a curated set of representative v6 scripts must run on BOTH
 *     backends with byte-for-byte identical output (the §7 oracle). This is the
 *     regression net for every builtin and lowering rule.
 *  2. Corpus floor: when the bundled Pine v6 reference manual is present, run the
 *     whole example corpus and assert a minimum compile+run rate AND zero backend
 *     divergences. Skipped gracefully if the manual isn't on this machine.
 *  3. Hardening: unsupported features fail cleanly (CompileError), not with a raw
 *     JS crash; and known correctness fixes (e.g. `na(x)`) stay fixed.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { compile, Engine, ArrayFeed, CompileError, type Bar } from '../src/index.js';

const DOCS = '/Users/phat/phat.vn/fractal-chart/pinescriptv6';
const FLOOR = 0.92; // full-script compile+run floor (measured ~0.96; guards regressions)

/** Run `fn`, returning the CompileError it throws (or undefined if it did not throw one). */
function catchCompile(fn: () => unknown): CompileError | undefined {
  try { fn(); } catch (e) { if (e instanceof CompileError) return e; throw e; }
  return undefined;
}

const bars: Bar[] = Array.from({ length: 60 }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 8 + (i % 7);
  return { time: i * 60000, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i * 3 };
});

/** Run both backends; return null if identical, else a description of the first divergence. */
async function parityDiff(src: string): Promise<string | null> {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '60' });
  await ip.run({ symbol: 'T', timeframe: '60' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id);
    if (!ipp) return `plot ${id} missing in interp backend`;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i], b = ipp.data[i];
      const same = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
      if (!same) return `plot ${id} bar ${i}: js=${a} ip=${b}`;
    }
  }
  return null;
}

// ── 1. Curated representative scripts (always runs) ──────────────────────────
const CURATED: Record<string, string> = {
  'plot + ta': '//@version=6\nindicator("x")\nplot(ta.sma(close, 5) + ta.ema(close, 9))\nplot(ta.rsi(close, 14))\n',
  'tuple ta + history': '//@version=6\nindicator("x")\n[m, s, l] = ta.macd(close, 12, 26, 9)\nplot(m - m[1])\nplot(s)\n',
  'var + na()': '//@version=6\nindicator("x")\nvar float hi = na\nhi := na(hi) ? high : math.max(hi, high)\nplot(hi)\nplot(na(hi[1]) ? 0.0 : 1.0)\n',
  'if-expression + switch': '//@version=6\nindicator("x")\nx = close > open ? 1.0 : -1.0\ny = switch\n    x > 0 => high\n    => low\nplot(y)\n',
  'for loop accumulate': '//@version=6\nindicator("x")\nsum = 0.0\nfor i = 0 to 4\n    sum += close[i]\nplot(sum / 5)\n',
  'UDF inlining': '//@version=6\nindicator("x")\nf(a, b) => a * 2 + b\nplot(f(close, open))\n',
  'UDT': '//@version=6\nindicator("x")\ntype P\n    float v = close\np = P.new()\nplot(p.v)\n',
  'enum': '//@version=6\nindicator("x")\nenum E\n    a = "A"\n    b = "B"\ne = E.b\nplot(e == "B" ? 1.0 : 0.0)\n',
  'arrays': '//@version=6\nindicator("x")\nvar a = array.new_float(0)\narray.push(a, close)\nplot(array.size(a) > 0 ? array.last(a) : na)\n',
  'request.security HTF': '//@version=6\nindicator("x")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d)\n',
  'math + color channels': '//@version=6\nindicator("x")\nplot(math.sin(close / 100) + math.sqrt(volume))\nplot(color.r(color.rgb(close % 255, 0, 0)))\n',
  'strategy': '//@version=6\nstrategy("x")\nif ta.crossover(ta.sma(close, 5), ta.sma(close, 20))\n    strategy.entry("L", strategy.long)\nplot(strategy.position_size)\n',
  'plot with per-bar color + fill': '//@version=6\nindicator("x")\np1 = plot(close)\np2 = plot(open)\nfill(p1, p2, color = close > open ? color.green : color.red)\n',
  'drawing objects': '//@version=6\nindicator("x", overlay = true)\nif barstate.islast\n    label.new(bar_index, high, "hi")\n    line.new(bar_index - 5, low, bar_index, high)\nplot(close)\n',
};

describe('conformance — backend parity (curated)', () => {
  for (const [name, src] of Object.entries(CURATED)) {
    it(name, async () => {
      expect(await parityDiff(src)).toBeNull();
    });
  }
});

// ── 2. Hardening regressions ─────────────────────────────────────────────────
describe('conformance — hardening', () => {
  it('na(x) is the is-na test (not the truthy na literal)', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(na(close) ? 1.0 : 2.0)\nplot(na(na) ? 1.0 : 2.0)\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(2); // close is not na
    expect(eng.outputs.plots.get(1)!.data[0]).toBe(1); // na IS na
  });

  it('unsupported library import fails as a clean CompileError (no raw crash)', () => {
    expect(() => compile('//@version=6\nindicator("x")\nimport user/lib/1 as lib\nplot(lib.f(close))\n')).toThrow(CompileError);
  });

  it('AlgoAlpha S/R Retest script: `import TradingView/ta/12` is rejected cleanly (library-import-export)', () => {
    // Feature library-import-export changed import semantics. This script does
    // `import TradingView/ta/12` with no alias, so its alias defaults to the lib
    // component `ta` — a reserved builtin namespace. piner deliberately does NOT
    // implement TradingView's builtin-namespace *extension*: an alias equal to a
    // builtin namespace is a CompileError (Req 3.7), and with no registry supplied
    // the library is unresolved (Req 2.8). Either way the compiler must fail cleanly
    // (a structured CompileError, never a raw crash) — this script is no longer
    // compilable as-authored.
    const src = readFileSync(join(import.meta.dir, 'pinescripts/lux-algo/support-resistent-retest.pine'), 'utf8');
    // No registry → missing-library CompileError naming the identity (Req 2.8).
    const noReg = catchCompile(() => compile(src));
    expect(noReg).toBeInstanceOf(CompileError);
    expect(noReg!.message.toLowerCase()).toContain('registry');
    expect(noReg!.message).toContain('TradingView/ta/12');
    // Even WITH the library provided, its default alias `ta` shadows the builtin
    // namespace → CompileError naming the namespace (Req 3.7).
    const withStub = catchCompile(() => compile(src, { libraries: [{ key: 'TradingView/ta/12', source: '//@version=6\nlibrary("ta")\nexport noop() => 0\n' }] }));
    expect(withStub).toBeInstanceOf(CompileError);
    expect(withStub!.message.toLowerCase()).toContain('namespace');
    expect(withStub!.message).toContain('ta');
  });

  it('a library-driven overlay script runs on both backends with byte-for-byte identical drawings', async () => {
    // Restores end-to-end two-backend + drawings coverage: an imported library computes a
    // level, the consumer draws a box + plots it, and both backends must agree exactly.
    const reg = [{ key: 'u/levels/1', source: '//@version=6\nlibrary("Levels")\nexport mid(float h, float l) => (h + l) / 2.0\n' }];
    const src = '//@version=6\nindicator("c", overlay=true)\nimport u/levels/1 as lv\nm = lv.mid(high, low)\nbox.new(bar_index, m + 1.0, bar_index + 1, m - 1.0)\nplot(m)\n';
    const c = compile(src, { libraries: reg });
    const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
    await js.run({ symbol: 'T', timeframe: '60' });
    await ip.run({ symbol: 'T', timeframe: '60' });
    expect(js.drawings.length).toBeGreaterThan(0);
    expect(JSON.stringify(js.drawings)).toBe(JSON.stringify(ip.drawings));
    expect(js.outputs.plots.get(0)!.data).toEqual(ip.outputs.plots.get(0)!.data);
  });

  it('AlgoAlpha Regression Trend script runs on both backends (color.new(na) is na, not a crash)', async () => {
    // Regression: on early bars reg is na, so color.from_gradient → NA flowed into
    // color.new(NA, …), which did `(col ?? default).slice(...)` and threw — aborting the
    // whole script. color.new(na) must now yield na and the script must render.
    const src = readFileSync(join(import.meta.dir, 'pinescripts/regression-trend.pine'), 'utf8');
    const c = compile(src);
    const run = (b: 'js' | 'interp') => {
      const eng = new Engine(c, new ArrayFeed(bars), { backend: b });
      return eng.run({ symbol: 'XAUUSDT', timeframe: '60' }).then(() => eng.outputs.plots.size);
    };
    const js = await run('js');
    expect(js).toBeGreaterThan(0);   // regression line + bands plotted, no crash
    expect(await run('interp')).toBe(js);
  });

  it('cross-symbol request.security degrades to na without throwing', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(request.security("NASDAQ:TSLA", "D", close))\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data.every((v) => Number.isNaN(v))).toBe(true);
  });
});

// ── 3. Reference-manual corpus floor + parity (only when present) ────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}
function blocks(md: string): string[] {
  const re = /```(?:pine|pinescript)\s*\n([\s\S]*?)```/g;
  const out: string[] = [];
  let m;
  while ((m = re.exec(md))) out.push(m[1]);
  return out;
}
const isScript = (s: string) => /\b(indicator|strategy|library)\s*\(/.test(s);
// Skip blocks that concatenate multiple scripts in one fence (doc artifacts).
const oneScript = (s: string) => (s.match(/\/\/@version=/g) ?? []).length <= 1;

describe('conformance — reference corpus', () => {
  const present = existsSync(DOCS);
  it.skipIf(!present)('meets the compile+run floor and has zero backend divergences', async () => {
    const srcs: string[] = [];
    for (const f of walk(DOCS)) srcs.push(...blocks(readFileSync(f, 'utf8')));
    const scripts = srcs.filter((s) => isScript(s) && oneScript(s));
    let ran = 0;
    const divergences: string[] = [];
    for (const src of scripts) {
      let c;
      try { c = compile(src); } catch { continue; }
      try {
        const eng = new Engine(c, new ArrayFeed(bars));
        await eng.run({ symbol: 'T', timeframe: '60' });
        ran++;
      } catch { continue; }
      // parity: anything that runs on js must match on interp
      try {
        const d = await parityDiff(src);
        if (d) divergences.push(d);
      } catch { /* interp-only throw is caught as a divergence proxy below */ divergences.push('interp threw'); }
    }
    const rate = ran / scripts.length;
    // eslint-disable-next-line no-console
    console.log(`corpus: ${ran}/${scripts.length} run (${(rate * 100).toFixed(1)}%), ${divergences.length} divergences`);
    if (divergences.length) console.log('  first divergences:', divergences.slice(0, 5));
    expect(rate).toBeGreaterThanOrEqual(FLOOR);
    expect(divergences.length).toBe(0);
  }, 60000);
});
