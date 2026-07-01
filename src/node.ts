/**
 * Node-only filesystem helpers for library import/export (`@heyphat/piner/node`).
 *
 * The core `compile()` is pure and browser-safe: it resolves `import`s only from an
 * in-memory {@link LibraryRegistry} and performs no I/O. This module is the OPTIONAL
 * Node "edge adapter" that BUILDS such a registry from `.pine` files on disk, so
 * server/CLI consumers don't have to assemble it by hand. It is published under the
 * `@heyphat/piner/node` subpath and is NEVER imported by the browser entry
 * (`@heyphat/piner`), so `node:fs` can never reach a browser bundle.
 *
 * ```ts
 * import { loadLibraryDir, compile } from '@heyphat/piner/node';
 * const libraries = loadLibraryDir('./pine-libs');   // reads disk → LibraryRegistry
 * const compiled  = compile(src, { libraries });      // core is unchanged & pure
 * ```
 *
 * Directory convention (mirrors TradingView's `Publisher/Lib/Version` identity):
 *
 * ```
 * pine-libs/
 *   PineCoders/AllTimeHighLow/1.pine   → identity "PineCoders/AllTimeHighLow/1"
 *   acme/util/1.pine                    → identity "acme/util/1"
 *   acme/util/2.pine                    → identity "acme/util/2"   (versions coexist)
 * ```
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname, basename } from 'node:path';
import type { LibraryIdentity, LibraryRegistry } from './sema/library.js';

// Re-export the full public API so Node consumers can use a single import if they wish.
export * from './index.js';

export interface LoadLibraryDirOptions {
  /** File extensions treated as library sources. Default: `['.pine']`. */
  extensions?: string[];
}

/**
 * Scan a directory laid out as `<root>/<publisher>/<lib>/<version>.pine` and return a
 * {@link LibraryRegistry} keyed by `"<publisher>/<lib>/<version>"`.
 *
 * The identity comes from the PATH (matching TradingView's `Publisher/Lib/Version`), not
 * the file's `library("…")` title. Multiple versions coexist as separate `<version>.pine`
 * files, so a library importing a previous version of itself resolves naturally.
 *
 * Non-matching entries are ignored: hidden dot-files, files with a non-matching extension,
 * non-regular files, and anything nested deeper than three levels. Duplicate identities are
 * surfaced later by `compile()` via its registry indexing.
 *
 * @throws if `root` does not exist or is not a directory.
 */
export function loadLibraryDir(root: string, opts: LoadLibraryDirOptions = {}): LibraryRegistry {
  const exts = opts.extensions ?? ['.pine'];
  const rootAbs = resolve(root);
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    throw new Error(`loadLibraryDir: not a directory: ${rootAbs}`);
  }
  const out: { key: string; source: string }[] = [];
  for (const publisher of subdirs(rootAbs)) {
    const pubPath = join(rootAbs, publisher);
    for (const lib of subdirs(pubPath)) {
      const libPath = join(pubPath, lib);
      for (const file of readdirSync(libPath)) {
        if (file.startsWith('.')) continue;
        const filePath = join(libPath, file);
        if (!statSync(filePath).isFile()) continue;
        const ext = extname(file);
        if (!exts.includes(ext)) continue;
        const version = basename(file, ext);
        if (!version) continue;
        out.push({ key: `${publisher}/${lib}/${version}`, source: readFileSync(filePath, 'utf8') });
      }
    }
  }
  return out;
}

/**
 * Load libraries from a JSON manifest mapping each identity string to a source-file path
 * (resolved relative to the manifest file). For layouts that don't follow the directory
 * convention. Example `manifest.json`:
 *
 * ```json
 * { "PineCoders/AllTimeHighLow/1": "athl.pine", "acme/util/1": "vendor/util.pine" }
 * ```
 */
export function loadLibraryManifest(manifestPath: string): LibraryRegistry {
  const abs = resolve(manifestPath);
  const base = dirname(abs);
  const map = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, string>;
  return Object.entries(map).map(([key, rel]) => ({
    key,
    source: readFileSync(resolve(base, rel), 'utf8'),
  }));
}

/** Non-hidden immediate subdirectory names of `dir`. */
function subdirs(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory());
}

/**
 * A LAZY filesystem source provider for use with `compileAsync(src, { resolveLibrary })`.
 * Unlike {@link loadLibraryDir} (which eagerly reads the whole tree), this reads a SINGLE
 * `<root>/<publisher>/<lib>/<version>.pine` file on demand, only for identities that are
 * actually imported. Ideal for a large on-disk library tree.
 *
 * ```ts
 * import { compileAsync, fsLibrarySource } from '@heyphat/piner/node';
 * const compiled = await compileAsync(src, { resolveLibrary: fsLibrarySource('./pine-libs') });
 * ```
 */
export function fsLibrarySource(root: string, opts: LoadLibraryDirOptions = {}): (identity: LibraryIdentity) => string | undefined {
  const exts = opts.extensions ?? ['.pine'];
  const rootAbs = resolve(root);
  return (identity) => {
    for (const ext of exts) {
      const filePath = join(rootAbs, identity.publisher, identity.lib, `${identity.version}${ext}`);
      if (existsSync(filePath) && statSync(filePath).isFile()) return readFileSync(filePath, 'utf8');
    }
    return undefined;
  };
}
