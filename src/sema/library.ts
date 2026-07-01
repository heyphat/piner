/**
 * Library import/export resolution (local, registry-based).
 *
 * piner does NOT fetch libraries from a network or filesystem. A caller supplies
 * their own library sources through an in-memory {@link LibraryRegistry} passed to
 * `compile(...)`; this module resolves imported symbols from those sources with no
 * I/O, keeping compilation deterministic and reproducible.
 *
 * Strategy: **inline-merge**. Each imported library's exported (and reachable
 * private) declarations are cloned into the Consumer_Script's top-level `body`
 * with per-identity name mangling, and every `alias.symbol` reference is rewritten
 * to the mangled name. After the merge the existing
 * `inlineUserFunctions → analyze → emit/interpret` pipeline runs unchanged, so
 * imported functions get the identical monomorphization + per-call-site slot
 * allocation as local functions and the two-backend byte-for-byte invariant holds
 * by construction. See docs/compiler-design.md and the feature design doc.
 */
import type {
  Program, Stmt, Expr, FuncDef, TypeDef, VarDecl, ImportStmt, Call, Arg,
  Loc, Member, Ident,
} from '../parser/ast.js';
import type { PineType } from './types.js';
import { parse } from '../parser/parser.js';
import { ParseError } from '../parser/parser.js';
import { tokenize } from '../lexer/lexer.js';
import { CompileError, OUTPUT_FNS, type Diagnostic } from './analyze.js';

// ───────────────────────── Public types ─────────────────────────

/** Structured identity form accepted as a registry key. */
export interface LibraryIdentityObject {
  user: string;
  lib: string;
  version: string;
}

/** A registry key is either `"Publisher/Lib/Version"` or the structured object. */
export type LibraryRegistryKey = string | LibraryIdentityObject;

/**
 * Caller-supplied library sources. An array of entries (not a Map) so BOTH key
 * forms are expressible and duplicate detection can run over all entries.
 */
export type LibraryRegistry = ReadonlyArray<{
  key: LibraryRegistryKey;
  source: string;
}>;

/** Canonical, validated identity used everywhere internally. */
export interface LibraryIdentity {
  publisher: string;
  lib: string;
  version: string;
  /** Canonical string `"publisher/lib/version"` for map keys and messages. */
  readonly canonical: string;
}

/** Options accepted by `compile(...)`. Backward compatible: existing callers omit it. */
export interface CompileOptions {
  /** In-memory library sources. Absent ⇒ no imports may resolve. */
  libraries?: LibraryRegistry;
}

// ───────────────────────── Identity normalization ─────────────────────────

/** Build a canonical identity object from validated parts. */
function makeIdentity(publisher: string, lib: string, version: string): LibraryIdentity {
  return { publisher, lib, version, canonical: `${publisher}/${lib}/${version}` };
}

/** True for a non-empty string with no `/` separators (a valid identity segment). */
function validSegment(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && !s.includes('/');
}

/**
 * Parse/validate a registry key into a canonical {@link LibraryIdentity}, or throw
 * a {@link CompileError} naming the malformed key (Req 2.7). Matching is
 * case-sensitive and exact on all three segments (Req 2.2, 2.3, 3.1).
 */
export function normalizeIdentity(key: LibraryRegistryKey): LibraryIdentity {
  if (typeof key === 'string') {
    const segs = key.split('/');
    // Exactly three non-empty segments. `split` on empty/extra `/` yields empty
    // segments, so a plain length + non-empty check is total.
    if (segs.length !== 3 || segs.some((s) => s.length === 0)) {
      throw malformedKey(key, 'expected exactly three non-empty "Publisher/Lib/Version" segments');
    }
    return makeIdentity(segs[0], segs[1], segs[2]);
  }
  if (key && typeof key === 'object') {
    const { user, lib, version } = key;
    if (!validSegment(user) || !validSegment(lib) || !validSegment(version)) {
      throw malformedKey(
        keyLabel(key),
        'object key requires non-empty "user", "lib", and "version" values without "/"',
      );
    }
    return makeIdentity(user, lib, version);
  }
  throw malformedKey(keyLabel(key), 'a registry key must be a string or a {user,lib,version} object');
}

function keyLabel(key: unknown): string {
  if (typeof key === 'string') return key;
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

function malformedKey(label: string, why: string): CompileError {
  return diagError(`malformed library registry key ${JSON.stringify(label)}: ${why}`);
}

/** The canonical identity of a parsed `import` statement (version stringified). */
export function identityOfImport(stmt: ImportStmt): LibraryIdentity {
  return makeIdentity(stmt.user, stmt.lib, String(stmt.version));
}

// ───────────────────────── Registry indexing ─────────────────────────

/**
 * Build a `canonical → source` map, throwing on the FIRST pair of entries (in any
 * key-form combination) that normalize to the same canonical identity (Req 2.6).
 * Both key forms are compared post-normalization.
 */
export function indexRegistry(reg: LibraryRegistry): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of reg) {
    const id = normalizeIdentity(entry.key); // Req 2.7 (malformed keys) first
    if (out.has(id.canonical)) {
      throw diagError(`duplicate library identity "${id.canonical}" in the registry`);
    }
    out.set(id.canonical, entry.source);
  }
  return out;
}

// ───────────────────────── Declaration classification (Req 1) ─────────────────────────

const DECL_NAMES = new Set(['indicator', 'strategy', 'library']);

export type DeclKind = 'indicator' | 'strategy' | 'library';

export interface DeclInfo {
  kind: DeclKind;
  title: string;
  overlay: boolean;
}

