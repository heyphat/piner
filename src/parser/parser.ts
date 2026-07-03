/**
 * Pine v6 parser (docs/compiler-design.md §3). Recursive descent for statements,
 * precedence-climbing (Pratt) for expressions. NEWLINE separates statements;
 * INDENT/DEDENT delimit blocks. Consumes the LexResult token stream and the
 * version from the lexer.
 */
import { TokenKind, type Token } from '../lexer/token.js';
import type { LexResult } from '../lexer/lexer.js';
import { Qualifier, type PineType } from '../sema/types.js';
// Type-only (erased at runtime) — no runtime import cycle with library.ts.
import type { LibraryIdentity } from '../sema/library.js';
import type {
  Program,
  Stmt,
  Expr,
  VarDecl,
  TupleDecl,
  ExprStmt,
  FuncDef,
  TypeDef,
  ImportStmt,
  IfNode,
  SwitchNode,
  ForNode,
  ForInNode,
  WhileNode,
  Param,
  TypeField,
  Arg,
  VarMode,
  AssignOp,
  BinaryOp,
  Loc,
} from './ast.js';

export class ParseError extends Error {
  /** The unformatted message body (without the `Parse error at L:C:` prefix), so a
   *  library parse failure can be re-wrapped with identity/chain attribution. */
  readonly raw: string;
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    /** Set when the parse failure occurred inside an imported library (Req 9.1). */
    readonly library?: LibraryIdentity,
    /** Ordered chain Consumer → … → originating library (Req 9.4). */
    readonly importChain?: LibraryIdentity[],
  ) {
    const where = library ? ` in library ${library.canonical}` : '';
    super(`Parse error at ${line}:${col}${where}: ${message}`);
    this.name = 'ParseError';
    this.raw = message;
  }
}

const FUND_TYPES: Record<string, PineType> = {
  int: { kind: 'int' },
  float: { kind: 'float' },
  bool: { kind: 'bool' },
  color: { kind: 'color' },
  string: { kind: 'string' },
};
const SPECIAL_TYPE_NAMES = new Set(['line', 'label', 'box', 'table', 'polyline', 'linefill']);
const QUALIFIERS: Record<string, Qualifier> = {
  const: Qualifier.Const,
  simple: Qualifier.Simple,
  series: Qualifier.Series,
};
// Structural keywords that Pine also accepts as plain identifiers in NAME positions —
// parameter names, named-argument names, fields. Most common: `type` (v3/v4 `input(..., type=…)`
// and params named `type`). Control-flow keywords (if/for/while/…) are intentionally excluded.
const CONTEXTUAL_NAME_KW = new Set([
  'type',
  'method',
  'enum',
  'import',
  'export',
  'series',
  'simple',
  'const',
]);
// binary operator precedence (higher binds tighter); see §3.1
const BIN_PREC: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

export function parse(lex: LexResult): Program {
  return new Parser(lex.tokens, lex.version).parseProgram();
}

class Parser {
  private pos = 0;
  constructor(
    private toks: Token[],
    private version: number,
  ) {}

