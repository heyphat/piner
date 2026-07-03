/**
 * Real-world corpus gap classification.
 *
 * Runs a vendored sample of third-party Pine scripts (test/pinescripts/corpus/ — see its
 * README for provenance) through piner and buckets each by the FIRST stage it fails at:
 *
 *   pass        — compiles + runs on both backends, outputs agree
 *   parse       — ParseError (a parser/grammar gap)
 *   sema        — CompileError (undefined symbol / unsupported construct in analysis)
 *   runtime     — compiles, but a backend throws while running over bars
 *   divergence  — both run, but the codegen and interpreter backends disagree (a §7 bug)
 *
 * This is a GAP BACKLOG, not a pass/fail gate: a third-party corpus is expected to exercise
 * unsupported features, so the test always passes and PRINTS the classified backlog. Tighten
 * `MIN_PASS` over time to turn it into a regression guard. Run: `bun test test/corpus.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compile,
  CompileError,
  ParseError,
  Engine,
  ArrayFeed,
  type Bar,
  type LibraryRegistry,
} from '../src/index.js';

const DIR = resolve(import.meta.dir, 'pinescripts/corpus');

/**
 * In-memory library sources for corpus scripts that use `import` (library-import-export).
 * `fm-library-import-unused.pine` imports `user/lib/1 as Lib` (and never uses it); the
 * stub just needs to be a valid library so the import resolves. (The `TradingView/*`
 * importers — auto-pitchfork, lux-algo — live outside test/pinescripts/corpus/, so they
 * are not classified here.)
 */
const CORPUS_REGISTRY: LibraryRegistry = [
  { key: 'user/lib/1', source: '//@version=6\nlibrary("Lib")\nexport identity(float x) => x\n' },
];

// 150 hourly bars (trend + oscillation), valid OHLC, non-zero volume — enough for MAs to warm
// up, crossovers to fire, and highest/lowest windows to have signal.
const bars: Bar[] = Array.from({ length: 150 }, (_, i) => {
  const base = 100 + i * 0.3 + 8 * Math.sin(i / 6);
  const close = base + Math.cos(i / 5) * 2;
  return {
    time: Date.UTC(2024, 0, 1) + i * 3600_000,
    open: base,
    high: Math.max(base, close) + 1.5,
    low: Math.min(base, close) - 1.5,
    close,
    volume: 1000 + (i % 9) * 50,
  };
});

// piner targets Pine v5 + v6 (v4 and older are a deprecated, divergent dialect — out of scope).
const MIN_VERSION = 5;
type Stage = 'pass' | 'parse' | 'sema' | 'runtime' | 'divergence' | 'legacy';
const eqNaN = (a: number, b: number) =>
  (Number.isNaN(a) && Number.isNaN(b)) ||
  a === b ||
  (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

function pineVersion(src: string): number {
  const m = /@version\s*=\s*(\d+)/.exec(src);
  return m ? Number(m[1]) : 6; // no header ⇒ assume modern
}

async function classify(src: string): Promise<{ stage: Stage; detail: string }> {
  const v = pineVersion(src);
  if (v < MIN_VERSION)
    return { stage: 'legacy', detail: `//@version=${v} (pre-v${MIN_VERSION}, out of scope)` };
  let compiled;
  try {
    compiled = compile(src, { libraries: CORPUS_REGISTRY });
  } catch (e) {
    if (e instanceof ParseError) {
      return {
        stage: 'parse',
        detail: `${e.line}:${e.col} ${e.message.replace(/^Parse error at \d+:\d+:\s*/, '')}`,
      };
    }
    if (e instanceof CompileError) {
      const d = e.diagnostics.find((x) => x.severity === 'error');
      return {
        stage: 'sema',
        detail: d
          ? `${d.line}:${d.col} ${d.message}`
          : (e.message.split('\n')[1]?.trim() ?? e.message),
      };
    }
    return { stage: 'sema', detail: (e as Error).message.split('\n')[0] };
  }
  const run = async (backend: 'js' | 'interp') => {
    const e = new Engine(compiled, new ArrayFeed(bars), { backend });
    await e.run({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
    return e;
  };
  let js, ip;
  try {
    js = await run('js');
  } catch (e) {
    return { stage: 'runtime', detail: `js: ${(e as Error).message.split('\n')[0]}` };
  }
  try {
    ip = await run('interp');
  } catch (e) {
    return { stage: 'runtime', detail: `interp: ${(e as Error).message.split('\n')[0]}` };
  }
  // both ran — check the two backends produced the same plot series (the §7 invariant)
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id);
    if (!ipp)
      return {
        stage: 'divergence',
        detail: `plot ${id} ("${jp.title}") present in js, absent in interp`,
      };
    for (let i = 0; i < jp.data.length; i++) {
      if (!eqNaN(jp.data[i], ipp.data[i])) {
        return {
          stage: 'divergence',
          detail: `plot "${jp.title}" bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`,
        };
      }
    }
  }
  return { stage: 'pass', detail: '' };
}

// Floor for the pass count — bump it as gaps get fixed so a regression (a script that used to
// pass and now doesn't) fails this test. Includes `fm-library-import-unused.pine`, which now
// resolves its `import user/lib/1` against CORPUS_REGISTRY (library-import-export).
const MIN_PASS = 32;

describe('pinescripts corpus — gap classification', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.pine'))
    .sort();

  it('classifies every corpus script and prints the gap backlog', async () => {
    expect(files.length).toBeGreaterThan(0);

    const results: { file: string; stage: Stage; detail: string }[] = [];
    for (const f of files)
      results.push({ file: f, ...(await classify(readFileSync(resolve(DIR, f), 'utf8'))) });

    const order: Stage[] = ['pass', 'parse', 'sema', 'runtime', 'divergence', 'legacy'];
    const by: Record<Stage, typeof results> = {
      pass: [],
      parse: [],
      sema: [],
      runtime: [],
      divergence: [],
      legacy: [],
    };
    for (const r of results) by[r.stage].push(r);

    const inScope = files.length - by.legacy.length;
    const lines: string[] = [
      `\n===== piner corpus gap backlog — ${files.length} scripts (${inScope} in-scope v${MIN_VERSION}+, ${by.legacy.length} legacy) =====`,
    ];
    for (const s of order)
      lines.push(
        `  ${s.padEnd(11)} ${by[s].length}${s === 'legacy' ? '  (excluded — pre-v' + MIN_VERSION + ')' : ''}`,
      );
    // gap backlog: only the in-scope failure stages drive the work
    for (const s of ['parse', 'sema', 'runtime', 'divergence'] as Stage[]) {
      if (!by[s].length) continue;
      lines.push(`\n--- ${s} (${by[s].length}) ---`);
      for (const r of by[s]) lines.push(`  ${r.file}\n      ${r.detail}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    expect(results.every((r) => order.includes(r.stage))).toBe(true); // everything classified
    expect(by.pass.length).toBeGreaterThanOrEqual(MIN_PASS); // regression floor (in-scope passes)
  }, 120_000);
});