/** The top-level `indicator`/`strategy`/`library` declaration calls in a program. */
function declarationCalls(program: Program): Call[] {
  const out: Call[] = [];
  for (const s of program.body) {
    if (s.kind !== 'ExprStmt' || s.expr.kind !== 'Call') continue;
    const callee = s.expr.callee;
    if (callee.kind === 'Ident' && DECL_NAMES.has(callee.name)) out.push(s.expr);
  }
  return out;
}

/**
 * Classify a program's top-level declaration and validate it (Req 1).
 *
 * - More than one of `indicator`/`strategy`/`library` → CompileError (Req 1.5).
 * - `library(...)` requires a non-empty string-literal title (Req 1.2, 1.6, 1.7).
 * - `overlay` boolean recorded; absent ⇒ `false` (Req 1.3, 1.4).
 *
 * A script with no declaration is treated leniently as an `indicator` with an
 * empty title (piner has always tolerated header-less snippets); the resolver is
 * responsible for rejecting a non-`library` script used as an imported library.
 */
export function classifyDeclaration(program: Program): DeclInfo {
  const decls = declarationCalls(program);
  if (decls.length > 1) {
    const names = decls
      .map((c) => (c.callee.kind === 'Ident' ? c.callee.name : '?'))
      .join(', ');
    throw diagError(
      `a script may declare only one of indicator/strategy/library, found ${decls.length}: ${names}`,
      decls[1].loc,
    );
  }
  if (decls.length === 0) return { kind: 'indicator', title: '', overlay: false };

  const call = decls[0];
  const kind = (call.callee as { name: DeclKind }).name;
  const titleArg = call.args.find((a) => a.name === 'title') ?? call.args.find((a) => !a.name);
  const overlayArg = call.args.find((a) => a.name === 'overlay');
  const overlay = overlayArg?.value.kind === 'Bool' ? overlayArg.value.value : false;

  if (kind === 'library') {
    if (!titleArg) {
      throw diagError('library(...) is missing its required title argument', call.loc);
    }
    if (titleArg.value.kind !== 'String') {
      throw diagError('library(...) title must be a string literal', titleArg.value.loc ?? call.loc);
    }
    if (titleArg.value.value.length === 0) {
      throw diagError('library(...) title must be a non-empty string', titleArg.value.loc ?? call.loc);
    }
    return { kind, title: titleArg.value.value, overlay };
  }

  const title = titleArg?.value.kind === 'String' ? titleArg.value.value : '';
  return { kind, title, overlay };
}

// ───────────────────────── Shared error helpers ─────────────────────────

/** Construct a single-diagnostic CompileError, optionally attributed to a library. */
export function diagError(
  message: string,
  loc?: { line: number; col: number },
  library?: LibraryIdentity,
  importChain?: LibraryIdentity[],
): CompileError {
  const d: Diagnostic = {
    severity: 'error',
    message,
    line: loc?.line ?? 0,
    col: loc?.col ?? 0,
  };
  if (library) d.library = library;
  if (importChain && importChain.length) d.importChain = importChain;
  return new CompileError(`Pine compile failed:\n  ${d.line}:${d.col} ${message}`, [d]);
}

// ───────────────────────── Name mangling ─────────────────────────

/** Per-identity slug. `$` is not a legal Pine identifier char, so a mangled name
 *  can never be produced by user source or collide with a builtin/local. */
export function slug(id: LibraryIdentity): string {
  return `${id.publisher}$${id.lib}$${id.version}`;
}

/** Mangle a library symbol to a globally-unique merged name (encodes the identity,
 *  not the alias, so the same library reached via any alias/path merges once). */
export function mangle(id: LibraryIdentity, symbol: string): string {
  return `__lib$${slug(id)}$${symbol}`;
}

// ───────────────────────── Library surface (Req 3.2, 4, 7.3) ─────────────────────────

/** One exported (or, for intra-lib dispatch, declared) method with its receiver info. */
export interface ExportedMethod {
  def: FuncDef;
  /** Original UDT/fundamental type name of param 0 (the receiver). */
  receiverType: string;
  /** Total parameter count (including the receiver). */
  arity: number;
}

/** A library's public API — only `export`-marked declarations (Req 7.3). */
export interface LibrarySurface {
  identity: LibraryIdentity;
  functions: Map<string, FuncDef>;
  types: Map<string, TypeDef>;
  enums: Map<string, TypeDef>;
  methods: Map<string, ExportedMethod[]>;
  /** Exported constants/variables (`export NAME = …`), bindable as `alias.NAME`.
   *  A Pine v6 feature (post-dating the base Libraries doc); resolved as a value. */
  constants: Set<string>;
}

/** The type name of a param's declared type, or a fundamental kind, for dispatch. */
function paramTypeName(fd: FuncDef): string {
  const t = fd.params[0]?.declType;
  if (!t) return '';
  if (t.kind === 'udt') return t.name;
  return t.kind;
}

function methodInfo(fd: FuncDef): ExportedMethod {
  return { def: fd, receiverType: paramTypeName(fd), arity: fd.params.length };
}

/**
 * Index a library program's `export`-marked functions, UDTs, enums, and methods.
 * Non-`export` declarations are intentionally excluded (they stay in the program
 * for merge but are not bindable by an alias — Req 4.5, 7.3).
 */
