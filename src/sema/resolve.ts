/**
 * Async / lazy library resolution (Phase 2).
 *
 * The core `compile()` stays pure and synchronous: it resolves `import`s only from an
 * in-memory {@link LibraryRegistry}. This module adds the OPTIONAL async edge that gathers
 * that registry on demand — walking the transitive import graph and fetching only the
 * libraries that are actually imported, via a caller-supplied provider (HTTP, a CDN, a
 * database, the filesystem, …).
 *
 * It is browser-safe: it uses only the lexer/parser to discover imports and never performs
 * I/O itself — the provider does. Graph validation (cycles, versions, missing libraries,
 * export constraints) is still `compile()`'s job; this only collects sources.
 *
 * ```ts
 * import { compileAsync } from '@heyphat/piner';
 * const compiled = await compileAsync(src, {
 *   resolveLibrary: async ({ canonical }) => {
 *     const res = await fetch(`https://cdn.example.com/pine/${canonical}.pine`);
 *     return res.ok ? await res.text() : undefined;
 *   },
 * });
 * ```
 */
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { identityOfImport, normalizeIdentity } from './library.js';
import type { LibraryIdentity, LibraryRegistry } from './library.js';
import type { ImportStmt } from '../parser/ast.js';

/**
 * Provides the Pine source for a library identity, or `undefined` if it is unknown (an
 * unknown identity becomes a missing-library CompileError at compile time). May be sync or
 * async, so the same provider works for filesystem, HTTP, and in-memory sources.
 */
export type AsyncLibrarySource = (identity: LibraryIdentity) => string | undefined | Promise<string | undefined>;

export interface ResolveClosureOptions {
  /** Sources already in hand (identity → source), consulted before the provider. */
  seed?: LibraryRegistry;
  /** Safety cap on the number of libraries fetched (guards a pathological provider). Default 512. */
  maxLibraries?: number;
}

/** The import identities declared at the top level of a Pine source (parse-error-safe). */
function importIdentities(source: string): LibraryIdentity[] {
  let program;
  try {
    program = parse(tokenize(source));
  } catch {
    // A parse failure here is re-encountered and reported (with attribution) by compile().
    return [];
  }
  const ids: LibraryIdentity[] = [];
  for (const s of program.body) if (s.kind === 'Import') ids.push(identityOfImport(s as ImportStmt));
  return ids;
}

/**
 * Fetch the transitive closure of libraries reachable from `consumerSource`'s imports,
 * using `fetchSource` for any identity not already in `seed`, and return a
 * {@link LibraryRegistry} ready to pass to `compile(src, { libraries })`.
 *
 * Only imported libraries are fetched (lazy). Fetches are deduplicated by canonical
 * identity, so a cyclic graph terminates here (the cycle itself is reported later by
 * `compile()`). Unknown identities (provider returns `undefined`) are skipped so that
 * `compile()` raises the precise missing-library error.
 */
export async function resolveLibraryClosure(
  consumerSource: string,
  fetchSource: AsyncLibrarySource,
  opts: ResolveClosureOptions = {},
): Promise<LibraryRegistry> {
  const max = opts.maxLibraries ?? 512;
  const seed = new Map<string, string>();
  for (const e of opts.seed ?? []) seed.set(normalizeIdentity(e.key).canonical, e.source);

  const collected = new Map<string, string>();
  const queue: LibraryIdentity[] = importIdentities(consumerSource);
  while (queue.length) {
    const id = queue.shift()!;
    if (collected.has(id.canonical)) continue;
    let src = seed.get(id.canonical);
    if (src === undefined) src = await fetchSource(id);
    if (src === undefined) continue; // unknown → compile() raises the missing-library error
    collected.set(id.canonical, src);
    if (collected.size > max) {
      throw new Error(`resolveLibraryClosure: exceeded maxLibraries (${max}) — check the provider for runaway fan-out`);
    }
    for (const child of importIdentities(src)) {
      if (!collected.has(child.canonical)) queue.push(child);
    }
  }
  return [...collected].map(([key, source]) => ({ key, source }));
}
