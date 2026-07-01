/**
 * Semantic analysis + slot allocation (Phase 4; docs/compiler-design.md §4–§5).
 *
 * One pass over the AST that: resolves names to SymRefs, assigns var/varip slots,
 * lazily assigns a history slot when a symbol/builtin is `[]`-referenced, assigns
 * a state-site id to each stateful builtin call, infers a coarse value type (for
 * the `+` vs string-concat decision and the `== na` lint), and records
 * diagnostics. Annotations are written in place on the nodes (the contract in
 * §1.2); both backends read them.
 */
import type {
  Program, Stmt, Expr, SymRef, VarSlot, TypeField,
} from '../parser/ast.js';
// Type-only (erased at runtime) — avoids a runtime import cycle with library.ts,
// which imports CompileError/OUTPUT_FNS from this module.
import type { LibraryIdentity } from './library.js';
import { SlotAllocator } from './slots.js';
import type { PineType } from './types.js';
import { TA_VARS } from '../codegen/intrinsics.js';
import { ColorNs } from '../runtime/builtins/color.js';
import {
  SizeNs, TextNs, FontNs, ShapeNs, LocationNs, PositionNs, XlocNs, ExtendNs,
  FormatNs, CurrencyNs, BarmergeNs, SessionNs, ScaleNs, OrderNs, YlocNs,
  DisplayNs, HlineNs, PlotNs, DayofweekNs,
} from '../runtime/builtins/constants.js';

/**
 * Namespace-constant tables keyed by the name used in scripts, so input metadata can
 * resolve `size.tiny`, `text.align_right`, … to their string/number/bool tags — the
 * same values the runtime carries. `color.*` is handled separately by constColorValue.
 */
const NS_CONST: Record<string, Record<string, string | number | boolean>> = {
  size: SizeNs, text: TextNs, font: FontNs, shape: ShapeNs, location: LocationNs,
  position: PositionNs, xloc: XlocNs, extend: ExtendNs, format: FormatNs,
  currency: CurrencyNs, barmerge: BarmergeNs, session: SessionNs, scale: ScaleNs,
  order: OrderNs, yloc: YlocNs, display: DisplayNs, hline: HlineNs, plot: PlotNs,
  dayofweek: DayofweekNs,
};

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  col: number;
  /** Set when the diagnostic originates inside an imported library (Req 9.3). */
  library?: LibraryIdentity;
  /** Ordered chain Consumer → … → originating library (Req 9.4). */
  importChain?: LibraryIdentity[];
}

/**
 * The error piner throws for semantic (and library-resolution) failures. Carries
 * the structured diagnostics. Defined here — the home of {@link Diagnostic} — so
 * `library.ts`/`alias.ts` can throw it without importing `compiler.ts` (which
 * imports them, which would form a cycle). Re-exported from `compiler.ts` and the
 * package index, so the public API is unchanged.
 */
export class CompileError extends Error {
  constructor(message: string, readonly diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'CompileError';
  }
}

/** A discovered `input.*` declaration — the settings-panel schema for one input. */
export interface InputDecl {
  /** Override key: the input's title, else an auto id `input_<n>`. */
  key: string;
  kind: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source' | 'price' | 'timeframe'
      | 'symbol' | 'session' | 'time' | 'text_area' | 'enum';
  title?: string;
  default: number | boolean | string | null;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: (string | number)[];
  group?: string;
  tooltip?: string;
}

export interface AnalyzeResult {
  program: Program;
  diagnostics: Diagnostic[];
  historySlotCount: number;
  stateSiteCount: number;
  varSlotCount: number;
  /** Derived builtin leaves (hl2, hlc3, …) that are []-referenced and so need a
   *  history column written at the top of each bar. */
  autoHistory: { slot: number; leaf: string }[];
  /** The script's `input.*` declarations, in source order (settings schema). */
  inputs: InputDecl[];
}