export function collectSurface(identity: LibraryIdentity, program: Program): LibrarySurface {
  const surface: LibrarySurface = {
    identity,
    functions: new Map(),
    types: new Map(),
    enums: new Map(),
    methods: new Map(),
    constants: new Set(),
  };
  for (const s of program.body) {
    if (s.kind === 'FuncDef' && s.export) {
      if (s.isMethod) {
        const list = surface.methods.get(s.name) ?? [];
        list.push(methodInfo(s));
        surface.methods.set(s.name, list);
      } else {
        surface.functions.set(s.name, s);
      }
    } else if (s.kind === 'TypeDef' && s.export) {
      (s.isEnum ? surface.enums : surface.types).set(s.name, s);
    } else if (s.kind === 'VarDecl' && s.export) {
      surface.constants.add(s.name);
    }
  }
  return surface;
}

// ───────────────────────── Transitive resolution (Req 8) ─────────────────────────

/** A fully resolved library node. */
export interface ResolvedLibrary {
  identity: LibraryIdentity;
  program: Program;
  surface: LibrarySurface;
  /** This library's OWN imports: alias → identity (for merge-time scoping, Req 8.6). */
  imports: Map<string, LibraryIdentity>;
  metadata: DeclInfo;
  /** Every top-level declaration name (exported + private) for private-vs-unresolved. */
  allNames: Set<string>;
  /** Every declared method (exported + private) grouped by name for intra-lib dispatch. */
  allMethods: Map<string, ExportedMethod[]>;
  /** The ordered import chain Consumer → … → this library (first discovery), for Req 9.4. */
  chain: LibraryIdentity[];
}

/** The libraries reachable from the Consumer_Script, resolved exactly once each. */
export interface ResolvedGraph {
  /** canonical identity → resolved library. */
  libraries: Map<string, ResolvedLibrary>;
}

/** All top-level declaration names + all methods (exported and private). */
function collectAll(program: Program): { allNames: Set<string>; allMethods: Map<string, ExportedMethod[]> } {
  const allNames = new Set<string>();
  const allMethods = new Map<string, ExportedMethod[]>();
  for (const s of program.body) {
    if (s.kind === 'FuncDef') {
      allNames.add(s.name);
      if (s.isMethod) {
        const list = allMethods.get(s.name) ?? [];
        list.push(methodInfo(s));
        allMethods.set(s.name, list);
      }
    } else if (s.kind === 'TypeDef') {
      allNames.add(s.name);
    } else if (s.kind === 'VarDecl') {
      // ALL top-level vars (exported AND private) are self-mangled: their declarations
      // are merged with a mangled name, so intra-library references must be rewritten
      // too — otherwise a private module constant/var becomes a dangling name (or, worse,
      // silently binds to a same-named symbol in the consumer). Exported vars are still
      // not part of the bindable surface (only fns/UDTs/enums/methods are).
      allNames.add(s.name);
    }
  }
  return { allNames, allMethods };
}

const MAX_IMPORT_DEPTH = 32;

/** Re-stamp every diagnostic of a CompileError with library/importChain attribution. */
function attribute(err: CompileError, library: LibraryIdentity, chain: LibraryIdentity[]): CompileError {
  const diags = err.diagnostics.map((d) => ({
    ...d,
    library: d.library ?? library,
    importChain: d.importChain ?? (chain.length ? chain : undefined),
  }));
  return new CompileError(err.message, diags);
}

/**
 * Resolves the full library graph reachable from a Consumer_Script's imports.
 * Deterministic, registry-only, no I/O (Req 2.5). Throws CompileError/ParseError
 * with identity + chain attribution.
 */
export class LibraryResolver {
  private visited = new Map<string, ResolvedLibrary>();
  /** "publisher/lib" → available versions, for distinguishing a version mismatch
   *  (Req 3.5) from a wholly-missing library (Req 2.8/8.4). */
  private readonly byPubLib = new Map<string, string[]>();

  constructor(private registry: Map<string, string>) {
    for (const canonical of registry.keys()) {
      const slash = canonical.lastIndexOf('/');
      const pubLib = canonical.slice(0, slash);
      const version = canonical.slice(slash + 1);
      const arr = this.byPubLib.get(pubLib);
      if (arr) arr.push(version);
      else this.byPubLib.set(pubLib, [version]);
    }
  }

  /** Resolve every library reachable from the consumer's direct imports. */
  resolve(consumerImports: ImportStmt[]): ResolvedGraph {
    for (const imp of consumerImports) {
      const id = identityOfImport(imp);
      this.resolveOne(id, [id], []);
    }
    return { libraries: this.visited };
  }

