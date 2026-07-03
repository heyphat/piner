/**
 * Top-level compiler: Pine v6 source → CompiledScript.
 * lexer → parser → semantic analysis + slot allocation → codegen (+ interpreter).
 */
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { inlineUserFunctions } from '../sema/inline.js';
import {
  analyze,
  CompileError,
  type Diagnostic,
  type InputDecl,
  type SecurityDependency,
} from '../sema/analyze.js';
import {
  indexRegistry,
  LibraryResolver,
  mergeLibraries,
  checkExportConstraints,
  classifyDeclaration,
  type CompileOptions,
} from '../sema/library.js';
import { AliasResolver } from '../sema/alias.js';
import { resolveLibraryClosure, type AsyncLibrarySource } from '../sema/resolve.js';
import { emit } from '../codegen/emit.js';
import { makeInterpreted } from '../interp/interpreter.js';
import type { Program, Call, Expr, ImportStmt } from '../parser/ast.js';
import type { ScriptFn } from './driver.js';
import type { StrategySettings } from '../runtime/builtins/strategy.js';

export interface ScriptMetadata {
  title: string;
  overlay: boolean;
  isStrategy: boolean;
  /** Strategy broker settings parsed from the `strategy(...)` declaration. */
  strategy?: Partial<StrategySettings>;
  /** Number of history columns the runtime must declare (includes 6 builtin slots). */
  historySlotCount: number;
  stateSiteCount: number;
  varSlotCount: number;
  /** `input.*` settings schema (title/type/default/min/max/options), in order. */
  inputs: InputDecl[];
  /** Best-effort static request.security[_lower_tf] dependencies (one per call site).
   *  A host can read these after `compile()` (no run needed) to plan cross-symbol /
   *  lower-TF data fetches; entries with `dynamic: true` need a run to resolve. */
  securityDependencies: SecurityDependency[];
  /** Drawing-object caps from indicator()/strategy() (Pine defaults: lines/labels/boxes = 50,
   *  polylines = 100). Consumers FIFO-trim each drawing type to these limits. */
  maxLinesCount: number;
  maxLabelsCount: number;
  maxBoxesCount: number;
  maxPolylinesCount: number;
}

export interface CompiledScript {
  /** Codegen backend (fast path). */
  main: ScriptFn;
  /** Interpreter backend (oracle) over the same `$` API. */
  interpret: ScriptFn;
  /** Generated JavaScript source for `main` (inspectable for debugging). */
  source: string;
  metadata: ScriptMetadata;
  diagnostics: Diagnostic[];
}

// `CompileError` now lives in `../sema/analyze.js` (the home of `Diagnostic`) so
// the library/alias modules can throw it without importing this file. Re-exported
// here to keep the public API (`import { CompileError } from '@heyphat/piner'`)
// and every existing call site unchanged.
export { CompileError } from '../sema/analyze.js';

/**
 * Compile Pine v6 source to a {@link CompiledScript}.
 *
 * @param source   the Pine source.
 * @param options  optional {@link CompileOptions}; supply `libraries` to resolve
 *                 `import` statements from an in-memory registry (no network/FS).
 *
 * Backward compatible for import-free scripts: `compile(source)` on a script with no
 * `import` statements takes the exact existing pipeline path and produces byte-identical
 * output (Req 2.4).
 *
 * BREAKING (since library import/export support): a script that CONTAINS `import`
 * statements now resolves them. Every imported library must be present in `options.libraries`
 * (or fetched via {@link compileAsync}'s provider); an unresolved import is a `CompileError`
 * rather than being silently ignored as before. Likewise, a script with more than one
 * top-level `indicator`/`strategy`/`library` declaration is now a `CompileError` (Req 1.5),
 * matching TradingView; previously the extra declarations were ignored.
 */
