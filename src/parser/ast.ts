/**
 * Pine v6 AST (Phase 2/3). See docs/compiler-design.md §1.2 for the node-field
 * contract: the parser sets `kind`/`loc`/structure; Phase 4 (semantic analysis)
 * *adds* the annotation fields (`type`, `qual`, `historySlot`, `stateSite`,
 * `varSlot`) in place and never rewrites structure; both backends read them.
 */

import type { PineType, Qualifier } from '../sema/types.js';

export interface Loc {
  line: number;
  col: number;
}

/** Annotation fields attached by semantic analysis (Phase 4). */
export interface Annotations {
  type?: PineType;
  qual?: Qualifier;
  /** History column id if this value is referenced via `[]`, else null/undefined. */
  historySlot?: number | null;
  /** Call-site id for a stateful builtin, else null/undefined. */
  stateSite?: number | null;
}

export interface VarSlot {
  id: number;
  mode: 'var' | 'varip';
}

/**
 * Resolved binding for a name, attached by semantic analysis. One SymRef object
 * is shared by a symbol's declaration and every reference to it, so slot
 * assignment (which may happen when a later `[]` is seen) is visible everywhere.
 */
export type SymKind =
  | 'plain' // ordinary per-bar local
  | 'var' // var-persistent
  | 'varip' // varip-persistent
  | 'builtin-series' // close/open/hl2/...
  | 'builtin-ns' // ta/math/color/... namespace object
  | 'builtin-fn' // global builtin function (plot/nz/na/...)
  | 'func' // user-defined function
  | 'param' // function parameter
  | 'unknown';

export interface SymRef {
  kind: SymKind;
  name: string;
  /** Inferred value type (for + vs concat and lints). */
  type?: PineType;
  /** Safe JS local name for plain/param symbols. */
  jsName?: string;
  /** var/varip persistence slot. */
  varSlot?: VarSlot | null;
  /** History column id once this symbol is `[]`-referenced. */
  historySlot?: number | null;
  /** Fixed builtin slot for the 6 stored OHLCV/time leaves. */
  builtinSlot?: number | null;
  /** True if declared at global scope (history of locals is unreliable → lint). */
  global?: boolean;
}

// ───────────────────────── Program ─────────────────────────

export interface Program {
  kind: 'Program';
  version: number;
  body: Stmt[];
  loc?: Loc;
}

// ───────────────────────── Statements ──────────────────────

export type Stmt =
  | VarDecl
  | TupleDecl
  | Reassign
  | ExprStmt
  | FuncDef
  | TypeDef
  | ImportStmt
  | Break
  | Continue
  // control-flow nodes double as expressions:
  | IfNode
  | SwitchNode
  | ForNode
  | ForInNode
  | WhileNode;

export type VarMode = 'none' | 'var' | 'varip';

export interface VarDecl {
  kind: 'VarDecl';
  export?: boolean;
  mode: VarMode;
  declQual?: Qualifier;
  declType?: PineType;
  name: string;
  init: Expr;
  /** Set by slot allocation for var/varip declarations. */
  varSlot?: VarSlot | null;
  /** Set if this variable is `[]`-referenced (write the slot after init). */
  historySlot?: number | null;
  sym?: SymRef;
  loc?: Loc;
}

export interface TupleDecl {
  kind: 'TupleDecl';
  names: string[];
  init: Expr;
  varSlots?: (VarSlot | null)[];
  syms?: SymRef[];
  loc?: Loc;
}

export type AssignOp = ':=' | '+=' | '-=' | '*=' | '/=' | '%=';

export interface Reassign {
  kind: 'Reassign';
  op: AssignOp;
  target: Ident | Member;
  value: Expr;
  /** Resolved var slot of the target, if it is a var/varip symbol. */
  varSlot?: VarSlot | null;
  historySlot?: number | null;
  sym?: SymRef;
  loc?: Loc;
}

export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expr;
  loc?: Loc;
}

export interface Param {
  name: string;
  declQual?: Qualifier;
  declType?: PineType;
  default?: Expr;
}

export interface FuncDef {
  kind: 'FuncDef';
  export?: boolean;
  /** Declared with the `method` keyword → callable as `receiver.name(...)`. */
  isMethod?: boolean;
  name: string;
  params: Param[];
  body: Stmt[];
  loc?: Loc;
}

export interface TypeField {
  name: string;
  varip?: boolean;
  declType?: PineType;
  default?: Expr;
}

export interface TypeDef {
  kind: 'TypeDef';
  export?: boolean;
  name: string;
  fields: TypeField[];
  /** True for `enum` declarations: `fields` are members and `default` is the title. */
  isEnum?: boolean;
  loc?: Loc;
}

export interface ImportStmt {
  kind: 'Import';
  user: string;
  lib: string;
  /** The version segment as written, verbatim (e.g. "1"). Kept as a string so matching
   *  against a registry key is exact — no numeric coercion (`01` ≠ `1`). */
  version: string;
  alias?: string;
  loc?: Loc;
}

export interface Break {
  kind: 'Break';
  loc?: Loc;
}
export interface Continue {
  kind: 'Continue';
  loc?: Loc;
}