  /**
   * @param id      the library to resolve
   * @param chain   Consumer → … → id (for depth cap + attribution)
   * @param active  ancestors currently being resolved (for cycle detection)
   */
  private resolveOne(id: LibraryIdentity, chain: LibraryIdentity[], active: LibraryIdentity[]): ResolvedLibrary {
    // Cycle: re-entering a library still being resolved higher on the stack (Req 8.3).
    const cyc = active.findIndex((a) => a.canonical === id.canonical);
    if (cyc !== -1) {
      const cycle = [...active.slice(cyc), id].map((c) => c.canonical).join(' -> ');
      throw diagError(`cyclic library import detected: ${cycle}`, undefined, id, chain);
    }
    // Resolve-once: a completed library is reused regardless of import path (Req 8.2).
    const cached = this.visited.get(id.canonical);
    if (cached) return cached;
    // Depth cap (chain includes id itself as its last element) (Req 8.1, 8.5).
    if (chain.length > MAX_IMPORT_DEPTH) {
      throw diagError(
        `transitive import nesting exceeded the maximum of ${MAX_IMPORT_DEPTH} levels at ${id.canonical}`,
        undefined, id, chain,
      );
    }
    // Registry presence. A publisher+lib match with a different version is a version
    // mismatch (Req 3.5); otherwise the library is wholly missing (Req 2.8/3.4 direct,
    // Req 8.4 transitive — naming the importer).
    const source = this.registry.get(id.canonical);
    if (source === undefined) {
      const available = this.byPubLib.get(`${id.publisher}/${id.lib}`);
      if (available && available.length) {
        throw diagError(
          `import of "${id.canonical}" requests version "${id.version}", but the registry provides version(s) ${available.map((v) => `"${v}"`).join(', ')} for ${id.publisher}/${id.lib}`,
          undefined, id, chain,
        );
      }
      if (chain.length <= 1) {
        throw diagError(`imported library "${id.canonical}" is not present in the library registry`, undefined, id);
      }
      const importer = chain[chain.length - 2];
      throw diagError(
        `library "${id.canonical}" imported by "${importer.canonical}" is not present in the library registry`,
        undefined, id, chain,
      );
    }
    // Parse (Req 9.1: attribute a library parse failure to its identity + chain).
    let program: Program;
    try {
      program = parse(tokenize(source));
    } catch (e) {
      if (e instanceof ParseError) {
        throw new ParseError(e.raw, e.line, e.col, id, chain);
      }
      throw e;
    }
    // Validate it is a library(...) script with a valid title (Req 1, attributed).
    let metadata: DeclInfo;
    try {
      metadata = classifyDeclaration(program);
    } catch (e) {
      if (e instanceof CompileError) throw attribute(e, id, chain);
      throw e;
    }
    if (metadata.kind !== 'library') {
      throw diagError(
        `imported script "${id.canonical}" is not a library (its top-level declaration is ${metadata.kind}(...))`,
        program.body.find((s) => s.kind === 'ExprStmt')?.loc, id, chain,
      );
    }
    // Recurse into this library's own imports (scoped to it — Req 8.6).
    const imports = new Map<string, LibraryIdentity>();
    const nextActive = [...active, id];
    for (const s of program.body) {
      if (s.kind !== 'Import') continue;
      const childId = identityOfImport(s);
      this.resolveOne(childId, [...chain, childId], nextActive);
      const alias = s.alias ?? s.lib;
      imports.set(alias, childId);
    }
    const surface = collectSurface(id, program);
    const { allNames, allMethods } = collectAll(program);
    const resolved: ResolvedLibrary = { identity: id, program, surface, imports, metadata, allNames, allMethods, chain: [...chain] };
    this.visited.set(id.canonical, resolved);
    return resolved;
  }
}

// ───────────────────────── Reference rewriting (Req 4, 8.6) ─────────────────────────

/** A consumer/library variable known to hold a value of a resolved UDT type. */
interface UdtOrigin {
  identity: LibraryIdentity;
  /** The library-local (unmangled) type name. */
  typeName: string;
}

export interface RewriteOptions {
  /** alias → identity (the Consumer_Script's aliases, or a library's own imports). */
  aliases: Map<string, LibraryIdentity>;
  /** canonical → resolved library (the whole graph). */
  graph: Map<string, ResolvedLibrary>;
  /** Present when rewriting a library's OWN declarations (intra-lib self-mangling). */
  self?: { identity: LibraryIdentity; names: Set<string>; methods: Map<string, ExportedMethod[]>; chain: LibraryIdentity[] };
  /** Diagnostic sink. */
  emit: (d: Diagnostic) => void;
}

/** Build a diagnostic, optionally attributed to a library + import chain (Req 9.3, 9.4). */
function mkDiag(message: string, loc?: Loc, library?: LibraryIdentity, importChain?: LibraryIdentity[]): Diagnostic {
  const d: Diagnostic = { severity: 'error', message, line: loc?.line ?? 0, col: loc?.col ?? 0 };
  if (library) d.library = library;
  if (importChain && importChain.length) d.importChain = importChain;
  return d;
}

/**
 * Every name bound locally within a function (its params + every local var/tuple/loop
 * variable, including those nested in control-flow expression bodies). A name in this
 * set shadows any module-level (self) declaration, so it must NOT be self-mangled —
 * otherwise `export calc(float helper) => helper * 2` would rewrite the param to a
 * same-named sibling function.
 */
function collectBindingNames(params: string[], body: Stmt[]): Set<string> {
  const names = new Set<string>(params);
  const walkStmt = (s: Stmt): void => {
    switch (s.kind) {
      case 'VarDecl': names.add(s.name); walkExpr(s.init); break;
      case 'TupleDecl': s.names.forEach((n) => names.add(n)); walkExpr(s.init); break;
      case 'Reassign': walkExpr(s.value); break;
      case 'ExprStmt': walkExpr(s.expr); break;
      case 'For': names.add(s.varName); walkExpr(s.from); walkExpr(s.to); if (s.step) walkExpr(s.step); s.body.forEach(walkStmt); break;
      case 'ForIn': if (s.indexName) names.add(s.indexName); names.add(s.valueName); walkExpr(s.iterable); s.body.forEach(walkStmt); break;
      case 'If': walkExpr(s.cond); s.then.forEach(walkStmt); s.elifs.forEach((el) => { walkExpr(el.cond); el.body.forEach(walkStmt); }); s.else?.forEach(walkStmt); break;
      case 'Switch': if (s.subject) walkExpr(s.subject); s.cases.forEach((c) => { if (c.test) walkExpr(c.test); c.body.forEach(walkStmt); }); break;
      case 'While': walkExpr(s.cond); s.body.forEach(walkStmt); break;
    }
  };
  const walkExpr = (e: Expr): void => {
    switch (e.kind) {
      case 'If': case 'Switch': case 'For': case 'ForIn': case 'While': walkStmt(e as unknown as Stmt); break;
      case 'Call': e.args.forEach((a) => walkExpr(a.value)); walkExpr(e.callee); break;
      case 'Member': walkExpr(e.object); break;
      case 'History': walkExpr(e.base); walkExpr(e.offset); break;
      case 'Unary': walkExpr(e.operand); break;
      case 'Binary': walkExpr(e.left); walkExpr(e.right); break;
      case 'Ternary': walkExpr(e.cond); walkExpr(e.then); walkExpr(e.else); break;
      case 'Tuple': e.items.forEach(walkExpr); break;
      default: break;
    }
  };
  body.forEach(walkStmt);
  return names;
}

