/**
 * Async / lazy library resolution (Phase 2): resolveLibraryClosure, compileAsync, and the
 * lazy fsLibrarySource provider. Feature: library-import-export.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compile, compileAsync, resolveLibraryClosure, CompileError,
  Engine, ArrayFeed, type Bar, type LibraryIdentity,
} from '../src/index.js';
import { fsLibrarySource } from '../src/node.js';

const bars: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const c = 100 + Math.sin(i / 5) * 10 + i * 0.3;
  return { time: i * 60000, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i };
});
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

async function bothAgree(compiled: Awaited<ReturnType<typeof compileAsync>>) {
  const js = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(compiled, new ArrayFeed(bars), { backend: 'interp' });
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

// A simulated "remote registry" of library sources, keyed by canonical identity.
const REMOTE: Record<string, string> = {
  'acme/base/1': '//@version=6\nlibrary("Base")\nexport inc(float x) => x + 1.0\n',
  'acme/mid/1': '//@version=6\nlibrary("Mid")\nimport acme/base/1 as b\nexport twice(float x) => b.inc(x) * 2.0\n',
  'acme/unused/1': '//@version=6\nlibrary("Unused")\nexport nope(float x) => x\n',
};
const consumer = `//@version=6
indicator("async consumer")
import acme/mid/1 as m
plot(m.twice(close), "twice")
`;

describe('async/lazy library resolution — resolveLibraryClosure', () => {
  it('gathers the transitive closure via an async provider (only what is imported)', async () => {
    const fetched: string[] = [];
    const provider = async (id: LibraryIdentity) => {
      fetched.push(id.canonical);
      await Promise.resolve(); // simulate async I/O
      return REMOTE[id.canonical];
    };
    const registry = await resolveLibraryClosure(consumer, provider);
    // mid + base fetched (transitive); unused NOT reached.
    expect(fetched.sort()).toEqual(['acme/base/1', 'acme/mid/1']);
    expect(registry.map((e) => e.key).sort()).toEqual(['acme/base/1', 'acme/mid/1']);
    // the gathered registry compiles + runs on both backends.
    const js = await bothAgree(compile(consumer, { libraries: registry }));
    expect(js.outputs.plots.get(0)!.data.at(-1)).toBeCloseTo((bars.at(-1)!.close + 1) * 2, 9);
  });

  it('a cyclic graph terminates during gathering (compile then reports the cycle)', async () => {
    const cyc: Record<string, string> = {
      'x/a/1': '//@version=6\nlibrary("A")\nimport x/b/1 as b\nexport fa(float v) => b.fb(v)\n',
      'x/b/1': '//@version=6\nlibrary("B")\nimport x/a/1 as a\nexport fb(float v) => a.fa(v)\n',
    };
    const src = '//@version=6\nindicator("c")\nimport x/a/1 as a\nplot(a.fa(close))\n';
    const registry = await resolveLibraryClosure(src, (id) => cyc[id.canonical]); // does not hang
    expect(registry.map((e) => e.key).sort()).toEqual(['x/a/1', 'x/b/1']);
    expect(() => compile(src, { libraries: registry })).toThrow(/cyclic/i);
  });

  it('honors a seed registry (provider not called for seeded identities)', async () => {
    const fetched: string[] = [];
    const provider = async (id: LibraryIdentity) => { fetched.push(id.canonical); return REMOTE[id.canonical]; };
    const registry = await resolveLibraryClosure(consumer, provider, {
      seed: [{ key: 'acme/mid/1', source: REMOTE['acme/mid/1'] }],
    });
    // mid was seeded → provider only fetched base.
    expect(fetched).toEqual(['acme/base/1']);
    expect(registry.map((e) => e.key).sort()).toEqual(['acme/base/1', 'acme/mid/1']);
  });
});

describe('async/lazy library resolution — compileAsync', () => {
  it('compiles through an async (mock-HTTP) provider; both backends agree', async () => {
    const provider = async (id: LibraryIdentity) => {
      await Promise.resolve();
      return REMOTE[id.canonical];
    };
    const compiled = await compileAsync(consumer, { resolveLibrary: provider });
    const js = await bothAgree(compiled);
    expect(js.outputs.plots.get(0)!.data.at(-1)).toBeCloseTo((bars.at(-1)!.close + 1) * 2, 9);
  });

  it('a provider returning undefined yields a missing-library CompileError', async () => {
    const provider = async () => undefined;
    await expect(compileAsync(consumer, { resolveLibrary: provider })).rejects.toThrow(CompileError);
  });

  it('without resolveLibrary it is exactly compile()', async () => {
    const src = '//@version=6\nindicator("c")\nplot(ta.sma(close, 5))\n';
    const a = await compileAsync(src);
    const b = compile(src);
    expect(a.source).toBe(b.source);
  });
});

describe('async/lazy library resolution — fsLibrarySource (Node, lazy)', () => {
  const root = mkdtempSync(join(tmpdir(), 'piner-lazy-'));
  const write = (pub: string, lib: string, v: string, src: string) => {
    mkdirSync(join(root, pub, lib), { recursive: true });
    writeFileSync(join(root, pub, lib, `${v}.pine`), src);
  };
  write('acme', 'base', '1', REMOTE['acme/base/1']);
  write('acme', 'mid', '1', REMOTE['acme/mid/1']);
  write('acme', 'unused', '1', REMOTE['acme/unused/1']); // must NOT be read
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads only the imported files on demand (lazy)', async () => {
    const base = fsLibrarySource(root);
    const read: string[] = [];
    const counting = (id: LibraryIdentity) => { const s = base(id); if (s !== undefined) read.push(id.canonical); return s; };
    const compiled = await compileAsync(consumer, { resolveLibrary: counting });
    expect(read.sort()).toEqual(['acme/base/1', 'acme/mid/1']); // unused not read
    await bothAgree(compiled);
  });

  it('returns undefined for an unknown identity', () => {
    const provider = fsLibrarySource(root);
    expect(provider({ publisher: 'no', lib: 'such', version: '9', canonical: 'no/such/9' })).toBeUndefined();
  });
});