  // ── cursor helpers ────────────────────────────────────────
  private peek(o = 0): Token {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  private at(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }
  private atKw(value: string): boolean {
    return this.at(TokenKind.Keyword, value);
  }
  private next(): Token {
    return this.toks[this.pos++];
  }
  private loc(): Loc {
    const t = this.peek();
    return { line: t.line, col: t.col };
  }
  private err(msg: string): never {
    const t = this.peek();
    throw new ParseError(`${msg} (got ${t.kind} ${JSON.stringify(t.value)})`, t.line, t.col);
  }

  private expect(kind: TokenKind, value?: string): Token {
    if (!this.at(kind, value)) this.err(`expected ${value ?? kind}`);
    return this.next();
  }
  private eat(kind: TokenKind, value?: string): boolean {
    if (this.at(kind, value)) {
      this.next();
      return true;
    }
    return false;
  }
  private skipNewlines(): void {
    while (this.at(TokenKind.Newline)) this.next();
  }

  // ── program ───────────────────────────────────────────────
  parseProgram(): Program {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.Eof)) {
      body.push(...this.parseStatements());
      this.skipNewlines();
    }
    return { kind: 'Program', version: this.version, body };
  }

  private parseBlock(): Stmt[] {
    this.expect(TokenKind.Indent);
    const body: Stmt[] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.Dedent) && !this.at(TokenKind.Eof)) {
      body.push(...this.parseStatements());
      this.skipNewlines();
    }
    this.eat(TokenKind.Dedent);
    return body;
  }

  // ── statements ────────────────────────────────────────────
  /**
   * Parse one statement, expanding a comma-separated series into several
   * statements. Pine allows multiple statements on one line separated by commas:
   * declarations (`var float a = na, var float b = na, c = 0`), reassignments
   * (`a := 1, b := 2`), and expression statements / method calls
   * (`aZZ.d.unshift(d), aZZ.x.pop()`) — even mixed. A comma surviving to the
   * statement boundary is always a separator (commas inside calls/arrays/tuples
   * are consumed by the expression parser), so each item is a full statement.
   */
  private parseStatements(): Stmt[] {
    const first = this.parseStatement();
    if (!this.at(TokenKind.Punct, ',')) return [first];
    const list: Stmt[] = [first];
    while (this.eat(TokenKind.Punct, ',')) {
      list.push(this.parseStatement());
    }
    return list;
  }

  private parseStatement(): Stmt {
    const loc = this.loc();
    if (this.at(TokenKind.Keyword)) {
      const kw = this.peek().value;
      switch (kw) {
        case 'import':
          return this.parseImport();
        // `type Foo` / `enum Bar` / `method m(…)` introduce definitions (a NAME
        // follows); the same words used as a value (`type == "x"`, `method := …`)
        // lead an expression statement — fall through to the expression-led path.
        case 'type':
          if (this.isNameToken(1)) return this.parseTypeDef(false);
          break;
        case 'enum':
          if (this.isNameToken(1)) return this.parseEnumDef(false);
          break;
        case 'method':
          if (this.isNameToken(1)) {
            this.next();
            const fd = this.parseFuncDef(false);
            fd.isMethod = true;
            return fd;
          }
          break;
        case 'export':
          return this.parseExport();
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          return this.parseWhile();
        case 'switch':
          return this.parseSwitch();
        case 'break':
          this.next();
          return { kind: 'Break', loc };
        case 'continue':
          this.next();
          return { kind: 'Continue', loc };
        case 'var':
        case 'varip':
          return this.parseVarDecl();
        case 'const':
        case 'simple':
        case 'series':
          return this.parseVarDecl();
        case 'int':
        case 'float':
        case 'bool':
        case 'color':
        case 'string': {
          // A fundamental-type keyword leads a typed decl (`color c = …`) UNLESS it's used as
          // an expression — a member access (`color.new(…)`) or a cast call (`int(x)`) — or as a
          // plain variable NAME being declared/reassigned (`color = …`, `color := …`, which Pine
          // permits). Those start an expression statement, so fall through rather than mis-parsing
          // a var-decl. A `[` still means a typed decl (legacy array `float[] x`), not history.
          const n = this.peek(1);
          const exprUse = n.kind === TokenKind.Punct && (n.value === '.' || n.value === '(');
          const nameUse =
            n.kind === TokenKind.Op &&
            (n.value === '=' ||
              n.value === ':=' ||
              n.value === '+=' ||
              n.value === '-=' ||
              n.value === '*=' ||
              n.value === '/=' ||
              n.value === '%=');
          if (!exprUse && !nameUse) return this.parseVarDecl();
          break;
        }
        // `not` is a unary operator that can lead an expression statement
        // (e.g. a switch branch `not na(x) or not na(y)`); fall through to the
        // expression-led path. Other unhandled keywords are invalid here.
        case 'not':
          break;
        default:
          this.err(`unexpected keyword '${kw}'`);
      }
    }
    // `[a, b] = expr` is a destructuring decl; a bare `[a, b, c]` (e.g. a function's
    // last-line tuple return) is a tuple-literal expression statement.
    if (this.at(TokenKind.Punct, '[') && this.isTupleDeclAhead()) return this.parseTupleDecl();
    if (this.at(TokenKind.Ident)) {
      if (this.isFuncDefAhead()) return this.parseFuncDef(false);
      if (this.isTypedDeclAhead()) return this.parseVarDecl();
    }
    // expression-led: plain decl, reassignment, or expression statement
    const expr = this.parseExpr();
    if (this.at(TokenKind.Op, '=')) {
      if (expr.kind !== 'Ident') this.err('invalid declaration target');
      this.next();
      const init = this.parseExpr();
      return { kind: 'VarDecl', mode: 'none', name: expr.name, init, loc };
    }
    const assign = this.peekAssignOp();
    if (assign) {
      this.next();
      if (expr.kind !== 'Ident' && expr.kind !== 'Member') this.err('invalid assignment target');
      const value = this.parseExpr();
      return { kind: 'Reassign', op: assign, target: expr, value, loc };
    }
    return { kind: 'ExprStmt', expr, loc } satisfies ExprStmt;
  }

  /** Consume a member/property name — an identifier or any keyword (e.g. `input.int`). */
  private expectName(): string {
    const t = this.peek();
    if (t.kind === TokenKind.Ident || t.kind === TokenKind.Keyword) return this.next().value;
    this.err('expected a name');
  }

  /** A token usable as a name (identifier or a fundamental-type keyword). */
  private isNameToken(offset = 0): boolean {
    const t = this.peek(offset);
    return (
      t.kind === TokenKind.Ident ||
      (t.kind === TokenKind.Keyword && FUND_TYPES[t.value] !== undefined)
    );
  }

  /** A token usable as a DECLARED name — `isNameToken` plus contextual keywords (`type`, …)
   *  that Pine permits as parameter/field/variable names. */
  private isDeclName(offset = 0): boolean {
    const t = this.peek(offset);
    return (
      this.isNameToken(offset) || (t.kind === TokenKind.Keyword && CONTEXTUAL_NAME_KW.has(t.value))
    );
  }

  /** Consume a declared name: an identifier or a fundamental-type keyword
   *  (Pine permits fields/vars named `color`, `int`, … — e.g. `color color`). */
  private expectNameToken(): string {
    if (!this.isNameToken()) this.err('expected a name');
    return this.next().value;
  }

  private peekAssignOp(): AssignOp | null {
    const t = this.peek();
    if (t.kind === TokenKind.Op && [':=', '+=', '-=', '*=', '/=', '%='].includes(t.value)) {
      return t.value as AssignOp;
    }
    return null;
  }

  private parseExport(): Stmt {
    this.next(); // 'export'
    if (this.atKw('type')) return this.parseTypeDef(true);
    if (this.atKw('enum')) return this.parseEnumDef(true);
    if (this.atKw('method')) {
      this.next();
      const fd = this.parseFuncDef(true);
      fd.isMethod = true;
      return fd;
    }
    if (this.at(TokenKind.Ident) && this.isFuncDefAhead()) return this.parseFuncDef(true);
    return this.parseVarDecl(true);
  }

  /** IDENT '(' ... ')' '=>'  → user function definition. */
  private isFuncDefAhead(): boolean {
    if (!this.at(TokenKind.Ident)) return false;
    if (this.peek(1).kind !== TokenKind.Punct || this.peek(1).value !== '(') return false;
    let depth = 0;
    for (let i = 1; this.pos + i < this.toks.length; i++) {
      const t = this.peek(i);
      if (t.kind === TokenKind.Punct && (t.value === '(' || t.value === '[')) depth++;
      else if (t.kind === TokenKind.Punct && (t.value === ')' || t.value === ']')) {
        depth--;
        if (depth === 0) {
          const after = this.peek(i + 1);
          return after.kind === TokenKind.Op && after.value === '=>';
        }
      } else if (t.kind === TokenKind.Eof) return false;
    }
    return false;
  }

  /** `Type name` or `coll<...> name` (two-token type-led declaration). */
  private isTypedDeclAhead(): boolean {
    if (!this.at(TokenKind.Ident)) return false;
    const n1 = this.peek(1);
    if (n1.kind === TokenKind.Ident) return true; // `Foo bar` (UDT-typed decl)
    // `Foo[] bar` — legacy array-typed decl (`[` immediately followed by `]`).
    if (
      n1.kind === TokenKind.Punct &&
      n1.value === '[' &&
      this.peek(2).kind === TokenKind.Punct &&
      this.peek(2).value === ']'
    )
      return true;
    // `array<int> x` — only collection templates precede `<`; otherwise `<` is
    // the comparison operator (e.g. `a < b` is an expression statement).
    if (n1.kind === TokenKind.Op && n1.value === '<') {
      return ['array', 'matrix', 'map'].includes(this.peek().value);
    }
    // `chart.point p` / `chart.point[] p` — qualified built-in type led decl. Require the
    // dotted chain to END in a declared NAME (a trailing `(`/`[expr]` means it's an
    // expression, e.g. `chart.point.from_index(...)`), so member-call statements aren't
    // misread as declarations. Mirrors the qualified-name branch of isTypeStart().
    if (n1.kind === TokenKind.Punct && n1.value === '.') {
      let i = 1;
      while (
        this.peek(i).kind === TokenKind.Punct &&
        this.peek(i).value === '.' &&
        this.isNameToken(i + 1)
      )
        i += 2;
      if (
        this.peek(i).kind === TokenKind.Punct &&
        this.peek(i).value === '[' &&
        this.peek(i + 1).kind === TokenKind.Punct &&
        this.peek(i + 1).value === ']'
      )
        i += 2;
      if (this.peek(i).kind === TokenKind.Ident) return true;
    }
    return false;
  }

  private parseVarDecl(isExport = false): VarDecl {
    const loc = this.loc();
    let mode: VarMode = 'none';
    if (this.atKw('var')) {
      this.next();
      mode = 'var';
    } else if (this.atKw('varip')) {
      this.next();
      mode = 'varip';
    }

    let declQual: Qualifier | undefined;
    if (this.at(TokenKind.Keyword) && QUALIFIERS[this.peek().value] !== undefined) {
      declQual = QUALIFIERS[this.next().value];
    }
    let declType: PineType | undefined;
    if (this.isTypeStart()) declType = this.parseType();

    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Op, '=');
    const init = this.parseExpr();
    return { kind: 'VarDecl', export: isExport, mode, declQual, declType, name, init, loc };
  }

  /** A statement-leading `[` is a destructuring decl iff its matching `]` is
   *  immediately followed by a single `=` (assignment, not `==`). */
  private isTupleDeclAhead(): boolean {
    let depth = 0;
    for (let i = 0; this.pos + i < this.toks.length; i++) {
      const t = this.peek(i);
      if (t.kind === TokenKind.Punct && t.value === '[') depth++;
      else if (t.kind === TokenKind.Punct && t.value === ']') {
        if (--depth === 0) {
          const after = this.peek(i + 1);
          return after.kind === TokenKind.Op && after.value === '=';
        }
      } else if (t.kind === TokenKind.Eof) return false;
    }
    return false;
  }

  private parseTupleDecl(): TupleDecl {
    const loc = this.loc();
    this.expect(TokenKind.Punct, '[');
    const names: string[] = [];
    do {
      names.push(this.expect(TokenKind.Ident).value);
    } while (this.eat(TokenKind.Punct, ','));
    this.expect(TokenKind.Punct, ']');
    this.expect(TokenKind.Op, '=');
    const init = this.parseExpr();
    return { kind: 'TupleDecl', names, init, loc };
  }

  private parseFuncDef(isExport: boolean): FuncDef {
    const loc = this.loc();
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Punct, '(');
    const params: Param[] = [];
    if (!this.at(TokenKind.Punct, ')')) {
      do {
        let declQual: Qualifier | undefined;
        let pname: string | undefined;
        // A keyword that stands ALONE as the parameter NAME — followed by ',' / ')'
        // / '=' — rather than introducing a typed/qualified param. TradingView scripts
        // name params `color`, `extend`, `type`, `series`, … (all keywords); detect this
        // first so the type/qualifier logic below doesn't swallow the name (e.g.
        // `drawPitchforkLine(chart.point start, …, color, width, style, extend)`).
        if (this.at(TokenKind.Keyword)) {
          const n1 = this.peek(1);
          const asName =
            (n1.kind === TokenKind.Punct && (n1.value === ',' || n1.value === ')')) ||
            (n1.kind === TokenKind.Op && n1.value === '=');
          if (asName) pname = this.next().value;
          // `const`/`simple`/`series` introducing a qualified param (`series int x`).
          else if (QUALIFIERS[this.peek().value] !== undefined)
            declQual = QUALIFIERS[this.next().value];
        }
        let declType: PineType | undefined;
        // a typed param: fundamental/UDT/collection type followed by the name
        // (isTypeStart already distinguishes `int len` / `Foo f` / `array<T> a`
        // from a bare untyped param `len`).
        if (pname === undefined) {
          if (this.isTypeStart()) declType = this.parseType();
          // the name may be a contextual keyword (e.g. a param literally named `type`).
          pname = this.isDeclName() ? this.next().value : this.expect(TokenKind.Ident).value;
        }
        let def: Expr | undefined;
        if (this.eat(TokenKind.Op, '=')) def = this.parseExpr();
        params.push({ name: pname, declQual, declType, default: def });
      } while (this.eat(TokenKind.Punct, ','));
    }
    this.expect(TokenKind.Punct, ')');
    this.expect(TokenKind.Op, '=>');
    const body =
      this.at(TokenKind.Newline) || this.at(TokenKind.Indent)
        ? (this.skipNewlines(), this.parseBlock())
        : this.parseStatements();
    return { kind: 'FuncDef', export: isExport, name, params, body, loc };
  }

  private parseTypeDef(isExport: boolean): TypeDef {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'type');
    const name = this.expect(TokenKind.Ident).value;
    this.skipNewlines();
    this.expect(TokenKind.Indent);
    const fields: TypeField[] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.Dedent) && !this.at(TokenKind.Eof)) {
      const varip = this.eat(TokenKind.Keyword, 'varip');
      let declType: PineType | undefined;
      // A field is `[type] name`. A type prefix is present when the type-start
      // token is followed by a name, a `<` template, a `[` (legacy `T[]` array), or a
      // `.` (qualified built-in type — `chart.point p` / `chart.point[] ps`; for the
      // dotted case isTypeStart() already verified the chain ends in a declared name).
      const n1 = this.peek(1);
      if (
        this.isTypeStart() &&
        (this.isNameToken(1) ||
          (n1.kind === TokenKind.Op && n1.value === '<') ||
          (n1.kind === TokenKind.Punct && (n1.value === '[' || n1.value === '.')))
      ) {
        declType = this.parseType();
      }
      const fname = this.expectNameToken();
      let def: Expr | undefined;
      if (this.eat(TokenKind.Op, '=')) def = this.parseExpr();
      fields.push({ name: fname, varip, declType, default: def });
      this.skipNewlines();
    }
    this.eat(TokenKind.Dedent);
    return { kind: 'TypeDef', export: isExport, name, fields, loc };
  }

  private parseEnumDef(isExport: boolean): TypeDef {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'enum');
    const name = this.expect(TokenKind.Ident).value;
    this.skipNewlines();
    this.expect(TokenKind.Indent);
    // members: `name = "title"` (title optional → the member name itself).
    const fields: TypeField[] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.Dedent) && !this.at(TokenKind.Eof)) {
      const mname = this.expect(TokenKind.Ident).value;
      let def: Expr | undefined;
      if (this.eat(TokenKind.Op, '=')) def = this.parseExpr();
      else def = { kind: 'String', value: mname, loc: this.loc() };
      fields.push({ name: mname, default: def });
      this.skipNewlines();
    }
    this.eat(TokenKind.Dedent);
    return { kind: 'TypeDef', export: isExport, name, fields, isEnum: true, loc };
  }

  private parseImport(): ImportStmt {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'import');
    const user = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Op, '/');
    const lib = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Op, '/');
    const version = this.expect(TokenKind.Int).value;
    let alias: string | undefined;
    if (this.eat(TokenKind.Keyword, 'as')) alias = this.expect(TokenKind.Ident).value;
    return { kind: 'Import', user, lib, version, alias, loc };
  }

  // ── control flow ──────────────────────────────────────────
  private parseIf(): IfNode {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'if');
    const cond = this.parseExpr();
    this.skipNewlines();
    const then = this.parseBlock();
    const elifs: { cond: Expr; body: Stmt[] }[] = [];
    let elseBody: Stmt[] | undefined;
    while (this.atKw('else')) {
      this.next();
      if (this.atKw('if')) {
        this.next();
        const c = this.parseExpr();
        this.skipNewlines();
        elifs.push({ cond: c, body: this.parseBlock() });
      } else {
        this.skipNewlines();
        elseBody = this.parseBlock();
        break;
      }
    }
    return { kind: 'If', cond, then, elifs, else: elseBody, loc };
  }

  private parseFor(): ForNode | ForInNode {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'for');
    // for [i, v] in coll  /  for v in coll
    if (this.at(TokenKind.Punct, '[')) {
      this.next();
      const indexName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Punct, ',');
      const valueName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Punct, ']');
      this.expect(TokenKind.Keyword, 'in');
      const iterable = this.parseExpr();
      this.skipNewlines();
      return { kind: 'ForIn', indexName, valueName, iterable, body: this.parseBlock(), loc };
    }
    const name = this.expect(TokenKind.Ident).value;
    if (this.eat(TokenKind.Keyword, 'in')) {
      const iterable = this.parseExpr();
      this.skipNewlines();
      return { kind: 'ForIn', valueName: name, iterable, body: this.parseBlock(), loc };
    }
    this.expect(TokenKind.Op, '=');
    const from = this.parseExpr();
    this.expect(TokenKind.Keyword, 'to');
    const to = this.parseExpr();
    let step: Expr | undefined;
    if (this.eat(TokenKind.Keyword, 'by')) step = this.parseExpr();
    this.skipNewlines();
    return { kind: 'For', varName: name, from, to, step, body: this.parseBlock(), loc };
  }

  private parseWhile(): WhileNode {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'while');
    const cond = this.parseExpr();
    this.skipNewlines();
    return { kind: 'While', cond, body: this.parseBlock(), loc };
  }

  private parseSwitch(): SwitchNode {
    const loc = this.loc();
    this.expect(TokenKind.Keyword, 'switch');
    const subject = this.at(TokenKind.Newline) ? undefined : this.parseExpr();
    this.skipNewlines();
    this.expect(TokenKind.Indent);
    const cases: SwitchNode['cases'] = [];
    this.skipNewlines();
    while (!this.at(TokenKind.Dedent) && !this.at(TokenKind.Eof)) {
      let test: Expr | undefined;
      if (!this.at(TokenKind.Op, '=>')) test = this.parseExpr();
      this.expect(TokenKind.Op, '=>');
      let body: Stmt[];
      if (this.at(TokenKind.Newline) || this.at(TokenKind.Indent)) {
        this.skipNewlines();
        body = this.parseBlock();
      } else {
        // single-line case body may be one statement (`=> x := 1`), an expression,
        // or a comma-separated series (`=> a.f(), b.g(), c := 1`).
        body = this.parseStatements();
      }
      cases.push({ test, body });
      this.skipNewlines();
    }
    this.eat(TokenKind.Dedent);
    return { kind: 'Switch', subject, cases, loc };
  }

  // ── expressions (Pratt) ───────────────────────────────────
  private parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(0);
    if (this.at(TokenKind.Op, '?')) {
      const loc = this.loc();
      this.next();
      const then = this.parseTernary();
      this.expect(TokenKind.Op, ':');
      const els = this.parseTernary();
      return { kind: 'Ternary', cond, then, else: els, loc };
    }
    return cond;
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op =
        t.kind === TokenKind.Op
          ? t.value
          : t.kind === TokenKind.Keyword && (t.value === 'and' || t.value === 'or')
            ? t.value
            : null;
      if (op === null) break;
      const prec = BIN_PREC[op];
      if (prec === undefined || prec < minPrec) break;
      const loc = this.loc();
      this.next();
      const right = this.parseBinary(prec + 1); // all binary ops are left-associative
      left = { kind: 'Binary', op: op as BinaryOp, left, right, loc };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (
      (t.kind === TokenKind.Op && (t.value === '-' || t.value === '+')) ||
      (t.kind === TokenKind.Keyword && t.value === 'not')
    ) {
      const loc = this.loc();
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.value as '-' | '+' | 'not', operand, loc };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    // A block-form `if`/`switch` expression ends at its block's DEDENT and takes no
    // postfix operators in Pine. parseBlock consumed the NL+DEDENT, so the next token
    // is the FIRST TOKEN OF THE NEXT STATEMENT — a leading `[` (tuple decl), `(`
    // (parenthesized statement), or `.` must not be misread as postfix on the
    // if-expression (spurious "expected ]" etc.).
    if (e.kind === 'If' || e.kind === 'Switch') return e;
    let typeArgs: PineType[] | undefined;
    for (;;) {
      if (this.at(TokenKind.Punct, '.')) {
        const loc = this.loc();
        this.next();
        const property = this.expectName(); // member name may be a keyword (input.int, .bool, …)
        e = { kind: 'Member', object: e, property, loc };
      } else if (this.at(TokenKind.Op, '<') && e.kind === 'Member') {
        // possible generic type args `array.new<float>(...)`; otherwise `<` is comparison
        const ta = this.tryTypeArgs();
        if (ta) {
          typeArgs = ta;
          continue;
        }
        break;
      } else if (this.at(TokenKind.Punct, '(')) {
        e = this.parseCall(e, typeArgs);
        typeArgs = undefined;
      } else if (this.at(TokenKind.Punct, '[')) {
        const loc = this.loc();
        this.next();
        const offset = this.parseExpr();
        this.expect(TokenKind.Punct, ']');
        e = { kind: 'History', base: e, offset, loc };
      } else break;
    }
    return e;
  }

  /** Tentatively parse `< Type (, Type)* > (` as generic type args; else rewind. */
  private tryTypeArgs(): PineType[] | null {
    const save = this.pos;
    try {
      this.expect(TokenKind.Op, '<');
      const types = [this.parseType()];
      while (this.eat(TokenKind.Punct, ',')) types.push(this.parseType());
      this.expect(TokenKind.Op, '>');
      if (!this.at(TokenKind.Punct, '(')) {
        this.pos = save;
        return null;
      }
      return types;
    } catch {
      this.pos = save;
      return null;
    }
  }

  private parseCall(callee: Expr, typeArgs?: PineType[]): Expr {
    const loc = this.loc();
    this.expect(TokenKind.Punct, '(');
    const args: Arg[] = [];
    if (!this.at(TokenKind.Punct, ')')) {
      do {
        if (this.at(TokenKind.Punct, ')')) break; // trailing comma tolerance
        // named argument: <name> '=' (but not '=='); the name may be a type-keyword such as
        // `color` (plot(x, color=...)) or a contextual keyword like `type` (v3 input(type=…)).
        if (this.isDeclName() && this.peek(1).kind === TokenKind.Op && this.peek(1).value === '=') {
          const name = this.next().value;
          this.next(); // '='
          args.push({ name, value: this.parseExpr() });
        } else {
          args.push({ value: this.parseExpr() });
        }
      } while (this.eat(TokenKind.Punct, ','));
    }
    this.expect(TokenKind.Punct, ')');
    return { kind: 'Call', callee, args, typeArgs, loc };
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const loc: Loc = { line: t.line, col: t.col };
    switch (t.kind) {
      case TokenKind.Int:
        this.next();
        return { kind: 'Number', value: t.literal as number, isInt: true, loc };
      case TokenKind.Float:
        this.next();
        return { kind: 'Number', value: t.literal as number, isInt: false, loc };
      case TokenKind.String:
        this.next();
        return { kind: 'String', value: t.literal as string, loc };
      case TokenKind.Bool:
        this.next();
        return { kind: 'Bool', value: t.literal as boolean, loc };
      case TokenKind.Color:
        this.next();
        return { kind: 'Color', value: t.literal as string, loc };
      case TokenKind.Na:
        this.next();
        // `na(x)` is the is-na() test function; a bare `na` is the na literal.
        if (this.at(TokenKind.Punct, '(')) return { kind: 'Ident', name: 'na', loc };
        return { kind: 'Na', loc };
      case TokenKind.Ident:
        this.next();
        return { kind: 'Ident', name: t.value, loc };
      case TokenKind.Keyword:
        if (t.value === 'if') return this.parseIf();
        if (t.value === 'switch') return this.parseSwitch();
        // a bare fundamental-type keyword used as a cast function (int(x), float(x)),
        // a qualifier keyword (const/simple/series), or a contextual keyword
        // (type/method/enum/import/export) used as a plain identifier name. The
        // statement-level forms (`type Foo`, `import …`) are dispatched before we
        // ever reach expression parsing, so here they can only be identifier refs.
        if (
          FUND_TYPES[t.value] ||
          QUALIFIERS[t.value] !== undefined ||
          CONTEXTUAL_NAME_KW.has(t.value)
        ) {
          this.next();
          return { kind: 'Ident', name: t.value, loc };
        }
        this.err(`unexpected keyword in expression '${t.value}'`);
        break;
      case TokenKind.Punct:
        if (t.value === '(') {
          this.next();
          const e = this.parseExpr();
          this.expect(TokenKind.Punct, ')');
          return e;
        }
        if (t.value === '[') return this.parseTupleLiteral();
        break;
    }
    this.err('expected an expression');
  }

  private parseTupleLiteral(): Expr {
    const loc = this.loc();
    this.expect(TokenKind.Punct, '[');
    const items: Expr[] = [];
    if (!this.at(TokenKind.Punct, ']')) {
      do {
        items.push(this.parseExpr());
      } while (this.eat(TokenKind.Punct, ','));
    }
    this.expect(TokenKind.Punct, ']');
    return { kind: 'Tuple', items, loc };
  }

  // ── types ─────────────────────────────────────────────────
  private isTypeStart(): boolean {
    const t = this.peek();
    if (t.kind === TokenKind.Keyword && FUND_TYPES[t.value]) return true;
    if (t.kind === TokenKind.Ident) {
      if (SPECIAL_TYPE_NAMES.has(t.value) || ['array', 'matrix', 'map'].includes(t.value))
        return true;
      // UDT type position: `Ident Ident` (e.g. `MyType m`).
      if (this.peek(1).kind === TokenKind.Ident) return true;
      // legacy UDT-array position: `MyType[] m`.
      if (
        this.peek(1).kind === TokenKind.Punct &&
        this.peek(1).value === '[' &&
        this.peek(2).kind === TokenKind.Punct &&
        this.peek(2).value === ']'
      )
        return true;
      // qualified type name: `chart.point lastP` — an `Ident('.'Ident)+` chain followed by
      // a name (with an optional legacy `[]` suffix). parseBaseType() consumes the dotted
      // name; here we only confirm it's a TYPE position (chain then a declared name), not a
      // bare member expression. Safe: isTypeStart is consulted only in decl/param/field slots.
      if (this.peek(1).kind === TokenKind.Punct && this.peek(1).value === '.') {
        let i = 1;
        while (
          this.peek(i).kind === TokenKind.Punct &&
          this.peek(i).value === '.' &&
          this.isNameToken(i + 1)
        )
          i += 2;
        if (
          this.peek(i).kind === TokenKind.Punct &&
          this.peek(i).value === '[' &&
          this.peek(i + 1).kind === TokenKind.Punct &&
          this.peek(i + 1).value === ']'
        )
          i += 2;
        if (this.peek(i).kind === TokenKind.Ident) return true;
      }
    }
    return false;
  }

  private parseType(): PineType {
    const base = this.parseBaseType();
    // legacy collection syntax: `T[]` ≡ `array<T>` (e.g. `box[]`, `float[]`).
    if (
      this.at(TokenKind.Punct, '[') &&
      this.peek(1).kind === TokenKind.Punct &&
      this.peek(1).value === ']'
    ) {
      this.next();
      this.next();
      return { kind: 'array', of: base };
    }
    return base;
  }

  private parseBaseType(): PineType {
    const t = this.next();
    if (t.kind === TokenKind.Keyword && FUND_TYPES[t.value]) return FUND_TYPES[t.value];
    let name = t.value;
    if (name === 'array' && this.eat(TokenKind.Op, '<')) {
      const of = this.parseType();
      this.expect(TokenKind.Op, '>');
      return { kind: 'array', of };
    }
    if (name === 'matrix' && this.eat(TokenKind.Op, '<')) {
      const of = this.parseType();
      this.expect(TokenKind.Op, '>');
      return { kind: 'matrix', of };
    }
    if (name === 'map' && this.eat(TokenKind.Op, '<')) {
      const key = this.parseType();
      this.expect(TokenKind.Punct, ',');
      const value = this.parseType();
      this.expect(TokenKind.Op, '>');
      return { kind: 'map', key, value };
    }
    // qualified built-in type name, e.g. `chart.point` (used as `array.new<chart.point>()`).
    // The element type is opaque to the runtime, so a dotted name is kept as an udt name.
    while (this.at(TokenKind.Punct, '.')) {
      this.next();
      name += `.${this.expectName()}`;
    }
    if (SPECIAL_TYPE_NAMES.has(name)) return { kind: name as PineType['kind'] } as PineType;
    return { kind: 'udt', name };
  }
}
