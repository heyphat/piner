/**
 * Top-level compiler: Pine v6 source → CompiledScript.
 * lexer → parser → semantic analysis + slot allocation → codegen (+ interpreter).
 */
import { tokenize } from '../lexer/lexer.js';
import { parse } from '../parser/parser.js';
import { inlineUserFunctions } from '../sema/inline.js';
import { analyze, type Diagnostic, type InputDecl } from '../sema/analyze.js';
import { emit } from '../codegen/emit.js';
import { makeInterpreted } from '../interp/interpreter.js';
import type { Program, Call, Expr } from '../parser/ast.js';
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

export class CompileError extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'CompileError';
  }
}

export function compile(source: string): CompiledScript {
  const lex = tokenize(source);
  const program = parse(lex);
  // Inline user-defined function calls before analysis (monomorphization).
  const inlined = inlineUserFunctions(program);
  const analysis = analyze(inlined.program);
  const diagnostics = [...inlined.diagnostics, ...analysis.diagnostics];

  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    const summary = errors.map((d) => `  ${d.line}:${d.col} ${d.message}`).join('\n');
    throw new CompileError(`Pine compile failed:\n${summary}`, diagnostics);
  }

  const { source: jsSource, main } = emit(analysis);
  const interpret = makeInterpreted(analysis);

  return {
    main,
    interpret,
    source: jsSource,
    metadata: {
      ...extractMetadata(program),
      historySlotCount: analysis.historySlotCount,
      stateSiteCount: analysis.stateSiteCount,
      varSlotCount: analysis.varSlotCount,
      inputs: analysis.inputs,
    },
    diagnostics,
  };
}

function extractMetadata(program: Program): Pick<ScriptMetadata, 'title' | 'overlay' | 'isStrategy' | 'strategy' | 'maxLinesCount' | 'maxLabelsCount' | 'maxBoxesCount' | 'maxPolylinesCount'> {
  let title = '';
  let overlay = false;
  let isStrategy = false;
  let strategy: Partial<StrategySettings> | undefined;
  // Pine defaults for the drawing-object caps.
  let maxLinesCount = 50, maxLabelsCount = 50, maxBoxesCount = 50, maxPolylinesCount = 100;
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
  return { title, overlay, isStrategy, strategy, maxLinesCount, maxLabelsCount, maxBoxesCount, maxPolylinesCount };
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
  if (qtyType === 'fixed' || qtyType === 'cash' || qtyType === 'percent_of_equity') s.qtyType = qtyType;
  const commissionValue = num('commission_value');
  if (commissionValue !== undefined) s.commissionValue = commissionValue;
  const commissionType = enumLeaf('commission_type');
  if (commissionType === 'percent' || commissionType === 'cash_per_contract' || commissionType === 'cash_per_order') {
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
