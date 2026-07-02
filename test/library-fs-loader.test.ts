/**
 * Filesystem library loader (`@heyphat/piner/node`) — builds a LibraryRegistry from
 * `.pine` files on disk, then compiles/runs consumers against it on both backends.
 * Feature: library-import-export (Phase 1: filesystem loader).
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLibraryDir, loadLibraryManifest, fsLibrarySource } from '../src/node.js';
import { compile, Engine, ArrayFeed, CompileError, type Bar } from '../src/index.js';

// ── build a temp library tree: <root>/<pub>/<lib>/<version>.pine ──
const root = mkdtempSync(join(tmpdir(), 'piner-libs-'));
function writeLib(pub: string, lib: string, version: string, source: string): void {
  const dir = join(root, pub, lib);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${version}.pine`), source);
}
writeLib('PineCoders', 'AllTimeHighLow', '1', `//@version=6
library("AllTimeHighLow", true)
export hi(float val = high) =>
    var float ath = val
    ath := math.max(ath, val)
export lo(float val = low) =>
    var float atl = val
    atl := math.min(atl, val)
`);
writeLib('acme', 'util', '1', '//@version=6\nlibrary("util")\nexport base(float x) => x + 1.0\n');
writeLib('acme', 'util', '2', '//@version=6\nlibrary("util")\nimport acme/util/1 as prev\nexport base(float x) => prev.base(x) * 2.0\n');
// Noise that MUST be ignored by the scan.
writeFileSync(join(root, 'README.md'), '# not a library');
writeFileSync(join(root, 'acme', 'util', 'notes.txt'), 'ignore me');
writeFileSync(join(root, 'acme', 'util', '.hidden.pine'), 'library("hidden")');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const bars: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const c = 100 + Math.sin(i / 5) * 10 + i * 0.3;
  return { time: i * 60000, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + i };
});
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

async function bothAgree(consumer: string, libraries = loadLibraryDir(root)) {
  const c = compile(consumer, { libraries });
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
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

describe('filesystem library loader — hardening (audit fixes)', () => {
  it('fsLibrarySource matches identities case-sensitively', () => {
    const src = fsLibrarySource(root);
    expect(src({ publisher: 'acme', lib: 'util', version: '1', canonical: 'acme/util/1' })).toBeDefined();
    // On a case-insensitive filesystem (macOS/Windows) `existsSync` would match `acme/`;
    // the loader must still reject a mis-cased identity (consistent with loadLibraryDir).
    expect(src({ publisher: 'ACME', lib: 'util', version: '1', canonical: 'ACME/util/1' })).toBeUndefined();
    expect(src({ publisher: 'acme', lib: 'Util', version: '1', canonical: 'acme/Util/1' })).toBeUndefined();
  });

  it('loaders do not follow a symlink that escapes the library root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'piner-outside-'));
    writeFileSync(join(outside, '1.pine'), '//@version=6\nlibrary("Evil")\nexport f() => 0\n');
    const escRoot = mkdtempSync(join(tmpdir(), 'piner-esc-'));
    mkdirSync(join(escRoot, 'pub'), { recursive: true });
    try {
      symlinkSync(outside, join(escRoot, 'pub', 'evil'), 'dir'); // pub/evil -> outside tree
    } catch {
      rmSync(outside, { recursive: true, force: true });
      rmSync(escRoot, { recursive: true, force: true });
      return; // symlinks unavailable on this platform — skip
    }
    expect(loadLibraryDir(escRoot).map((e) => e.key)).toEqual([]);
    expect(fsLibrarySource(escRoot)({ publisher: 'pub', lib: 'evil', version: '1', canonical: 'pub/evil/1' })).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
    rmSync(escRoot, { recursive: true, force: true });
  });

  it('loadLibraryManifest rejects a source path that escapes the manifest directory', () => {
    const mroot = mkdtempSync(join(tmpdir(), 'piner-man-'));
    writeFileSync(join(mroot, 'manifest.json'), JSON.stringify({ 'a/b/1': '../../../../etc/hosts' }));
    expect(() => loadLibraryManifest(join(mroot, 'manifest.json'))).toThrow(/escapes/);
    rmSync(mroot, { recursive: true, force: true });
  });

  it('loadLibraryManifest rejects a SYMLINK inside the manifest dir that escapes it', () => {
    // A lexically-inside path (`lib.pine`) that is a symlink to an out-of-tree host file must
    // be refused — the lexical check alone would pass and read an arbitrary file.
    const mroot = mkdtempSync(join(tmpdir(), 'piner-man-'));
    const secretDir = mkdtempSync(join(tmpdir(), 'piner-secret-'));
    const secret = join(secretDir, 'credentials');
    writeFileSync(secret, 'TOP SECRET');
    try {
      symlinkSync(secret, join(mroot, 'lib.pine'), 'file'); // inside the manifest dir, points outside
    } catch {
      rmSync(mroot, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
      return; // symlinks unavailable on this platform — skip
    }
    writeFileSync(join(mroot, 'manifest.json'), JSON.stringify({ 'a/b/1': 'lib.pine' }));
    expect(() => loadLibraryManifest(join(mroot, 'manifest.json'))).toThrow(/escapes/);
    rmSync(mroot, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });
});

describe('filesystem library loader (@heyphat/piner/node)', () => {
  it('loadLibraryDir scans <pub>/<lib>/<version>.pine into a registry, ignoring noise', () => {
    const reg = loadLibraryDir(root);
    expect(reg.map((e) => e.key).sort()).toEqual([
      'PineCoders/AllTimeHighLow/1',
      'acme/util/1',
      'acme/util/2',
    ]);
    // .txt, README, and dot-hidden .pine are all excluded.
    expect(reg.some((e) => e.source.includes('ignore me'))).toBe(false);
    expect(reg.some((e) => e.source.includes('hidden'))).toBe(false);
  });

  it('a consumer compiles against the loaded registry (both backends agree)', async () => {
    const js = await bothAgree(`//@version=6
indicator("x")
import PineCoders/AllTimeHighLow/1 as ath
plot(ath.hi(), "ath")
plot(ath.lo(), "atl")
`);
    expect(js.outputs.plots.get(0)!.data.at(-1)).toBeCloseTo(Math.max(...bars.map((b) => b.high)), 9);
    expect(js.outputs.plots.get(1)!.data.at(-1)).toBeCloseTo(Math.min(...bars.map((b) => b.low)), 9);
  });

  it('transitive filesystem libraries resolve (acme/util/2 → acme/util/1)', async () => {
    const js = await bothAgree(`//@version=6
indicator("x")
import acme/util/2 as u
plot(u.base(close), "v2")
`);
    expect(js.outputs.plots.get(0)!.data.at(-1)).toBeCloseTo((bars.at(-1)!.close + 1) * 2, 9);
  });

  it('loadLibraryManifest maps identities to source files (paths relative to the manifest)', () => {
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ 'renamed/lib/9': 'PineCoders/AllTimeHighLow/1.pine' }));
    const reg = loadLibraryManifest(manifestPath);
    expect(reg).toHaveLength(1);
    expect(reg[0].key).toBe('renamed/lib/9');
    expect(reg[0].source).toContain('AllTimeHighLow');
  });

  it('a loaded registry still enforces the core guardrails (missing import → CompileError)', () => {
    const reg = loadLibraryDir(root);
    expect(() => compile('//@version=6\nindicator("x")\nimport who/knows/1 as w\nplot(w.f(close))\n', { libraries: reg }))
      .toThrow(CompileError);
  });

  it('throws a clear error for a non-existent directory', () => {
    expect(() => loadLibraryDir(join(root, 'does-not-exist'))).toThrow(/not a directory/);
  });
});