export function compile(source: string, options?: CompileOptions): CompiledScript {
  const lex = tokenize(source);
  const program = parse(lex);

  // Req 1: validate the consumer's top-level declaration (conflicting declarations;
  // and, if it is itself a library, its title). Throws CompileError on violation.
  classifyDeclaration(program);

  const consumerImports = program.body.filter((s): s is ImportStmt => s.kind === 'Import');

  // Resolve + merge imported libraries when a registry is supplied OR the script
  // has imports. Otherwise take the untouched fast path (Req 2.4).
  let toCompile = program;
  if (options?.libraries !== undefined || consumerImports.length > 0) {
    const registry = indexRegistry(options?.libraries ?? []);
    const graph = new LibraryResolver(registry).resolve(consumerImports);

    // Req 7: enforce export constraints across ALL libraries; report every violation.
    const constraintDiags: Diagnostic[] = [];
    for (const lib of graph.libraries.values())
      constraintDiags.push(...checkExportConstraints(lib));
    throwIfErrors(constraintDiags);

    // Req 3/4: bind consumer aliases + rewrite `alias.*` references in place.
    const { diagnostics: aliasDiags } = new AliasResolver(graph).bindAndRewrite(program);
    // Req 5/8.6: mangle + merge every library's declarations.
    const { decls, diagnostics: mergeDiags } = mergeLibraries(graph);
    throwIfErrors([...aliasDiags, ...mergeDiags]);

    toCompile = { ...program, body: [...decls, ...program.body] };
  }

  // Inline user-defined (and now merged imported) function calls before analysis.
  const inlined = inlineUserFunctions(toCompile);
  const analysis = analyze(inlined.program);
  const diagnostics = [...inlined.diagnostics, ...analysis.diagnostics];

  throwIfErrors(diagnostics);

  const { source: jsSource, main } = emit(analysis);
  const interpret = makeInterpreted(analysis);

  return {
    main,
    interpret,
    source: jsSource,
    metadata: {
      // Metadata is always the Consumer_Script's (merged library decls carry none).
      ...extractMetadata(program),
      historySlotCount: analysis.historySlotCount,
      stateSiteCount: analysis.stateSiteCount,
      varSlotCount: analysis.varSlotCount,
      inputs: analysis.inputs,
      securityDependencies: analysis.securityDependencies,
    },
    diagnostics,
  };
}

/** Options for {@link compileAsync}: {@link CompileOptions} plus an async source provider. */
export interface CompileAsyncOptions extends CompileOptions {
  /**
   * Lazily provides Pine source for an imported library identity (HTTP, filesystem, DB, …).
   * The transitive closure reachable from the script's imports is fetched via this provider
   * (only imported libraries are fetched), then handed to the synchronous {@link compile}.
   * Any `libraries` supplied are used as already-in-hand seeds before the provider is called.
   */
  resolveLibrary?: AsyncLibrarySource;
}

/**
 * Async variant of {@link compile} that resolves imports through an async/lazy provider.
 *
 * `compile()` itself stays pure and synchronous; this wrapper simply gathers the needed
 * library sources first (via {@link resolveLibraryClosure}) and then calls `compile()`. With
 * no `resolveLibrary`, it is exactly `compile(source, options)`.
 */
export async function compileAsync(
  source: string,
  options: CompileAsyncOptions = {},
): Promise<CompiledScript> {
  const { resolveLibrary, ...rest } = options;
  if (!resolveLibrary) return compile(source, rest);
  const libraries = await resolveLibraryClosure(source, resolveLibrary, { seed: rest.libraries });
  return compile(source, { ...rest, libraries });
}

/** Throw a {@link CompileError} if any diagnostic is an error, preserving attribution. */
function throwIfErrors(diagnostics: Diagnostic[]): void {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (!errors.length) return;
  const summary = errors
    .map((d) => {
      const where = d.library ? ` [${d.library.canonical}]` : '';
      return `  ${d.line}:${d.col}${where} ${d.message}`;
    })
    .join('\n');
  throw new CompileError(`Pine compile failed:\n${summary}`, diagnostics);
}

function extractMetadata(
  program: Program,
): Pick<
  ScriptMetadata,
  | 'title'
  | 'overlay'
  | 'isStrategy'
  | 'strategy'
  | 'maxLinesCount'
  | 'maxLabelsCount'
  | 'maxBoxesCount'
  | 'maxPolylinesCount'
