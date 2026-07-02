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
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, extname, basename, sep } from 'node:path';
import type { LibraryIdentity, LibraryRegistry } from './sema/library.js';

/**
 * The real, canonical path of `p` if it resolves (following symlinks) to a location that
 * stays inside `rootReal`; otherwise `null`. Used so a symlink planted in the library
 * tree cannot make a loader read a file outside the intended root (a cross-tenant/host
 * read on a multi-publisher layout). Returns null for a non-existent path too.
 */
function realWithin(rootReal: string, p: string): string | null {
  let real: string;
  try { real = realpathSync(p); } catch { return null; }
  return real === rootReal || real.startsWith(rootReal + sep) ? real : null;
}

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
  const rootReal = realpathSync(rootAbs);
  const out: { key: string; source: string }[] = [];
  for (const publisher of subdirs(rootReal)) {
    const pubPath = join(rootReal, publisher);
    for (const lib of subdirs(pubPath)) {
      const libPath = join(pubPath, lib);
      for (const file of readdirSync(libPath)) {
        if (file.startsWith('.')) continue;
        const ext = extname(file);
        if (!exts.includes(ext)) continue;
        const version = basename(file, ext);
        if (!version) continue;
        // Read via the resolved path and require it to stay inside the root, so a
        // symlinked file/dir cannot pull source from outside the library tree.
        const real = realWithin(rootReal, join(libPath, file));
        if (!real || !statSync(real).isFile()) continue;
        out.push({ key: `${publisher}/${lib}/${version}`, source: readFileSync(real, 'utf8') });
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
  const baseReal = realpathSync(base);
  const map = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, string>;
  return Object.entries(map).map(([key, rel]) => {
    // Source paths are resolved relative to the manifest and must stay inside its
    // directory: a manifest value may not escape via `../…` or an absolute path and
    // read an arbitrary host file.
    const srcPath = resolve(base, rel);
    if (srcPath !== base && !srcPath.startsWith(base + sep)) {
      throw new Error(`loadLibraryManifest: source path "${rel}" for "${key}" escapes the manifest directory`);
    }
    // The lexical check above cannot see through symlinks. Follow them and require the
    // REAL target to stay inside the manifest directory too, so a symlink planted in the
    // tree (e.g. `lib.pine → /etc/passwd`) cannot read an arbitrary host file — matching
    // the realpath containment `loadLibraryDir`/`fsLibrarySource` enforce.
    let real: string;
    try { real = realpathSync(srcPath); } catch { throw new Error(`loadLibraryManifest: source "${rel}" for "${key}" does not exist`); }
    if (real !== baseReal && !real.startsWith(baseReal + sep)) {
      throw new Error(`loadLibraryManifest: source path "${rel}" for "${key}" escapes the manifest directory`);
    }
    if (!statSync(real).isFile()) {
      throw new Error(`loadLibraryManifest: source "${rel}" for "${key}" is not a regular file`);
    }
    return { key, source: readFileSync(real, 'utf8') };
  });
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
  let rootReal: string | null;
  try { rootReal = realpathSync(rootAbs); } catch { rootReal = null; }
  return (identity) => {
    if (rootReal === null) return undefined; // root does not exist
    for (const ext of exts) {
      const filePath = join(rootAbs, identity.publisher, identity.lib, `${identity.version}${ext}`);
      if (!existsSync(filePath)) continue;
      // Require the resolved path to equal the canonical in-root path built from the
      // identity's exact segments. This (a) enforces CASE-SENSITIVE matching even on a
      // case-insensitive filesystem (macOS/Windows), so `import Alice/…` does not match
      // `alice/…` — matching `loadLibraryDir` and the documented contract; and (b) blocks
      // any symlink whose target escapes the root.
      let real: string;
      try { real = realpathSync(filePath); } catch { continue; }
      const expected = join(rootReal, identity.publisher, identity.lib, `${identity.version}${ext}`);
      if (real === expected && statSync(real).isFile()) return readFileSync(real, 'utf8');
    }
    return undefined;
  };
}