// Builtin OHLCV+time leaves backed by a fixed series slot.
const STORED_LEAVES: Record<string, number> = {
  open: 0, high: 1, low: 2, close: 3, volume: 4, time: 5,
};
// Derived/computed builtin series leaves (no fixed slot).
const DERIVED_LEAVES = new Set([
  'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'time_close', 'bar_index', 'last_bar_index',
  'last_bar_time', 'timenow', 'time_tradingday',
  'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear',
]);
const INT_LEAVES = new Set([
  'bar_index', 'last_bar_index', 'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear',
]);
const DATE_FNS = new Set(['year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear']);
const RESERVED_MEMBER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
// String-valued `syminfo.*` members (the runtime surface in src/runtime/context.ts);
// the rest (mintick, pricescale, …) are numeric.
const SYMINFO_STRING_MEMBERS = new Set([
  'tickerid', 'ticker', 'prefix', 'root', 'description', 'currency', 'basecurrency',
  'type', 'timezone', 'session', 'volumetype', 'country',
]);
// `dayofweek.<day>` constants (Pine: Sunday = 1 … Saturday = 7).
const DAYOFWEEK_CONST: Record<string, number> = {
  sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7,
};
export const NAMESPACES = new Set([
  'ta', 'math', 'str', 'color', 'input', 'request', 'strategy', 'array', 'matrix',
  'map', 'syminfo', 'timeframe', 'barstate', 'plot', 'shape', 'location', 'hline',
  'display', 'chart', 'session', 'ticker', 'line', 'label', 'box', 'table',
  'position', 'size', 'linefill', 'polyline',
  'xloc', 'extend', 'format', 'font', 'text', 'currency', 'barmerge', 'session', 'scale', 'order',
  'log', 'ticker', 'runtime',
  'yloc', 'adjustment', 'backadjustment', 'settlement_as_close', 'earnings', 'dividends', 'splits',
  'alert',
]);
// request.security is implemented (Phase 7); the request.* fundamental/alternative
// data family is na-stubbed at runtime (no external feed in a headless run), so
// nothing is hard-deferred at analysis time.
const DEFERRED_NAMESPACES = new Set<string>([]);
export const GLOBAL_FNS = new Set([
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar', 'hline',
  'fill', 'bgcolor', 'barcolor', 'nz', 'na', 'fixnan', 'alert', 'alertcondition',
  'indicator', 'strategy', 'library', 'int', 'float', 'bool', 'string',
  'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second', 'weekofyear',
]);
const DEFERRED_FNS = new Set<string>([]);
export const OUTPUT_FNS = new Set([
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar',
  'hline', 'fill', 'bgcolor', 'barcolor',
]);

const tBool: PineType = { kind: 'bool' };
const tFloat: PineType = { kind: 'float' };
const tInt: PineType = { kind: 'int' };
const tString: PineType = { kind: 'string' };
const tColor: PineType = { kind: 'color' };
const tNa: PineType = { kind: 'na' };
const isStr = (t?: PineType) => t?.kind === 'string';
const isFloat = (t?: PineType) => t?.kind === 'float';

/** Input kind for a bare `input(defval, …)`, inferred from the default's type. */
function inferInputKind(t?: PineType): string {
  switch (t?.kind) {
    case 'bool': return 'bool';
    case 'string': return 'string';
    case 'color': return 'color';
    case 'int': return 'int';
    default: return 'float';
  }
}

/** A resolver mapping a const identifier to its initializer expression (for input metadata). */
type ConstResolve = (name: string) => Expr | undefined;

/**
 * Compile-time literal value of an expression (for input metadata), else null.
 * `resolve` (when given) chases references to const-folded identifiers — e.g.
 * `HISTORICAL` → `'Historical'` — and `size.tiny` / `text.*` namespace tags, so
 * the settings panel sees the script's REAL default/options, not just inline literals.
 */
function literalValue(e: Expr | undefined, resolve?: ConstResolve, depth = 0): number | boolean | string | null {
  if (!e || depth > 64) return null;
  if (e.kind === 'Number') return e.value;
  if (e.kind === 'Bool') return e.value;
  if (e.kind === 'String') return e.value;
  if (e.kind === 'Color') return e.value;
  if (e.kind === 'Unary' && e.op === '-' && e.operand.kind === 'Number') return -e.operand.value;
  if (e.kind === 'Ident' && resolve) return literalValue(resolve(e.name), resolve, depth + 1);
  if (e.kind === 'Member' && e.object.kind === 'Ident') {
    const tag = NS_CONST[e.object.name]?.[e.property];
    if (tag !== undefined) return tag;
  }
  return null; // na, or a non-literal (e.g. a source series like `close`)
}
function numLit(e: Expr | undefined, resolve?: ConstResolve): number | undefined {
  const v = literalValue(e, resolve);
  return typeof v === 'number' ? v : undefined;
}

/**
 * Compile-time color value (`#RRGGBBAA`) for input metadata: a color literal, a
 * `color.<name>` constant, `color.new(<color>, <transp>)`, or `color.rgb(r,g,b[,transp])`.
 * Returns null for anything not statically resolvable. Mirrors the runtime ColorNs so the
 * settings panel shows the script's REAL default — `literalValue` alone returns null for the
 * common `input.color(color.new(#hex, 85))` form, which left every such control blank/black.
 */