/**
 * Rewrites `alias.*` references (and, for a library's own body, self-references and
 * imported-method dispatch) to the mangled merged names. Mutates the AST in place;
 * callers pass freshly-parsed (consumer) or freshly-cloned (library) nodes.
 */
export class RefRewriter {
  private readonly aliases: Map<string, LibraryIdentity>;
  private readonly graph: Map<string, ResolvedLibrary>;
  private readonly self?: RewriteOptions['self'];
  private readonly emit: (d: Diagnostic) => void;
  /** Variable/param name → the resolved UDT type it holds (for method dispatch). */
  private typeEnv = new Map<string, UdtOrigin>();
  /** Names bound locally in the function currently being rewritten (shadow self names). */
  private localNames: Set<string> | null = null;

  constructor(opts: RewriteOptions) {
    this.aliases = opts.aliases;
    this.graph = opts.graph;
    this.self = opts.self;
    this.emit = opts.emit;
  }

  private lib(id: LibraryIdentity): ResolvedLibrary | undefined {
    return this.graph.get(id.canonical);
  }

  /** Determine the resolved-UDT origin of a `{kind:'udt'}` type name, else undefined. */
  private typeOrigin(name: string): UdtOrigin | undefined {
    const dot = name.indexOf('.');
    if (dot !== -1) {
      const alias = name.slice(0, dot);
      const local = name.slice(dot + 1);
      const id = this.aliases.get(alias);
      return id ? { identity: id, typeName: local } : undefined;
    }
    if (this.self && this.self.names.has(name)) return { identity: this.self.identity, typeName: name };
    return undefined;
  }

  /** The UDT origin produced by a `X.new(...)`/`alias.T.new(...)` constructor call. */
  private constructorOrigin(e: Expr): UdtOrigin | undefined {
    if (e.kind !== 'Call' || e.callee.kind !== 'Member' || e.callee.property !== 'new') return undefined;
    const recv = e.callee.object;
    if (recv.kind === 'Ident') return this.typeOrigin(recv.name);
    if (recv.kind === 'Member' && recv.object.kind === 'Ident' && this.aliases.has(recv.object.name)) {
      return { identity: this.aliases.get(recv.object.name)!, typeName: recv.property };
    }
    return undefined;
  }

  /** Report a bound-alias symbol error with private > unresolved precedence (Req 4.5, 4.4, 4.7). */
  private symbolError(alias: string, lib: ResolvedLibrary, name: string, loc?: Loc): void {
    if (lib.allNames.has(name) || lib.allMethods.has(name)) {
      this.emit(mkDiag(`'${alias}.${name}' is declared in library ${lib.identity.canonical} but not exported`, loc, this.self?.identity, this.self?.chain));
    } else {
      this.emit(mkDiag(`library ${lib.identity.canonical} (alias '${alias}') exports no symbol named '${name}'`, loc, this.self?.identity, this.self?.chain));
    }
  }

  // ── type rewriting ──────────────────────────────────────
  private rewriteType(t?: PineType): PineType | undefined {
    if (!t) return t;
    switch (t.kind) {
      case 'udt': {
        const o = this.typeOrigin(t.name);
        return o ? { kind: 'udt', name: mangle(o.identity, o.typeName) } : t;
      }
      case 'array': return { kind: 'array', of: this.rewriteType(t.of)! };
      case 'matrix': return { kind: 'matrix', of: this.rewriteType(t.of)! };
      case 'map': return { kind: 'map', key: this.rewriteType(t.key)!, value: this.rewriteType(t.value)! };
      default: return t;
    }
  }

  // ── entry points ────────────────────────────────────────
  /** Rewrite an in-place list of top-level statements (the consumer body). */
  rewriteBody(body: Stmt[]): void {
    for (const s of body) this.stmt(s);
  }

  /** Rewrite one cloned top-level library declaration AND mangle its own name. */
  rewriteAndMangleDecl(s: Stmt): void {
    this.stmt(s);
    if ((s.kind === 'FuncDef' || s.kind === 'TypeDef' || s.kind === 'VarDecl') && this.self) {
      s.name = mangle(this.self.identity, s.name);
    }
  }