// ───────────────────── Control flow (stmt + expr) ──────────

export interface IfNode extends Annotations {
  kind: 'If';
  cond: Expr;
  then: Stmt[];
  elifs: { cond: Expr; body: Stmt[] }[];
  else?: Stmt[];
  /** True when synthesized by UDF inlining (always-true; suppresses local lints). */
  synthetic?: boolean;
  loc?: Loc;
}

export interface SwitchCase {
  /** undefined = the default `=>` branch. */
  test?: Expr;
  body: Stmt[];
}

export interface SwitchNode extends Annotations {
  kind: 'Switch';
  subject?: Expr;
  cases: SwitchCase[];
  loc?: Loc;
}

export interface ForNode extends Annotations {
  kind: 'For';
  varName: string;
  from: Expr;
  to: Expr;
  step?: Expr;
  body: Stmt[];
  varSym?: SymRef;
  loc?: Loc;
}

export interface ForInNode extends Annotations {
  kind: 'ForIn';
  /** `for [i, v] in coll` → indexName='i', valueName='v'; `for v in coll` → valueName='v'. */
  indexName?: string;
  valueName: string;
  iterable: Expr;
  body: Stmt[];
  indexSym?: SymRef;
  valueSym?: SymRef;
  loc?: Loc;
}

export interface WhileNode extends Annotations {
  kind: 'While';
  cond: Expr;
  body: Stmt[];
  loc?: Loc;
}

// ───────────────────────── Expressions ─────────────────────

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | ColorLit
  | NaLit
  | Ident
  | Member
  | Call
  | History
  | Unary
  | Binary
  | Ternary
  | TupleExpr
  | IfNode
  | SwitchNode
  | ForNode
  | ForInNode
  | WhileNode;

export interface NumberLit extends Annotations {
  kind: 'Number';
  value: number;
  isInt: boolean;
  loc?: Loc;
}
export interface StringLit extends Annotations {
  kind: 'String';
  value: string;
  loc?: Loc;
}
export interface BoolLit extends Annotations {
  kind: 'Bool';
  value: boolean;
  loc?: Loc;
}
export interface ColorLit extends Annotations {
  kind: 'Color';
  value: string; // normalized #RRGGBBAA
  loc?: Loc;
}
export interface NaLit extends Annotations {
  kind: 'Na';
  loc?: Loc;
}
export interface Ident extends Annotations {
  kind: 'Ident';
  name: string;
  /** Resolved var slot, if this identifier binds to a var/varip symbol. */
  varSlot?: VarSlot | null;
  sym?: SymRef;
  loc?: Loc;
}
export interface Member extends Annotations {
  kind: 'Member';
  object: Expr;
  property: string;
  /** For an enum member access `E.member`: the resolved constant value expr. */
  constExpr?: Expr;
  loc?: Loc;
}
export interface Arg {
  name?: string; // named argument
  value: Expr;
}
export interface Call extends Annotations {
  kind: 'Call';
  callee: Expr; // Ident or Member
  args: Arg[];
  /** Generic type args, e.g. `array.new<float>()` (parsed; runtime is untyped). */
  typeArgs?: PineType[];
  /** Stable output id for plot/plotshape/hline/fill (assigned by analysis). */
  outputId?: number;
  /** Override key for an `input.*` call (its title, else an auto id). */
  inputKey?: string;
  /** Call-site id for a request.security() call (its cached HTF series). */
  securitySite?: number;
  /** For a UDT constructor `T.new(...)`: the type's field names in order (with
   *  defaults), so both backends build the same `{field: value}` instance. */
  udtFields?: { name: string; default?: Expr }[];
  loc?: Loc;
}
export interface History extends Annotations {
  kind: 'History';
  base: Expr;
  offset: Expr;
  /** True when `base` is an inline expression (not a var/builtin): its value is materialized
   *  into `historySlot` at the use site each bar, then read offset-back. Set by the analyzer. */
  historyExpr?: boolean;
  loc?: Loc;
}
export type UnaryOp = '-' | '+' | 'not';
export interface Unary extends Annotations {
  kind: 'Unary';
  op: UnaryOp;
  operand: Expr;
  loc?: Loc;
}
export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';
export interface Binary extends Annotations {
  kind: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  loc?: Loc;
}
export interface Ternary extends Annotations {
  kind: 'Ternary';
  cond: Expr;
  then: Expr;
  else: Expr;
  loc?: Loc;
}
/** Tuple literal `[a, b]` (prefix position) — distinct from postfix history `[]`. */
export interface TupleExpr extends Annotations {
  kind: 'Tuple';
  items: Expr[];
  loc?: Loc;
}

/** Type guard: is this control-flow node usable as an expression value? */
export function isExpr(node: Stmt | Expr): node is Expr {
  switch (node.kind) {
    case 'VarDecl':
    case 'TupleDecl':
    case 'Reassign':
    case 'ExprStmt':
    case 'FuncDef':
    case 'TypeDef':
    case 'Import':
    case 'Break':
    case 'Continue':
      return false;
    default:
      return true;
  }
}