function constColorValue(e: Expr | undefined, resolve?: ConstResolve, depth = 0): string | null {
  if (!e || depth > 64) return null;
  if (e.kind === 'Color') return e.value;
  if (e.kind === 'Ident' && resolve) return constColorValue(resolve(e.name), resolve, depth + 1);
  if (e.kind === 'Member' && e.object.kind === 'Ident' && e.object.name === 'color') {
    const c = (ColorNs as Record<string, unknown>)[e.property];
    return typeof c === 'string' ? c : null;
  }
  if (e.kind === 'Call' && e.callee.kind === 'Member'
    && e.callee.object.kind === 'Ident' && e.callee.object.name === 'color') {
    const fn = e.callee.property;
    const pos = e.args.filter((a) => !a.name).map((a) => a.value);
    const named = (n: string): Expr | undefined => e.args.find((a) => a.name === n)?.value;
    if (fn === 'new') {
      const baseCol = constColorValue(named('color') ?? pos[0], resolve, depth + 1);
      if (baseCol == null) return null;
      const out = ColorNs.new(baseCol, numLit(named('transp') ?? pos[1], resolve) ?? 0);
      return typeof out === 'string' ? out : null;
    }
    if (fn === 'rgb') {
      const r = numLit(named('red') ?? pos[0], resolve);
      const g = numLit(named('green') ?? pos[1], resolve);
      const b = numLit(named('blue') ?? pos[2], resolve);
      if (r === undefined || g === undefined || b === undefined) return null;
      return ColorNs.rgb(r, g, b, numLit(named('transp') ?? pos[3], resolve) ?? 0);
    }
  }
  return null;
}

class Scope {
  syms = new Map<string, SymRef>();
  constructor(readonly parent?: Scope) {}
  lookup(name: string): SymRef | undefined {
    return this.syms.get(name) ?? this.parent?.lookup(name);
  }
}

export function analyze(program: Program): AnalyzeResult {
  return new Analyzer(program).run();
}

class Analyzer {
  private slots = new SlotAllocator();
  private diags: Diagnostic[] = [];
  private global = new Scope();
  private scope = this.global;
  private funcs = new Set<string>();
  /** User-defined types (UDTs): name → field schema, for `T.new(...)` construction. */
  private userTypes = new Map<string, TypeField[]>();
  /** Enums: name → (member → constant value expr), for compile-time `E.member`. */
  private enums = new Map<string, Map<string, Expr>>();
  private jsCounter = 0;
  private outputCounter = 0;
  private conditionalDepth = 0;
  private inlineDepth = 0; // >0 inside an inlined UDF body (always-executed)
  private autoHistory: { slot: number; leaf: string }[] = [];
  private autoHistoryMap = new Map<string, number>();
  private inputs: InputDecl[] = [];
  private inputCounter = 0;
  private inputKeys = new Set<string>();
  /** Global `name = <expr>` initializers, for resolving const refs in input metadata
   *  (e.g. `input.string(HISTORICAL, options = [HISTORICAL, PRESENT])`). */
  private constEnv = new Map<string, Expr>();
  private securityCounter = 0;

  constructor(private program: Program) {}

  run(): AnalyzeResult {
    // Hoist user function & type names so calls/refs resolve.
    for (const s of this.program.body) {
      if (s.kind === 'FuncDef') this.funcs.add(s.name);
      else if (s.kind === 'TypeDef' && s.isEnum) {
        this.enums.set(s.name, new Map(s.fields.map((f) => [f.name, f.default!])));
      } else if (s.kind === 'TypeDef') this.userTypes.set(s.name, s.fields);
    }
    for (const s of this.program.body) this.stmt(s);
    const c = this.slots.counts;
    return {
      program: this.program,
      diagnostics: this.diags,
      historySlotCount: c.historySlotCount,
      stateSiteCount: c.stateSiteCount,
      varSlotCount: c.varSlotCount,
      autoHistory: this.autoHistory,
      inputs: this.inputs,
    };
  }

  private warn(node: { loc?: { line: number; col: number } }, message: string): void {
    this.diags.push({ severity: 'warning', message, line: node.loc?.line ?? 0, col: node.loc?.col ?? 0 });
  }
  private error(node: { loc?: { line: number; col: number } }, message: string): void {
    this.diags.push({ severity: 'error', message, line: node.loc?.line ?? 0, col: node.loc?.col ?? 0 });
  }

  private freshJsName(name: string): string {
    return `_${this.jsCounter++}_${name.replace(/[^A-Za-z0-9_]/g, '')}`;
  }