  // ── statements ──────────────────────────────────────────
  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': {
        this.recordVarType(s);
        s.declType = this.rewriteType(s.declType);
        s.init = this.expr(s.init);
        break;
      }
      case 'TupleDecl':
        s.init = this.expr(s.init);
        break;
      case 'Reassign': {
        if (s.target.kind === 'Ident') {
          const o = this.constructorOrigin(s.value);
          if (o) this.typeEnv.set(s.target.name, o);
        } else {
          s.target = this.expr(s.target) as Member;
        }
        s.value = this.expr(s.value);
        break;
      }
      case 'ExprStmt':
        s.expr = this.expr(s.expr);
        break;
      case 'FuncDef': {
        // Record UDT-typed params so `param.method(...)` dispatches inside the body
        // (read the ORIGINAL declType, before rewriteType mangles it).
        for (const p of s.params) {
          if (p.declType?.kind === 'udt') {
            const o = this.typeOrigin(p.declType.name);
            if (o) this.typeEnv.set(p.name, o);
          }
        }
        // Rewrite param types + defaults in the ENCLOSING scope (a default may
        // reference an outer/global symbol, not the function's own locals).
        for (const p of s.params) {
          p.declType = this.rewriteType(p.declType);
          if (p.default) p.default = this.expr(p.default);
        }
        // Enter the function scope: its params + locals shadow module-level self names.
        const savedLocals = this.localNames;
        this.localNames = collectBindingNames(s.params.map((p) => p.name), s.body);
        for (const b of s.body) this.stmt(b);
        this.localNames = savedLocals;
        break;
      }
      case 'TypeDef':
        for (const f of s.fields) {
          f.declType = this.rewriteType(f.declType);
          if (f.default) f.default = this.expr(f.default);
        }
        break;
      case 'If':
        s.cond = this.expr(s.cond);
        for (const b of s.then) this.stmt(b);
        for (const el of s.elifs) { el.cond = this.expr(el.cond); for (const b of el.body) this.stmt(b); }
        if (s.else) for (const b of s.else) this.stmt(b);
        break;
      case 'Switch':
        if (s.subject) s.subject = this.expr(s.subject);
        for (const c of s.cases) { if (c.test) c.test = this.expr(c.test); for (const b of c.body) this.stmt(b); }
        break;
      case 'For':
        s.from = this.expr(s.from); s.to = this.expr(s.to); if (s.step) s.step = this.expr(s.step);
        for (const b of s.body) this.stmt(b);
        break;
      case 'ForIn':
        s.iterable = this.expr(s.iterable);
        for (const b of s.body) this.stmt(b);
        break;
      case 'While':
        s.cond = this.expr(s.cond);
        for (const b of s.body) this.stmt(b);
        break;
      // Import/Break/Continue: leaves.
    }
  }

  private recordVarType(s: VarDecl): void {
    let o: UdtOrigin | undefined;
    if (s.declType?.kind === 'udt') o = this.typeOrigin(s.declType.name);
    if (!o) o = this.constructorOrigin(s.init);
    if (o) this.typeEnv.set(s.name, o);
  }

  // ── expressions ─────────────────────────────────────────
  private expr(e: Expr): Expr {
    switch (e.kind) {
      case 'Call': return this.call(e);
      case 'Member': return this.member(e);
      case 'Ident': return this.ident(e);
      case 'History': e.base = this.expr(e.base); e.offset = this.expr(e.offset); return e;
      case 'Unary': e.operand = this.expr(e.operand); return e;
      case 'Binary': e.left = this.expr(e.left); e.right = this.expr(e.right); return e;
      case 'Ternary': e.cond = this.expr(e.cond); e.then = this.expr(e.then); e.else = this.expr(e.else); return e;
      case 'Tuple': e.items = e.items.map((it) => this.expr(it)); return e;
      case 'If': case 'Switch': case 'For': case 'ForIn': case 'While':
        this.stmt(e as unknown as Stmt); return e;
      default: return e; // literals
    }
  }

  private ident(e: Ident): Expr {
    // A locally-bound name (param/local) shadows a module-level declaration.
    if (this.localNames?.has(e.name)) return e;
    // Intra-library: a bare reference to a sibling declaration is self-mangled.
    if (this.self && this.self.names.has(e.name)) e.name = mangle(this.self.identity, e.name);
    return e;
  }

  private call(e: Call): Expr {
    const callee = e.callee;
    // alias.fn(...) / alias.method(recv, ...)
    if (callee.kind === 'Member' && callee.object.kind === 'Ident' && this.aliases.has(callee.object.name)) {
      const alias = callee.object.name;
      const id = this.aliases.get(alias)!;
      const lib = this.lib(id)!;
      const name = callee.property;
      if (lib.surface.functions.has(name) || lib.surface.methods.has(name)) {
        e.callee = { kind: 'Ident', name: mangle(id, name), loc: callee.loc };
      } else {
        this.symbolError(alias, lib, name, callee.loc);
      }
      this.rewriteArgs(e);
      return e;
    }
    // alias.Type.new(...)
    if (callee.kind === 'Member' && callee.property === 'new'
      && callee.object.kind === 'Member' && callee.object.object.kind === 'Ident'
      && this.aliases.has(callee.object.object.name)) {
      const alias = callee.object.object.name;
      const id = this.aliases.get(alias)!;
      const lib = this.lib(id)!;
      const typeName = callee.object.property;
      if (lib.surface.types.has(typeName)) {
        callee.object = { kind: 'Ident', name: mangle(id, typeName), loc: callee.object.loc };
      } else {
        this.symbolError(alias, lib, typeName, callee.object.loc);
      }
      this.rewriteArgs(e);
      return e;
    }
    // self SelfType.new(...) — intra-library constructor (unless the name is locally shadowed).
    if (this.self && callee.kind === 'Member' && callee.property === 'new'
      && callee.object.kind === 'Ident' && this.self.names.has(callee.object.name)
      && !this.localNames?.has(callee.object.name)) {
      callee.object = { kind: 'Ident', name: mangle(this.self.identity, callee.object.name), loc: callee.object.loc };
      this.rewriteArgs(e);
      return e;
    }
    // default: rewrite callee + args, then attempt receiver-dispatched method call.
    e.callee = this.expr(callee);
    this.rewriteArgs(e);
    this.methodDispatch(e);
    return e;
  }

  private rewriteArgs(e: Call): void {
    for (const a of e.args) a.value = this.expr(a.value);
    if (e.typeArgs) e.typeArgs = e.typeArgs.map((t) => this.rewriteType(t)!);
  }

  /** `recv.method(args)` on a value of a resolved UDT type → direct mangled call (Req 4.3, 4.8). */
  private methodDispatch(e: Call): void {
    const callee = e.callee;
    if (callee.kind !== 'Member' || callee.object.kind !== 'Ident') return;
    const origin = this.typeEnv.get(callee.object.name);
    if (!origin) return;
    const owner = this.lib(origin.identity);
    if (!owner) return;
    const method = callee.property;
    // Own methods (all) inside their own library; exported methods when imported.
    const pool = this.self && origin.identity.canonical === this.self.identity.canonical
      ? this.self.methods
      : owner.surface.methods;
    const all = pool.get(method);
    if (!all) return; // not a library method — leave for builtin/other dispatch
    const arity = e.args.length + 1; // + receiver
    const matches = all.filter((m) => m.receiverType === origin.typeName && m.arity === arity);
    if (matches.length === 1) {
      e.callee = { kind: 'Ident', name: mangle(origin.identity, method), loc: callee.loc };
      e.args = [{ value: callee.object }, ...e.args];
    } else if (matches.length === 0) {
      this.emit(mkDiag(
        `no method '${method}' matching receiver type '${origin.typeName}' with ${e.args.length} argument(s) in library ${owner.identity.canonical}`,
        callee.loc, this.self?.identity, this.self?.chain));
    } else {
      this.emit(mkDiag(
        `ambiguous method '${method}' on receiver type '${origin.typeName}': ${matches.length} matching overloads in library ${owner.identity.canonical}`,
        callee.loc, this.self?.identity, this.self?.chain));
    }
  }

  private member(e: Member): Expr {
    // alias.EnumType.Member  (bare access, compile-time enum constant)
    if (e.object.kind === 'Member' && e.object.object.kind === 'Ident'
      && this.aliases.has(e.object.object.name)) {
      const alias = e.object.object.name;
      const id = this.aliases.get(alias)!;
      const lib = this.lib(id)!;
      const enumName = e.object.property;
      const enumDef = lib.surface.enums.get(enumName);
      if (enumDef) {
        if (!enumDef.fields.some((f) => f.name === e.property)) {
          this.emit(mkDiag(`enum '${alias}.${enumName}' has no member '${e.property}'`, e.loc, this.self?.identity, this.self?.chain));
        }
        e.object = { kind: 'Ident', name: mangle(id, enumName), loc: e.object.loc };
        return e;
      }
      // not an enum — fall through to recurse (e.g. field access on `alias.fn(...).x`)
    }
    // alias.name  (single member: bare type/enum ref, or a private/unresolved symbol)
    if (e.object.kind === 'Ident' && this.aliases.has(e.object.name)) {
      const alias = e.object.name;
      const id = this.aliases.get(alias)!;
      const lib = this.lib(id)!;
      const name = e.property;
      if (lib.surface.types.has(name) || lib.surface.enums.has(name)) {
        return { kind: 'Ident', name: mangle(id, name), loc: e.loc };
      }
      // Exported constant/variable referenced as a value (`alias.NAME`).
      if (lib.surface.constants.has(name)) {
        return { kind: 'Ident', name: mangle(id, name), loc: e.loc };
      }
      this.symbolError(alias, lib, name, e.loc);
      return e;
    }
    // self SelfEnum.Member (bare enum access inside its own library, unless locally shadowed)
    if (this.self && e.object.kind === 'Ident' && this.self.names.has(e.object.name)
      && !this.localNames?.has(e.object.name)) {
      e.object = { kind: 'Ident', name: mangle(this.self.identity, e.object.name), loc: e.object.loc };
      return e;
    }
    e.object = this.expr(e.object);
    return e;
  }
}

