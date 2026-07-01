/**
 * Consumer alias binding + `alias.*` reference rewriting (Req 3, 4).
 *
 * Runs after the library graph is resolved and before the symbol merge. Builds the
 * Consumer_Script's alias table (validating duplicate aliases and builtin-namespace
 * collisions), then rewrites every `alias.symbol` reference to the mangled merged
 * name via the shared {@link RefRewriter}. The rewrite mutates the consumer Program
 * in place; the merged (mangled) library declarations are prepended afterwards.
 */
import type { Program, ImportStmt, Loc } from '../parser/ast.js';
import { NAMESPACES, type Diagnostic } from './analyze.js';
import {
  identityOfImport, RefRewriter, type LibraryIdentity, type ResolvedGraph,
} from './library.js';

export class AliasResolver {
  constructor(
    private graph: ResolvedGraph,
    private builtinNamespaces: ReadonlySet<string> = NAMESPACES,
  ) {}

  /**
   * Build the consumer alias table and rewrite `alias.*` references in place.
   * Returns the (validated) alias table and any diagnostics (duplicate alias,
   * namespace shadow, unresolved/private/ambiguous references).
   */
  bindAndRewrite(program: Program): { aliases: Map<string, LibraryIdentity>; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    const aliases = new Map<string, LibraryIdentity>();
    const conflicting = new Set<string>();

    for (const s of program.body) {
      if (s.kind !== 'Import') continue;
      const imp = s as ImportStmt;
      const id = identityOfImport(imp);
      // Req 3.2/3.3: alias defaults to the lib component when `as` is omitted.
      const alias = imp.alias ?? imp.lib;
      // Req 3.7: an alias may not shadow a reserved builtin namespace.
      if (this.builtinNamespaces.has(alias)) {
        diagnostics.push(err(`import alias '${alias}' shadows the reserved builtin namespace '${alias}'`, imp.loc));
        continue;
      }
      // Req 3.6: duplicate alias — neither import binds.
      if (aliases.has(alias) || conflicting.has(alias)) {
        diagnostics.push(err(`duplicate import alias '${alias}' — neither conflicting import is bound`, imp.loc));
        conflicting.add(alias);
        continue;
      }
      aliases.set(alias, id);
    }
    for (const a of conflicting) aliases.delete(a);

    const rewriter = new RefRewriter({
      aliases,
      graph: this.graph.libraries,
      emit: (d) => diagnostics.push(d),
    });
    rewriter.rewriteBody(program.body);

    return { aliases, diagnostics };
  }
}

function err(message: string, loc?: Loc): Diagnostic {
  return { severity: 'error', message, line: loc?.line ?? 0, col: loc?.col ?? 0 };
}