  // ── statements ────────────────────────────────────────────
  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'VarDecl': {
        const t = this.expr(s.init);
        const sym: SymRef = {
          kind: s.mode === 'none' ? 'plain' : s.mode,
          name: s.name,
          type: t,
          jsName: this.freshJsName(s.name),
          global: this.scope === this.global,
        };
        if (s.mode !== 'none') {
          const vs: VarSlot = { id: this.slots.varSlot(), mode: s.mode };
          sym.varSlot = vs;
          s.varSlot = vs;
        }
        s.sym = sym;
        this.scope.syms.set(s.name, sym);
        // Record global `name = <expr>` initializers so input metadata can resolve
        // references to named constants (`GREEN`, `HISTORICAL`, …) to their values.
        if (this.scope === this.global && s.mode === 'none' && !this.constEnv.has(s.name)) {
          this.constEnv.set(s.name, s.init);
        }
        break;
      }
      case 'TupleDecl': {
        this.expr(s.init);
        s.syms = s.names.map((name) => {
          const sym: SymRef = { kind: 'plain', name, type: tFloat, jsName: this.freshJsName(name), global: this.scope === this.global };
          this.scope.syms.set(name, sym);
          return sym;
        });
        break;
      }
      case 'Reassign': {
        const value = this.expr(s.value);
        if (s.target.kind === 'Ident') {
          const sym = this.resolveIdent(s.target.name);
          s.target.sym = sym;
          s.sym = sym;
          if (sym.varSlot) s.varSlot = sym.varSlot;
          // widen the symbol's type if the reassignment introduces a float
          if (isFloat(value) && sym.type?.kind === 'int') sym.type = tFloat;
        } else {
          if (RESERVED_MEMBER_NAMES.has(s.target.property)) {
            this.error(s.target, `reserved property '${s.target.property}' cannot be assigned`);
          }
          this.expr(s.target); // obj.field
        }
        break;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        break;
      case 'FuncDef':
        // Registered for resolution; body analysis deferred with UDF calls.
        break;
      case 'TypeDef':
        // Analyze field defaults once (in global scope) so idents like `open`/`high`
        // used as defaults resolve before a `T.new()` site emits them.
        for (const f of s.fields) if (f.default) this.expr(f.default);
        break;
      case 'Import':
        break;
      case 'Break':
      case 'Continue':
        break;
      case 'If':
      case 'Switch':
      case 'For':
      case 'ForIn':
      case 'While':
        this.expr(s);
        break;
    }
  }

  /** Analyze a block; return the value type of its last expression statement. */
  private block(body: Stmt[]): PineType {
    const prev = this.scope;
    this.scope = new Scope(prev);
    for (const st of body) this.stmt(st);
    this.scope = prev;
    const last = body[body.length - 1];
    return last && last.kind === 'ExprStmt' ? (last.expr.type ?? tNa) : tNa;
  }

  /** Unify branch types: string if any string, else float if any float, else int. */
  private joinTypes(types: PineType[]): PineType {
    if (types.some(isStr)) return tString;
    if (types.some(isFloat)) return tFloat;
    return types.find((t) => t.kind === 'int') ?? types[0] ?? tNa;
  }

  // ── expressions (returns inferred coarse type) ────────────
  private expr(e: Expr): PineType {
    switch (e.kind) {
      case 'Number': return (e.type = e.isInt ? tInt : tFloat);
      case 'String': return (e.type = tString);
      case 'Bool': return (e.type = tBool);
      case 'Color': return (e.type = tColor);
      case 'Na': return (e.type = tNa);

      case 'Ident': {
        const sym = this.resolveIdent(e.name);
        e.sym = sym;
        if (sym.varSlot) e.varSlot = sym.varSlot;
        if (sym.kind === 'unknown') this.error(e, `undefined variable '${e.name}'`);
        return (e.type = sym.type ?? tFloat);
      }

      case 'Member': {
        if (RESERVED_MEMBER_NAMES.has(e.property)) {
          this.error(e, `reserved property '${e.property}' is not accessible`);
          return (e.type = tNa);
        }
        // enum member access `E.member` → resolve to its constant value (compile-time).
        if (e.object.kind === 'Ident' && this.enums.has(e.object.name)) {
          const val = this.enums.get(e.object.name)!.get(e.property);
          if (val) { e.constExpr = val; return (e.type = this.expr(val)); }
          this.error(e, `enum '${e.object.name}' has no member '${e.property}'`);
          return (e.type = tNa);
        }
        // `dayofweek.monday` etc. — `dayofweek` is also a series leaf, so the member
        // form is folded to its integer constant (Sunday = 1 … Saturday = 7).
        if (e.object.kind === 'Ident' && e.object.name === 'dayofweek' && e.property in DAYOFWEEK_CONST) {
          e.constExpr = { kind: 'Number', value: DAYOFWEEK_CONST[e.property], isInt: true };
          return (e.type = tInt);
        }
        this.expr(e.object);
        // no-paren stateful ta variable (e.g. `ta.tr`) → assign a call-site id.
        if (e.object.kind === 'Ident' && e.object.name === 'ta' && TA_VARS.has(e.property)) {
          e.stateSite = this.slots.stateSlot();
          return (e.type = tFloat);
        }
        // namespace constants / fields: coarse typing
        if (e.object.kind === 'Ident') {
          const ns = e.object.name;
          if (ns === 'barstate') return (e.type = tBool);
          if (ns === 'color') return (e.type = tColor);
          if (ns === 'syminfo') {
            return (e.type = SYMINFO_STRING_MEMBERS.has(e.property) ? tString : tFloat);
          }
          if (ns === 'timeframe') {
            if (e.property === 'period' || e.property === 'main_period') return (e.type = tString);
            if (e.property === 'multiplier') return (e.type = tInt);
            if (e.property.startsWith('is')) return (e.type = tBool);
          }
          if (ns === 'chart') {
            if (e.property === 'bg_color' || e.property === 'fg_color') return (e.type = tColor);
            if (e.property.startsWith('is_')) return (e.type = tBool);
          }
          if (ns === 'session' && e.property.startsWith('is')) return (e.type = tBool);
          // namespace tag constants (size.tiny, session.regular, format.volume, …):
          // type by the runtime tag's JS type so string tags concatenate correctly.
          const tag = NS_CONST[ns]?.[e.property];
          if (typeof tag === 'string') return (e.type = tString);
          if (typeof tag === 'boolean') return (e.type = tBool);
          if (DEFERRED_NAMESPACES.has(ns)) this.error(e, `'${ns}.*' is not yet supported`);
        }
        return (e.type = tFloat);
      }

      case 'History': {
        const base = this.expr(e.base);
        this.expr(e.offset);
        this.assignHistory(e);
        return (e.type = base);
      }

      case 'Unary': {
        const t = this.expr(e.operand);
        if (e.op === 'not') return (e.type = tBool);
        return (e.type = t);
      }

      case 'Binary': return this.binary(e);

      case 'Ternary': {
        this.expr(e.cond);
        const a = this.condBranch(() => this.expr(e.then));
        const b = this.condBranch(() => this.expr(e.else));
        return (e.type = isStr(a) || isStr(b) ? tString : isFloat(a) || isFloat(b) ? tFloat : a);
      }

      case 'Call': return this.call(e);

      case 'Tuple':
        for (const it of e.items) this.expr(it);
        return (e.type = tFloat);

      case 'If': {
        this.expr(e.cond);
        // A synthetic (inlined-UDF) if is always-true and single-branch: its body
        // is NOT conditional, so don't flag stateful calls or local-history there.
        if (e.synthetic) {
          this.inlineDepth++;
          const t = this.block(e.then);
          this.inlineDepth--;
          return (e.type = t);
        }
        const types: PineType[] = [this.condBranch(() => this.block(e.then))];
        for (const el of e.elifs) {
          this.expr(el.cond);
          types.push(this.condBranch(() => this.block(el.body)));
        }
        if (e.else) types.push(this.condBranch(() => this.block(e.else!)));
        return (e.type = this.joinTypes(types));
      }
      case 'Switch': {
        if (e.subject) this.expr(e.subject);
        const types: PineType[] = [];
        for (const c of e.cases) {
          if (c.test) this.expr(c.test);
          types.push(this.condBranch(() => this.block(c.body)));
        }
        return (e.type = this.joinTypes(types));
      }
      case 'For': {
        this.expr(e.from);
        this.expr(e.to);
        if (e.step) this.expr(e.step);
        const prev = this.scope;
        this.scope = new Scope(prev);
        e.varSym = { kind: 'plain', name: e.varName, type: tInt, jsName: this.freshJsName(e.varName) };
        this.scope.syms.set(e.varName, e.varSym);
        for (const st of e.body) this.stmt(st);
        this.scope = prev;
        return (e.type = tFloat);
      }
      case 'ForIn': {
        this.expr(e.iterable);
        const prev = this.scope;
        this.scope = new Scope(prev);
        if (e.indexName) {
          e.indexSym = { kind: 'plain', name: e.indexName, type: tInt, jsName: this.freshJsName(e.indexName) };
          this.scope.syms.set(e.indexName, e.indexSym);
        }
        e.valueSym = { kind: 'plain', name: e.valueName, type: tFloat, jsName: this.freshJsName(e.valueName) };
        this.scope.syms.set(e.valueName, e.valueSym);
        for (const st of e.body) this.stmt(st);
        this.scope = prev;
        return (e.type = tFloat);
      }
      case 'While': {
        this.expr(e.cond);
        this.block(e.body);
        return (e.type = tFloat);
      }
    }
  }

  private condBranch<T>(fn: () => T): T {
    this.conditionalDepth++;
    try {
      return fn();
    } finally {
      this.conditionalDepth--;
    }
  }

  private binary(e: Extract<Expr, { kind: 'Binary' }>): PineType {
    // and/or short-circuit: the RHS is conditionally evaluated, so a stateful
    // call there can corrupt its series → analyze it under conditional context.
    if (e.op === 'and' || e.op === 'or') {
      this.expr(e.left);
      this.condBranch(() => this.expr(e.right));
      return (e.type = tBool);
    }
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    switch (e.op) {
      case '==':
      case '!=':
        if (e.left.kind === 'Na' || e.right.kind === 'Na') {
          this.warn(e, `comparison with na is always false in v6; use na(x) / not na(x) instead`);
        }
        return (e.type = tBool);
      case '<':
      case '<=':
      case '>':
      case '>=':
        return (e.type = tBool);
      case '+':
        if (isStr(l) || isStr(r)) return (e.type = tString);
        return (e.type = isFloat(l) || isFloat(r) ? tFloat : tInt);
      case '-':
      case '*':
      case '%':
        return (e.type = isFloat(l) || isFloat(r) ? tFloat : tInt);
      case '/':
        return (e.type = tFloat); // v6: division is always float
    }
  }

  private call(e: Extract<Expr, { kind: 'Call' }>): PineType {
    for (const a of e.args) this.expr(a.value);
    const callee = e.callee;

    // ta.* (and fixnan) are stateful → assign a call-site id.
    // UDT constructor: `T.new(...)` where T is a user-defined type. Record the
    // field schema so both backends build an identical `{field: value}` instance;
    // do NOT resolve `T` as a variable (it's a type name, not a value).
    if (callee.kind === 'Member' && callee.object.kind === 'Ident'
      && callee.property === 'new' && this.userTypes.has(callee.object.name)) {
      const fields = this.userTypes.get(callee.object.name)!;
      e.udtFields = fields.map((f) => ({ name: f.name, default: f.default }));
      // args were already analyzed above — re-analyzing would duplicate input
      // declarations and leak state/history slots.
      return (e.type = tFloat); // UDT instance (coarse type)
    }

    let nsName: string | undefined;
    let fnName: string | undefined;
    if (callee.kind === 'Member' && callee.object.kind === 'Ident') {
      nsName = callee.object.name;
      fnName = callee.property;
      this.expr(callee.object); // resolve/annotate the namespace ident
    } else if (callee.kind === 'Ident') {
      fnName = callee.name;
    } else {
      this.expr(callee);
    }

    const isStateful = nsName === 'ta' || (nsName === 'math' && fnName === 'sum') || (!nsName && fnName === 'fixnan');
    if (isStateful) {
      e.stateSite = this.slots.stateSlot();
      if (this.conditionalDepth > 0) {
        this.warn(e, `stateful call '${nsName ? nsName + '.' : ''}${fnName}' inside a conditional branch may corrupt its internal series; consider hoisting it`);
      }
    }

    // request.security[_lower_tf] are intercepted (sub-context eval + a site for caching and
    // dependency recording); other request.* are deferred.
    if (nsName === 'request' && (fnName === 'security' || fnName === 'security_lower_tf')) {
      e.securitySite = this.securityCounter++;
    } else if (nsName && DEFERRED_NAMESPACES.has(nsName)) {
      this.error(e, `'${nsName}.${fnName}' is not yet supported`);
    }
    if (!nsName && fnName && this.funcs.has(fnName)) this.error(e, `user-defined function calls are not yet supported`);
    if (!nsName && fnName && DEFERRED_FNS.has(fnName)) this.error(e, `'${fnName}()' is not yet supported`);

    // stable output id for plot-family calls (both backends read it)
    if (!nsName && fnName && OUTPUT_FNS.has(fnName)) {
      e.outputId = this.outputCounter++;
    }

    // input.* — extract the settings-schema declaration + assign an override key
    if (nsName === 'input' && fnName) {
      e.inputKey = this.extractInput(e, fnName);
    }
    // bare `input(defval, title)` — auto-typed from the default value's type.
    if (!nsName && fnName === 'input') {
      const defval = e.args.filter((a) => !a.name)[0]?.value ?? e.args.find((a) => a.name === 'defval')?.value;
      const kind = inferInputKind(defval?.type);
      e.inputKey = this.extractInput(e, kind);
      return (e.type = defval?.type ?? tFloat);
    }

    return (e.type = this.callReturnType(nsName, fnName));
  }

  private callReturnType(ns: string | undefined, fn: string | undefined): PineType {
    if (ns === 'ta') {
      if (fn === 'crossover' || fn === 'crossunder' || fn === 'cross' || fn === 'rising' || fn === 'falling') return tBool;
      if (fn === 'barssince') return tInt;
      return tFloat; // macd/bb return tuples; coarse type unused for destructuring
    }
    if (ns === 'array') {
      if (fn === 'size' || fn === 'indexof') return tInt;
      if (fn === 'includes') return tBool;
      if (fn === 'join') return tString;
      if (fn && fn.startsWith('new_')) return tFloat; // array reference (coarse)
      return tFloat;
    }
    if (ns === 'map') {
      if (fn === 'size') return tInt;
      if (fn === 'contains') return tBool;
      return tFloat;
    }
    if (ns === 'matrix') {
      if (fn === 'rows' || fn === 'columns') return tInt;
      return tFloat;
    }
    // drawing objects: .new() returns an id; getters return numbers; setters void.
    if (ns === 'line' || ns === 'label' || ns === 'box' || ns === 'table' || ns === 'linefill' || ns === 'polyline') return tFloat;
    if (ns === 'math') return tFloat;
    if (ns === 'str') {
      if (fn === 'tonumber') return tFloat;
      if (fn === 'length' || fn === 'pos') return tInt; // pos → na-able int index
      if (fn === 'contains' || fn === 'startswith' || fn === 'endswith') return tBool;
      if (fn === 'split') return tFloat; // array reference (coarse), matching array.new_*
      return tString; // tostring/format/replace/substring/upper/lower/trim/repeat/match/format_time
    }
    if (ns === 'color') return tColor;
    if (ns === 'input') {
      if (fn === 'int' || fn === 'time') return tInt;
      if (fn === 'bool') return tBool;
      if (fn === 'string' || fn === 'symbol' || fn === 'session' || fn === 'text_area' || fn === 'enum') return tString;
      if (fn === 'color') return tColor;
      return tFloat;
    }
    if (ns === 'syminfo') return tString; // syminfo.prefix(tid) / syminfo.ticker(tid)
    if (ns === 'ticker') return tString; // ticker.new/heikinashi/… build ticker-id strings
    if (ns === 'timeframe') {
      if (fn === 'change') return tBool;
      if (fn === 'in_seconds') return tInt;
      return tString; // from_seconds
    }
    if (fn && DATE_FNS.has(fn)) return tInt;
    switch (fn) {
      case 'na': return tBool;
      case 'int': return tInt;
      case 'bool': return tBool;
      case 'string': return tString;
      case 'timestamp':
      case 'time':
      case 'time_close':
        return tInt;
      case 'nz':
      case 'fixnan':
      case 'float':
        return tFloat;
      default:
        return tFloat;
    }
  }

  /** Build the InputDecl for an `input.*` call and return its override key. */
  private extractInput(e: Extract<Expr, { kind: 'Call' }>, fn: string): string {
    const pos = e.args.filter((a) => !a.name).map((a) => a.value);
    const named = (n: string) => e.args.find((a) => a.name === n)?.value;
    const KINDS = ['int', 'float', 'bool', 'string', 'color', 'source', 'price', 'timeframe',
      'symbol', 'session', 'time', 'text_area', 'enum'];
    const kind = (KINDS.includes(fn) ? fn : 'float') as InputDecl['kind'];
    const resolve: ConstResolve = (n) => this.constEnv.get(n);
    const strArg = (e: Expr | undefined): string | undefined => {
      const v = literalValue(e, resolve);
      return typeof v === 'string' ? v : undefined;
    };
    const titleExpr = named('title') ?? (pos[1]?.kind === 'String' ? pos[1] : undefined);
    const title = strArg(titleExpr);
    // Pine allows duplicate input titles (e.g. three "Session color" across groups) — they are
    // DISTINCT inputs, so each needs a UNIQUE override key. fractal stores/sends overrides by
    // key, so a collision makes every same-titled input share one value (all sessions the same
    // color / name). Disambiguate by source order; the title (display label) stays unchanged.
    let key = title ?? `input_${this.inputCounter++}`;
    if (this.inputKeys.has(key)) {
      let n = 2;
      while (this.inputKeys.has(`${key} (${n})`)) n += 1;
      key = `${key} (${n})`;
    }
    this.inputKeys.add(key);
    // `options = [...]` may be passed by name OR positionally (its index varies per input
    // function — pos[2] for input.string/timeframe/symbol/session, pos[5] for input.int/float).
    // It's the ONLY tuple-valued positional arg to any input.*, so a positional fallback that
    // finds the first Tuple captures it for every form (e.g. `input.timeframe("1W", "TF",
    // ["60","240","1D"])`, which would otherwise drop the dropdown list).
    const optsExpr = named('options') ?? pos.find((p) => p.kind === 'Tuple');
    const defExpr = named('defval') ?? pos[0];
    // input.int / input.float take minval, maxval, step POSITIONALLY at pos 2/3/4
    // (`input.int(defval, title, minval, maxval, step, options, …)`); accept those as
    // fallbacks so a positional call still carries its range to the settings panel.
    const numeric = fn === 'int' || fn === 'float';
    const decl: InputDecl = {
      key,
      kind,
      title,
      default: constColorValue(defExpr, resolve) ?? literalValue(defExpr, resolve),
      minval: numLit(named('minval') ?? (numeric ? pos[2] : undefined), resolve),
      maxval: numLit(named('maxval') ?? (numeric ? pos[3] : undefined), resolve),
      step: numLit(named('step') ?? (numeric ? pos[4] : undefined), resolve),
      options: optsExpr?.kind === 'Tuple' ? (optsExpr.items.map((it) => literalValue(it, resolve)).filter((v) => v != null) as (string | number)[]) : undefined,
      group: strArg(named('group')),
      tooltip: strArg(named('tooltip')),
    };
    this.inputs.push(decl);
    return key;
  }

  // ── resolution & history ──────────────────────────────────
  private resolveIdent(name: string): SymRef {
    const local = this.scope.lookup(name);
    if (local) return local;
    if (name in STORED_LEAVES) return { kind: 'builtin-series', name, type: tFloat, builtinSlot: STORED_LEAVES[name] };
    if (DERIVED_LEAVES.has(name)) {
      return { kind: 'builtin-series', name, type: INT_LEAVES.has(name) ? tInt : tFloat, builtinSlot: null };
    }
    if (NAMESPACES.has(name)) return { kind: 'builtin-ns', name };
    if (GLOBAL_FNS.has(name)) return { kind: 'builtin-fn', name };
    if (this.funcs.has(name)) return { kind: 'func', name };
    return { kind: 'unknown', name, type: tFloat };
  }

  /** Assign (or reuse) the history slot for a `[]` reference. */
  private assignHistory(e: Extract<Expr, { kind: 'History' }>): void {
    const base = e.base;
    if (base.kind === 'Ident' && base.sym) {
      const sym = base.sym;
      if (sym.kind === 'builtin-series') {
        if (sym.builtinSlot != null) {
          e.historySlot = sym.builtinSlot;
        } else {
          // derived leaf (hl2, hlc3, bar_index, …): auto-history column written
          // at the top of each bar by both backends.
          let slot = this.autoHistoryMap.get(sym.name);
          if (slot === undefined) {
            slot = this.slots.historySlot();
            this.autoHistoryMap.set(sym.name, slot);
            this.autoHistory.push({ slot, leaf: sym.name });
          }
          e.historySlot = slot;
        }
        return;
      }
      if (sym.kind === 'plain' || sym.kind === 'var' || sym.kind === 'varip' || sym.kind === 'param') {
        if (sym.historySlot == null) sym.historySlot = this.slots.historySlot();
        e.historySlot = sym.historySlot;
        if (sym.global === false && this.inlineDepth === 0) {
          this.warn(e, `history ([]) of the local variable '${sym.name}' is unreliable; its column is only written on bars where its block executes — hoist it to global scope`);
        }
        return;
      }
    }
    // Inline-expression history `(expr)[n]` (e.g. `ta.sma(close,10)[1]`, `f(x)[1]`): there's no
    // variable slot, so materialize the expression into its own auto-history column written AT
    // THE USE SITE each bar (both backends), then read offset-back. Correct when the reference
    // executes every bar (the common top-level case); it shares the local-variable history
    // caveat for conditional contexts, but there's no name to hoist, so we don't warn.
    e.historySlot = this.slots.historySlot();
    e.historyExpr = true;
  }
}