// ───────────────────────── Symbol merge (Req 5, 6, 8.6) ─────────────────────────

const clone = <T>(node: T): T => structuredClone(node);

/**
 * Produce the mangled, merged top-level declarations for every resolved library,
 * honoring per-library import scoping (Req 8.6). Each library's exported AND
 * reachable-private FuncDef/TypeDef/VarDecl is deep-cloned, its intra-library
 * references rewritten to mangled names, and its own name mangled. The result is
 * prepended to the Consumer_Script body; the downstream inliner then inlines every
 * call (local, imported, transitive) uniformly.
 */
export function mergeLibraries(graph: ResolvedGraph): { decls: Stmt[]; diagnostics: Diagnostic[] } {
  const decls: Stmt[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const lib of graph.libraries.values()) {
    const rewriter = new RefRewriter({
      aliases: lib.imports,
      graph: graph.libraries,
      self: { identity: lib.identity, names: lib.allNames, methods: lib.allMethods, chain: lib.chain },
      emit: (d) => diagnostics.push(d),
    });
    for (const s of lib.program.body) {
      if (s.kind !== 'FuncDef' && s.kind !== 'TypeDef' && s.kind !== 'VarDecl') continue;
      const cloned = clone(s);
      rewriter.rewriteAndMangleDecl(cloned);
      decls.push(cloned);
    }
  }
  return { decls, diagnostics };
}

// ───────────────────────── Export constraints (Req 7) ─────────────────────────

/** Global-only side-effecting builtins forbidden inside exports (OUTPUT_FNS ∪ alertcondition). */
const FORBIDDEN_IN_EXPORT = new Set<string>([...OUTPUT_FNS, 'alertcondition']);
const DECL_CALLS = new Set(['indicator', 'strategy', 'library']);