> {
  let title = '';
  let overlay = false;
  let isStrategy = false;
  let strategy: Partial<StrategySettings> | undefined;
  // Pine defaults for the drawing-object caps.
  let maxLinesCount = 50,
    maxLabelsCount = 50,
    maxBoxesCount = 50,
    maxPolylinesCount = 100;
  for (const s of program.body) {
    if (s.kind !== 'ExprStmt' || s.expr.kind !== 'Call') continue;
    const call = s.expr as Call;
    const callee = call.callee;
    const name = callee.kind === 'Ident' ? callee.name : undefined;
    if (name !== 'indicator' && name !== 'strategy' && name !== 'library') continue;
    isStrategy = name === 'strategy';
    const titleArg = call.args.find((a) => a.name === 'title') ?? call.args.find((a) => !a.name);
    if (titleArg?.value.kind === 'String') title = titleArg.value.value;
    const overlayArg = call.args.find((a) => a.name === 'overlay');
    if (overlayArg?.value.kind === 'Bool') overlay = overlayArg.value.value;
    const cap = (n: string, def: number): number => {
      const v = numLit(call.args.find((a) => a.name === n)?.value);
      return v !== undefined && v > 0 ? Math.trunc(v) : def;
    };
    maxLinesCount = cap('max_lines_count', 50);
    maxLabelsCount = cap('max_labels_count', 50);
    maxBoxesCount = cap('max_boxes_count', 50);
    maxPolylinesCount = cap('max_polylines_count', 100);
    if (isStrategy) strategy = extractStrategySettings(call);
    break;
  }
  return {
    title,
    overlay,
    isStrategy,
    strategy,
    maxLinesCount,
    maxLabelsCount,
    maxBoxesCount,
    maxPolylinesCount,
  };
}

/** Parse the broker-relevant named args of a `strategy(...)` declaration. */
function extractStrategySettings(call: Call): Partial<StrategySettings> {
  const s: Partial<StrategySettings> = {};
  const num = (n: string): number | undefined => {
    const v = call.args.find((a) => a.name === n)?.value;
    return numLit(v);
  };
  /** Leaf property of a `strategy.foo`/`strategy.bar.baz` enum member arg. */
  const enumLeaf = (n: string): string | undefined => {
    const v = call.args.find((a) => a.name === n)?.value;
    return v?.kind === 'Member' ? v.property : undefined;
  };
  const initialCapital = num('initial_capital');
  if (initialCapital !== undefined) s.initialCapital = initialCapital;
  const qtyValue = num('default_qty_value');
  if (qtyValue !== undefined) s.qtyValue = qtyValue;
  const qtyType = enumLeaf('default_qty_type');
  if (qtyType === 'fixed' || qtyType === 'cash' || qtyType === 'percent_of_equity')
    s.qtyType = qtyType;
  const commissionValue = num('commission_value');
  if (commissionValue !== undefined) s.commissionValue = commissionValue;
  const commissionType = enumLeaf('commission_type');
  if (
    commissionType === 'percent' ||
    commissionType === 'cash_per_contract' ||
    commissionType === 'cash_per_order'
  ) {
    s.commissionType = commissionType;
  }
  const pyramiding = num('pyramiding');
  if (pyramiding !== undefined) s.pyramiding = pyramiding;
  const slippage = num('slippage');
  if (slippage !== undefined) s.slippage = slippage;
  const poc = call.args.find((a) => a.name === 'process_orders_on_close')?.value;
  if (poc?.kind === 'Bool') s.processOrdersOnClose = poc.value;
  return s;
}

/** Numeric literal value, allowing a leading unary minus. */
function numLit(v: Expr | undefined): number | undefined {
  if (v?.kind === 'Number') return v.value;
  if (v?.kind === 'Unary' && v.op === '-' && v.operand.kind === 'Number') return -v.operand.value;
  return undefined;
}