/**
 * Collect ALL export-constraint violations in a library (Req 7.1, 7.2, 7.4, 7.5):
 * an exported function may not, directly or transitively through a private symbol
 * it calls, invoke a global-only side-effecting builtin or an
 * indicator/strategy/library declaration.
 */
export function checkExportConstraints(lib: ResolvedLibrary): Diagnostic[] {
  const diags: Diagnostic[] = [];
  // Index this library's own functions (exported + private) by name.
  const funcs = new Map<string, FuncDef>();
  for (const s of lib.program.body) if (s.kind === 'FuncDef') funcs.set(s.name, s);

  for (const s of lib.program.body) {
    if (s.kind !== 'FuncDef' || !s.export) continue;
    walkFn(s, s.name);
  }

  function walkFn(fn: FuncDef, exportedName: string, visiting = new Set<string>()): void {
    if (visiting.has(fn.name)) return; // guard the private-call graph against cycles
    visiting.add(fn.name);
    for (const st of fn.body) walkStmt(st, exportedName, visiting);
    visiting.delete(fn.name);
  }

  function walkStmt(s: Stmt, exportedName: string, visiting: Set<string>): void {
    switch (s.kind) {
      case 'VarDecl': walkExpr(s.init, exportedName, visiting); break;
      case 'TupleDecl': walkExpr(s.init, exportedName, visiting); break;
      case 'Reassign': walkExpr(s.value, exportedName, visiting); break;
      case 'ExprStmt': walkExpr(s.expr, exportedName, visiting); break;
      case 'If':
        walkExpr(s.cond, exportedName, visiting);
        s.then.forEach((b) => walkStmt(b, exportedName, visiting));
        s.elifs.forEach((el) => { walkExpr(el.cond, exportedName, visiting); el.body.forEach((b) => walkStmt(b, exportedName, visiting)); });
        s.else?.forEach((b) => walkStmt(b, exportedName, visiting));
        break;
      case 'Switch':
        if (s.subject) walkExpr(s.subject, exportedName, visiting);
        s.cases.forEach((c) => { if (c.test) walkExpr(c.test, exportedName, visiting); c.body.forEach((b) => walkStmt(b, exportedName, visiting)); });
        break;
      case 'For': walkExpr(s.from, exportedName, visiting); walkExpr(s.to, exportedName, visiting); if (s.step) walkExpr(s.step, exportedName, visiting); s.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
      case 'ForIn': walkExpr(s.iterable, exportedName, visiting); s.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
      case 'While': walkExpr(s.cond, exportedName, visiting); s.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
    }
  }

  function walkExpr(e: Expr, exportedName: string, visiting: Set<string>): void {
    switch (e.kind) {
      case 'Call': {
        const callee = e.callee;
        if (callee.kind === 'Ident') {
          const name = callee.name;
          if (FORBIDDEN_IN_EXPORT.has(name)) {
            diags.push(mkDiag(
              `exported '${exportedName}' calls the global-only builtin '${name}', which is not allowed inside a library export`,
              e.loc, lib.identity, lib.chain));
          } else if (DECL_CALLS.has(name)) {
            diags.push(mkDiag(
              `exported '${exportedName}' contains an '${name}(...)' declaration call, which is not allowed inside a library export`,
              e.loc, lib.identity, lib.chain));
          } else if (funcs.has(name)) {
            walkFn(funcs.get(name)!, exportedName, visiting); // transitive through a private/sibling fn
          }
        }
        e.args.forEach((a) => walkExpr(a.value, exportedName, visiting));
        break;
      }
      case 'Member': walkExpr(e.object, exportedName, visiting); break;
      case 'History': walkExpr(e.base, exportedName, visiting); walkExpr(e.offset, exportedName, visiting); break;
      case 'Unary': walkExpr(e.operand, exportedName, visiting); break;
      case 'Binary': walkExpr(e.left, exportedName, visiting); walkExpr(e.right, exportedName, visiting); break;
      case 'Ternary': walkExpr(e.cond, exportedName, visiting); walkExpr(e.then, exportedName, visiting); walkExpr(e.else, exportedName, visiting); break;
      case 'Tuple': e.items.forEach((it) => walkExpr(it, exportedName, visiting)); break;
      case 'If':
        walkExpr(e.cond, exportedName, visiting);
        e.then.forEach((b) => walkStmt(b, exportedName, visiting));
        e.elifs.forEach((el) => { walkExpr(el.cond, exportedName, visiting); el.body.forEach((b) => walkStmt(b, exportedName, visiting)); });
        e.else?.forEach((b) => walkStmt(b, exportedName, visiting));
        break;
      case 'Switch':
        if (e.subject) walkExpr(e.subject, exportedName, visiting);
        e.cases.forEach((c) => { if (c.test) walkExpr(c.test, exportedName, visiting); c.body.forEach((b) => walkStmt(b, exportedName, visiting)); });
        break;
      case 'For': walkExpr(e.from, exportedName, visiting); walkExpr(e.to, exportedName, visiting); if (e.step) walkExpr(e.step, exportedName, visiting); e.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
      case 'ForIn': walkExpr(e.iterable, exportedName, visiting); e.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
      case 'While': walkExpr(e.cond, exportedName, visiting); e.body.forEach((b) => walkStmt(b, exportedName, visiting)); break;
    }
  }

  return diags;
}

// Re-exported for downstream modules that build on this file.
export { OUTPUT_FNS, ParseError, parse, tokenize };
export type { Diagnostic, Program, Stmt, Expr, FuncDef, TypeDef, ImportStmt, Call, Arg };
