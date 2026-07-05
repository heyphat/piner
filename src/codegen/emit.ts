/**
 * Code generation (Phase 5a; docs/compiler-design.md §6). Annotated AST → JS
 * source for a `main($)` closure, instantiated via `new Function`. Every
 * na-propagating op and stateful builtin lowers to a `$` call so semantics live
 * in the runtime and match the interpreter exactly.
 */
import type {
  Program,
  Stmt,
  Expr,
  VarDecl,
  Reassign,
  ExprStmt,
  IfNode,
  SwitchNode,
  ForNode,
  ForInNode,
  WhileNode,
  Call,
  Member,
  Ident,
  TupleDecl,
  SymRef,
} from '../parser/ast.js';
import type { AnalyzeResult } from '../sema/analyze.js';
import type { ScriptFn } from '../engine/driver.js';
import {
  nsRuntime,
  normalizeTaArgs,
  OUTPUT_FNS,
  NOOP_FNS,
  CAST_FNS,
  MARKER_KIND,
  DATE_FNS,
  TA_VARS,
  DRAWING_CASTS,
  NS_CALL_PARAMS,
  NS_OPTS_POSITIONAL,
  STRATEGY_RISK_PARAMS,
} from './intrinsics.js';

export interface CodegenOutput {
  source: string;
  main: ScriptFn;
}

export function emit(result: AnalyzeResult): CodegenOutput {
  const e = new Emitter();
  const body = e.program(result.program, result.autoHistory);
  const source = body;
  // eslint-disable-next-line no-new-func
  const main = new Function('$', source) as ScriptFn;
  return { source, main };
}

class Emitter {
  program(p: Program, autoHistory: { slot: number; leaf: string }[]): string {
    const out: string[] = ['"use strict";'];
    // Record derived-leaf history values at the top of every bar.
    for (const { slot, leaf } of autoHistory) out.push(`$.set(${slot}, $.${leaf});`);
    for (const s of p.body) {
      const code = this.stmt(s);
      if (code) out.push(code);
    }
    return out.join('\n');
  }

  private stmt(s: Stmt): string {
    switch (s.kind) {
      case 'VarDecl':
        return this.varDecl(s);
      case 'TupleDecl':
        return this.tupleDecl(s);
      case 'Reassign':
        return this.reassign(s);
      case 'ExprStmt':
        return this.exprStmt(s);
      case 'If':
        return this.ifStmt(s);
      case 'For':
        return this.forStmt(s);
      case 'ForIn':
        return this.forInStmt(s);
      case 'While':
        return this.whileStmt(s);
      case 'Switch':
        return this.switchStmt(s);
      case 'Break':
        return 'break;';
      case 'Continue':
        return 'continue;';
      case 'FuncDef':
      case 'TypeDef':
      case 'Import':
        return ''; // not emitted in this build
    }
  }

  private historyWrite(sym: { historySlot?: number | null } | undefined, valueJs: string): string {
    return sym?.historySlot != null ? ` $.set(${sym.historySlot}, ${valueJs});` : '';
  }

  private varDecl(s: VarDecl): string {
    const sym = s.sym!;
    const init = this.expr(s.init);
    if (sym.kind === 'var' || sym.kind === 'varip') {
      const init_ = sym.kind === 'var' ? 'initVar' : 'initVarip';
      const read = sym.kind === 'var' ? 'readVar' : 'readVarip';
      const id = sym.varSlot!.id;
      let code = `$.${init_}(${id}, () => (${init}));`;
      if (sym.historySlot != null) code += ` $.set(${sym.historySlot}, $.${read}(${id}));`;
      return code;
    }
    return `let ${sym.jsName} = (${init});${this.historyWrite(sym, sym.jsName!)}`;
  }

  private tupleDecl(s: TupleDecl): string {
    const names = s.syms!.map((y) => y.jsName).join(', ');
    // guard: an `na` tuple value (e.g. an unconfirmed request.security) → all-na
    let code = `let [${names}] = ((__t) => Array.isArray(__t) ? __t : [])(${this.expr(s.init)});`;
    for (const y of s.syms!)
      if (y.historySlot != null) code += ` $.set(${y.historySlot}, ${y.jsName});`;
    return code;
  }

  private reassign(s: Reassign): string {
    const sym = s.sym;
    const valueJs = this.compound(s.op, s.target, s.value);
    if (s.target.kind === 'Member') {
      // Direct write — member() reads use `?.`, which is illegal on an assignment target.
      return `(${this.expr(s.target.object)}).${s.target.property} = (${valueJs});`;
    }
    if (sym && (sym.kind === 'var' || sym.kind === 'varip')) {
      const set = sym.kind === 'var' ? 'setVar' : 'setVarip';
      let code = `$.${set}(${sym.varSlot!.id}, (${valueJs}));`;
      if (sym.historySlot != null) {
        const read = sym.kind === 'var' ? 'readVar' : 'readVarip';
        code += ` $.set(${sym.historySlot}, $.${read}(${sym.varSlot!.id}));`;
      }
      return code;
    }
    const name = sym?.jsName ?? (s.target as Ident).name;
    return `${name} = (${valueJs});${this.historyWrite(sym ?? undefined, name)}`;
  }

  /** Resolve `x += y` etc. into the equivalent na-propagating value expression. */
  private compound(op: string, target: Ident | Member, value: Expr): string {
    const cur = this.expr(target);
    const v = this.expr(value);
    switch (op) {
      case ':=':
        return v;
      case '+=':
        return `$.add(${cur}, ${v})`;
      case '-=':
        return `$.sub(${cur}, ${v})`;
      case '*=':
        return `$.mul(${cur}, ${v})`;
      case '/=':
        return `$.div(${cur}, ${v})`;
      case '%=':
        return `$.mod(${cur}, ${v})`;
      default:
        return v;
    }
  }

  private exprStmt(s: ExprStmt): string {
    const code = this.expr(s.expr);
    return code ? `${code};` : '';
  }

  // ── control flow as statements ────────────────────────────
  private ifStmt(s: IfNode): string {
    let code = `if ($.toBool(${this.expr(s.cond)})) {\n${this.block(s.then)}\n}`;
    for (const el of s.elifs)
      code += ` else if ($.toBool(${this.expr(el.cond)})) {\n${this.block(el.body)}\n}`;
    if (s.else) code += ` else {\n${this.block(s.else)}\n}`;
    return code;
  }
  private forStmt(s: ForNode): string {
    const v = s.varSym!.jsName!;
    // Pine fixes the bound and step at entry (evaluated exactly once) and derives
    // DIRECTION from from/to: `for i = n to 0` counts DOWN, and an explicit `by k`
    // gives the step MAGNITUDE (so `10 to 0 by 2` → 10,8,…,0 — a negative step is
    // never required). Hoist from/to/step into temporaries to match the interpreter.
    const fromJs = this.expr(s.from);
    const toJs = this.expr(s.to);
    const magJs = s.step ? `Math.abs(${this.expr(s.step)})` : '1';
    return (
      `{ const __from_${v} = (${fromJs}); const __to_${v} = (${toJs}); ` +
      `const __up_${v} = __from_${v} <= __to_${v}; const __step_${v} = (__up_${v} ? 1 : -1) * (${magJs}); ` +
      `for (let ${v} = __from_${v}; __up_${v} ? ${v} <= __to_${v} : ${v} >= __to_${v}; ${v} += __step_${v}) {\n$.consumeLoopIteration();\n${this.block(s.body)}\n} }`
    );
  }
  private forInStmt(s: ForInNode): string {
    const val = s.valueSym!.jsName!;
    // `?? []` mirrors the interpreter: an `na`/undefined iterable (e.g. a
    // destructured binding from an unconfirmed `request.security` tuple) loops
    // zero times rather than throwing on `for…of undefined`.
    const iter = `(${this.expr(s.iterable)} ?? [])`;
    if (s.indexSym) {
      const idx = s.indexSym.jsName!;
      // Increment at the TOP so a `continue` in the body can't skip it (index = element position).
      return `{ let ${idx} = -1; for (const ${val} of ${iter}) { ${idx}++; $.consumeLoopIteration();\n${this.block(s.body)}\n} }`;
    }
    return `for (const ${val} of ${iter}) {\n$.consumeLoopIteration();\n${this.block(s.body)}\n}`;
  }
  private whileStmt(s: WhileNode): string {
    return `while ($.toBool(${this.expr(s.cond)})) {\n$.consumeLoopIteration();\n${this.block(s.body)}\n}`;
  }
  private switchStmt(s: SwitchNode): string {
    // Statement form must NOT lower to the IIFE (switchExpr): a `break`/`continue`
    // in a case body targets the enclosing Pine loop, which is illegal inside an
    // arrow function. Lower to a plain if/else chain instead.
    const parts: string[] = [];
    let defaultBody: string | null = null;
    for (const c of s.cases) {
      const body = this.block(c.body);
      if (!c.test) {
        defaultBody = body;
        continue;
      }
      const cond = s.subject
        ? `$.eq(__subj, (${this.expr(c.test)}))`
        : `$.toBool(${this.expr(c.test)})`;
      parts.push(`if (${cond}) {\n${body}\n}`);
    }
    const chain = parts.length
      ? parts.join(' else ') + (defaultBody !== null ? ` else {\n${defaultBody}\n}` : '')
      : (defaultBody ?? '');
    return s.subject ? `{ const __subj = (${this.expr(s.subject)});\n${chain} }` : `{ ${chain} }`;
  }

  private block(body: Stmt[]): string {
    return body
      .map((b) => this.stmt(b))
      .filter(Boolean)
      .join('\n');
  }

  /** Read expression for a resolved symbol (var/varip slot or plain local). */
  private readSym(sym: SymRef): string {
    if (sym.kind === 'var') return `$.readVar(${sym.varSlot!.id})`;
    if (sym.kind === 'varip') return `$.readVarip(${sym.varSlot!.id})`;
    return sym.jsName!;
  }

  /**
   * Emit a block as an expression. The block's value is its last statement's
   * value: a trailing expression, OR the assigned value of a trailing
   * declaration/reassignment (Pine returns the last statement's value).
   */
  private blockValue(body: Stmt[]): string {
    const lines: string[] = [];
    for (let i = 0; i < body.length - 1; i++) {
      const code = this.stmt(body[i]);
      if (code) lines.push(code);
    }
    const last = body[body.length - 1];
    if (last) {
      if (last.kind === 'ExprStmt') {
        lines.push(`return (${this.expr(last.expr)});`);
        return lines.join('\n');
      }
      if (last.kind === 'VarDecl' && last.sym) {
        const c = this.stmt(last);
        if (c) lines.push(c);
        lines.push(`return (${this.readSym(last.sym)});`);
        return lines.join('\n');
      }
      if (last.kind === 'Reassign' && last.target.kind === 'Ident' && last.sym) {
        const c = this.stmt(last);
        if (c) lines.push(c);
        lines.push(`return (${this.readSym(last.sym)});`);
        return lines.join('\n');
      }
      // `if`/`switch` are EXPRESSIONS in Pine — a trailing one is the block's value (e.g. a UDF
      // whose body is a `switch`). Return its expression form, not run it as a side-effect stmt.
      if (last.kind === 'If' || last.kind === 'Switch') {
        lines.push(`return (${this.expr(last)});`);
        return lines.join('\n');
      }
      const c = this.stmt(last);
      if (c) lines.push(c);
    }
    lines.push('return $.NA;');
    return lines.join('\n');
  }

  // ── expressions ───────────────────────────────────────────
  private expr(e: Expr): string {
    switch (e.kind) {
      case 'Number':
        return String(e.value);
      case 'String':
        return JSON.stringify(e.value);
      case 'Bool':
        return e.value ? 'true' : 'false';
      case 'Color':
        return `$.colorLit(${JSON.stringify(e.value)})`;
      case 'Na':
        return '$.NA';
      case 'Ident':
        return this.ident(e);
      case 'Member':
        return this.member(e);
      case 'History': {
        if (e.historySlot == null) return '$.NA';
        const off = this.expr(e.offset);
        // inline-expr history: write this bar's value into the slot, then read offset-back.
        if (e.historyExpr)
          return `($.set(${e.historySlot}, (${this.expr(e.base)})), $.get(${e.historySlot}, (${off})))`;
        return `$.get(${e.historySlot}, (${off}))`;
      }
      case 'Unary':
        return e.op === 'not'
          ? `$.not(${this.expr(e.operand)})`
          : e.op === '-'
            ? `$.neg(${this.expr(e.operand)})`
            : `(${this.expr(e.operand)})`;
      case 'Binary':
        return this.binary(e);
      case 'Ternary':
        return `($.toBool(${this.expr(e.cond)}) ? (${this.expr(e.then)}) : (${this.expr(e.else)}))`;
      case 'Call':
        return this.call(e);
      case 'Tuple':
        return `[${e.items.map((it) => this.expr(it)).join(', ')}]`;
      case 'If':
        return `(() => {\n${this.ifExprBody(e)}\n})()`;
      case 'Switch':
        return this.switchExpr(e);
      case 'For':
      case 'ForIn':
      case 'While':
        return '$.NA'; // loop-as-value yield not supported in this build
    }
  }

  private ifExprBody(s: IfNode): string {
    let code = `if ($.toBool(${this.expr(s.cond)})) {\n${this.blockValue(s.then)}\n}`;
    for (const el of s.elifs)
      code += ` else if ($.toBool(${this.expr(el.cond)})) {\n${this.blockValue(el.body)}\n}`;
    if (s.else) code += ` else {\n${this.blockValue(s.else)}\n}`;
    code += '\nreturn $.NA;';
    return code;
  }

  private switchExpr(s: SwitchNode): string {
    const subj = s.subject ? this.expr(s.subject) : null;
    const parts: string[] = [];
    let defaultBody = 'return $.NA;';
    for (const c of s.cases) {
      const body = this.blockValue(c.body);
      if (!c.test) {
        defaultBody = body;
        continue;
      }
      const cond =
        subj !== null ? `$.eq(__subj, (${this.expr(c.test)}))` : `$.toBool(${this.expr(c.test)})`;
      parts.push(`if (${cond}) {\n${body}\n}`);
    }
    const head = subj !== null ? `const __subj = (${subj});\n` : '';
    return `(() => {\n${head}${parts.join(' else ')}\n${defaultBody}\n})()`;
  }

  private ident(e: Ident): string {
    const sym = e.sym!;
    switch (sym.kind) {
      case 'builtin-series':
        return `$.${sym.name}`;
      case 'var':
        return `$.readVar(${sym.varSlot!.id})`;
      case 'varip':
        return `$.readVarip(${sym.varSlot!.id})`;
      case 'plain':
      case 'param':
        return sym.jsName!;
      case 'builtin-ns':
        return `$.${nsRuntime(sym.name) ?? sym.name}`;
      default:
        return '$.NA';
    }
  }

  private member(e: Member): string {
    if (e.constExpr) return this.expr(e.constExpr); // resolved enum member
    // strategy.closedtrades.first_index / strategy.opentrades.capital_held — bare scalar stats.
    if (
      e.object.kind === 'Member' &&
      e.object.object.kind === 'Ident' &&
      e.object.object.sym?.kind === 'builtin-ns' &&
      e.object.object.name === 'strategy' &&
      (e.object.property === 'closedtrades' || e.object.property === 'opentrades')
    ) {
      return `$.strategy.tradeStat(${JSON.stringify(e.object.property)}, ${JSON.stringify(e.property)})`;
    }
    if (e.object.kind === 'Ident' && e.object.sym?.kind === 'builtin-ns') {
      // no-paren stateful ta variable (`ta.tr`) → a site-keyed call.
      if (e.object.name === 'ta' && TA_VARS.has(e.property))
        return `$.ta.${e.property}(${e.stateSite ?? 0})`;
      const rt = nsRuntime(e.object.name) ?? e.object.name;
      return `$.${rt}.${e.property}`;
    }
    // `?.` matches the interpreter: field access on an na/undefined object yields
    // undefined (na) rather than a raw TypeError (e.g. UDT tuple from an
    // unconfirmed request.security).
    return `(${this.expr(e.object)})?.${e.property}`;
  }

  private binary(e: Extract<Expr, { kind: 'Binary' }>): string {
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    switch (e.op) {
      // v6: bools cannot hold na — na coerces to false. Lazy RHS preserved by &&/||.
      case 'and':
        return `($.toBool(${l}) && $.toBool(${r}))`;
      case 'or':
        return `($.toBool(${l}) || $.toBool(${r}))`;
      case '==':
        return `$.eq(${l}, ${r})`;
      case '!=':
        return `$.ne(${l}, ${r})`;
      case '<':
        return `$.lt(${l}, ${r})`;
      case '<=':
        return `$.le(${l}, ${r})`;
      case '>':
        return `$.gt(${l}, ${r})`;
      case '>=':
        return `$.ge(${l}, ${r})`;
      case '+':
        return e.type?.kind === 'string' ? `$.concat(${l}, ${r})` : `$.add(${l}, ${r})`;
      case '-':
        return `$.sub(${l}, ${r})`;
      case '*':
        return `$.mul(${l}, ${r})`;
      case '/':
        return `$.div(${l}, ${r})`;
      case '%':
        return `$.mod(${l}, ${r})`;
    }
  }

  private call(e: Call): string {
    const callee = e.callee;
    // UDT constructor `T.new(...)` → an object literal of its fields.
    if (e.udtFields) return this.udtNew(e);
    // namespace call: ns.fn(args)
    if (
      callee.kind === 'Member' &&
      callee.object.kind === 'Ident' &&
      callee.object.sym?.kind === 'builtin-ns'
    ) {
      const ns = callee.object.name;
      const fn = callee.property;
      const rt = nsRuntime(ns) ?? ns;
      if (ns === 'ta' || (ns === 'math' && fn === 'sum')) {
        let valueArgs = normalizeTaArgs(
          fn,
          e.args.map((a) => this.expr(a.value)),
          '1',
          '0',
        );
        // pivothigh/pivotlow have a 2-arg (left,right) form using high/low implicitly
        if ((fn === 'pivothigh' || fn === 'pivotlow') && valueArgs.length === 2) {
          valueArgs = [fn === 'pivothigh' ? '$.high' : '$.low', ...valueArgs];
        }
        // highest/lowest(bars) have a 1-arg (length) form defaulting source to high/low
        if ((fn === 'highest' || fn === 'highestbars') && valueArgs.length === 1)
          valueArgs = ['$.high', ...valueArgs];
        if ((fn === 'lowest' || fn === 'lowestbars') && valueArgs.length === 1)
          valueArgs = ['$.low', ...valueArgs];
        const all = [...valueArgs, String(e.stateSite ?? 0)];
        return `$.ta.${fn}(${all.join(', ')})`;
      }
      if (ns === 'input') {
        const defval = this.namedArg(e, 'defval') ?? e.args.filter((a) => !a.name)[0]?.value;
        return `$.input.${fn}(${JSON.stringify(e.inputKey ?? '')}, ${defval ? `(${this.expr(defval)})` : 'undefined'})`;
      }
      if (ns === 'request' && fn === 'security') {
        const pos = e.args.filter((a) => !a.name).map((a) => a.value);
        const sym = this.expr(this.namedArg(e, 'symbol') ?? pos[0]);
        const tf = this.expr(this.namedArg(e, 'timeframe') ?? pos[1]);
        const exprNode = this.namedArg(e, 'expression') ?? pos[2];
        const la = this.namedArg(e, 'lookahead') ?? pos[4];
        // Sub-context rebinds `$` to the HTF context; plain locals/inputs are
        // captured from the surrounding main scope.
        return `$.security(${e.securitySite ?? 0}, (${sym}), (${tf}), ${la ? `(${this.expr(la)})` : 'false'}, (__s) => { const $ = __s; return (${this.expr(exprNode)}); })`;
      }
      if (ns === 'request' && fn === 'security_lower_tf') {
        const lpos = e.args.filter((a) => !a.name).map((a) => a.value);
        const lsym = this.expr(this.namedArg(e, 'symbol') ?? lpos[0]);
        const ltf = this.expr(this.namedArg(e, 'timeframe') ?? lpos[1]);
        const lexpr = this.namedArg(e, 'expression') ?? lpos[2];
        return `$.securityLowerTf(${e.securitySite ?? 0}, (${lsym}), (${ltf}), (__s) => { const $ = __s; return (${this.expr(lexpr)}); })`;
      }
      if (ns === 'strategy') return this.strategyCall(fn, e);
      // syminfo.prefix(tickerid) / syminfo.ticker(tickerid) — function form (the
      // bare `syminfo.prefix` member stays the chart's prefix string).
      if (ns === 'syminfo' && (fn === 'prefix' || fn === 'ticker')) {
        const arg = e.args.filter((a) => !a.name)[0]?.value;
        return `$.syminfoParse(${JSON.stringify(fn)}, ${arg ? `(${this.expr(arg)})` : 'undefined'})`;
      }
      return `$.${rt}.${fn}(${this.nsArgs(e, NS_CALL_PARAMS[`${ns}.${fn}`], NS_OPTS_POSITIONAL[`${ns}.${fn}`])})`;
    }
    // two-level namespace: chart.point.new(...) → $.chart.point.new(...)
    if (
      callee.kind === 'Member' &&
      callee.object.kind === 'Member' &&
      callee.object.object.kind === 'Ident' &&
      callee.object.object.sym?.kind === 'builtin-ns'
    ) {
      // strategy.closedtrades.X(i) / strategy.opentrades.X(i) → per-trade introspection.
      if (callee.object.object.name === 'strategy') {
        const scope = callee.object.property;
        if (scope === 'closedtrades' || scope === 'opentrades') {
          const i = e.args.filter((a) => !a.name)[0]?.value;
          return `$.strategy.tradeField(${JSON.stringify(scope)}, ${JSON.stringify(callee.property)}, ${i ? `(${this.expr(i)})` : '0'})`;
        }
        // strategy.risk.X(...) → the broker's risk-rule setters.
        if (scope === 'risk' && STRATEGY_RISK_PARAMS[callee.property]) {
          return `$.strategy.risk.${callee.property}(${this.nsArgs(e, STRATEGY_RISK_PARAMS[callee.property])})`;
        }
        return '$.NA'; // other strategy.* sub-objects not modeled
      }
      const rt = nsRuntime(callee.object.object.name) ?? callee.object.object.name;
      return `$.${rt}.${callee.object.property}.${callee.property}(${this.nsArgs(e)})`;
    }
    // method-call form: recv.method(args) → runtime dispatch by receiver shape. Named args
    // bundle into a trailing opts object (nsArgs no-sig) so styling on setters / table.cell
    // (e.g. `t.cell(c, r, txt, text_color = …, bgcolor = …)`) reaches the runtime's `opts`
    // instead of being flattened into positionals (which corrupted the opts bag).
    if (callee.kind === 'Member') {
      return `$.method((${this.expr(callee.object)}), ${JSON.stringify(callee.property)}, [${this.nsArgs(e)}])`;
    }
    // bare function call
    if (callee.kind === 'Ident') {
      return this.globalCall(callee.name, e);
    }
    return '$.NA';
  }

  /** UDT constructor: build `{field: value}` mapping positional args by order and
   *  named args by name, falling back to each field's default (else na). */
  private udtNew(e: Call): string {
    const pos = e.args.filter((a) => !a.name);
    const named = new Map(e.args.filter((a) => a.name).map((a) => [a.name, a.value] as const));
    const assignments = e.udtFields!.map((f, i) => {
      const v = named.get(f.name) ?? pos[i]?.value ?? f.default;
      return `__o[${JSON.stringify(f.name)}] = ${v ? `(${this.expr(v)})` : '$.NA'};`;
    });
    return `(() => { const __o = Object.create(null); ${assignments.join(' ')} return __o; })()`;
  }

  /** Namespace-call arguments: positional in order, then named bundled into a
   *  trailing options object (so builtins like line.new bind named style args).
   *  When `sig` (ordered positional param names) is given, named args matching a
   *  positional param slot into that position and only the REST go to opts — so a
   *  fully/partially named constructor (box.new(left=.., top=..)) binds correctly. */
  private nsArgs(e: Call, coords?: readonly string[], optsPos?: readonly string[]): string {
    if (coords) {
      const named = new Map(e.args.filter((a) => a.name).map((a) => [a.name!, a.value] as const));
      const positionalArgs = e.args.filter((a) => !a.name);
      const slots: ((typeof e.args)[number]['value'] | undefined)[] = [];
      for (let i = 0; i < coords.length; i++) slots[i] = positionalArgs[i]?.value; // coord slots
      coords.forEach((pname, i) => {
        const v = named.get(pname);
        if (v !== undefined) slots[i] = v;
      }); // a coord passed by name
      // Everything else → the trailing opts bag: extra POSITIONAL args keyed by their Pine
      // param name (optsPos), then NAMED args that aren't coords.
      const opts: [string, Expr][] = [];
      for (let i = coords.length; i < positionalArgs.length; i++) {
        const pname = optsPos?.[i - coords.length];
        if (pname) opts.push([pname, positionalArgs[i].value]);
      }
      for (const a of e.args) if (a.name && !coords.includes(a.name)) opts.push([a.name, a.value]);
      // Pad coord slots up to coords.length when an opts bag exists so it lands in the
      // runtime's trailing `opts` parameter, not a skipped middle positional.
      const span = opts.length ? Math.max(slots.length, coords.length) : slots.length;
      const out: string[] = [];
      for (let i = 0; i < span; i++)
        out.push(slots[i] !== undefined ? `(${this.expr(slots[i]!)})` : 'undefined');
      if (opts.length)
        out.push(`{${opts.map(([k, v]) => `${JSON.stringify(k)}: (${this.expr(v)})`).join(', ')}}`);
      return out.join(', ');
    }
    const positional = e.args.filter((a) => !a.name).map((a) => `(${this.expr(a.value)})`);
    const named = e.args.filter((a) => a.name);
    if (named.length) {
      positional.push(
        `{${named.map((a) => `${JSON.stringify(a.name)}: (${this.expr(a.value)})`).join(', ')}}`,
      );
    }
    return positional.join(', ');
  }

  private globalCall(name: string, e: Call): string {
    if (NOOP_FNS.has(name)) return '';
    if (name === 'max_bars_back') return ''; // lookback hint; piner keeps full history → noop
    if (OUTPUT_FNS.has(name)) return this.outputCall(name, e);
    const args = e.args.map((a) => this.expr(a.value));
    // type-cast to a drawing/UDT-handle type: identity (an id is already that type).
    if (DRAWING_CASTS.has(name)) return args[0] ?? '$.NA';
    if (name === 'fixnan') return `$.fixnan(${args[0] ?? '$.NA'}, ${e.stateSite ?? 0})`;
    if (name === 'input') {
      const defval = this.namedArg(e, 'defval') ?? e.args.filter((a) => !a.name)[0]?.value;
      return `$.input.auto(${JSON.stringify(e.inputKey ?? '')}, ${defval ? `(${this.expr(defval)})` : 'undefined'})`;
    }
    if (name === 'timestamp') return `$.timestamp(${args.join(', ')})`;
    if (name === 'time') return `$.timeFn(${args.join(', ')})`;
    if (name === 'time_close') return `$.timeCloseFn(${args.join(', ')})`;
    if (name === 'nz')
      return `$.nz(${args[0] ?? '$.NA'}${args[1] !== undefined ? `, ${args[1]}` : ''})`;
    if (name === 'na') return `$.na(${args[0] ?? '$.NA'})`;
    if (name === 'alert') return `$.alert(${args[0] ?? '""'})`;
    if (name === 'alertcondition') {
      const cond = this.expr(this.arg(e, 0, 'condition') ?? e.args[0].value);
      const title = this.arg(e, 1, 'title');
      const msg = this.arg(e, 2, 'message');
      // Pass `undefined` (not "") for an absent title/message so the runtime's
      // `message ?? title ?? 'alert'` fallback works (`"" ?? x` would keep the empty string).
      return `$.alertcondition((${cond}), ${title ? this.expr(title) : 'undefined'}, ${msg ? this.expr(msg) : 'undefined'})`;
    }
    if (CAST_FNS[name]) return `$.${CAST_FNS[name]}(${args[0] ?? '$.NA'})`;
    if (DATE_FNS.has(name)) return `$.dateAt(${JSON.stringify(name)}, ${args[0] ?? '$.NA'})`;
    return '$.NA';
  }

  private arg(e: Call, index: number, name: string): Expr | undefined {
    const named = e.args.find((a) => a.name === name);
    if (named) return named.value;
    // positional fallback among unnamed args
    const positional = e.args.filter((a) => !a.name);
    return positional[index]?.value;
  }

  private namedArg(e: Call, name: string): Expr | undefined {
    return e.args.find((a) => a.name === name)?.value;
  }
  /** Object literal of named args excluding the given keys (static plot options). */
  private optsObject(e: Call, exclude: string[]): string {
    const named = e.args.filter((a) => a.name && !exclude.includes(a.name));
    if (!named.length) return '{}';
    return `{${named.map((a) => `${JSON.stringify(a.name)}: (${this.expr(a.value)})`).join(', ')}}`;
  }

  private outputCall(name: string, e: Call): string {
    const id = e.outputId ?? 0;
    const pos = e.args.filter((a) => !a.name).map((a) => a.value);
    const ex = (x?: Expr) => (x ? `(${this.expr(x)})` : 'undefined');
    const title = () => {
      const t = this.namedArg(e, 'title');
      return t ? this.expr(t) : JSON.stringify(`${name} ${id}`);
    };
    const color = () => ex(this.namedArg(e, 'color'));

    switch (name) {
      case 'plot': {
        // Pine: plot(series, title, color, …) — title is pos[1], color is pos[2].
        const titleExpr = this.namedArg(e, 'title') ?? pos[1];
        const titleJs = titleExpr ? this.expr(titleExpr) : JSON.stringify(`plot ${id}`);
        return `$.plot(${id}, ${ex(this.namedArg(e, 'series') ?? pos[0])}, ${ex(this.namedArg(e, 'color') ?? pos[2])}, ${titleJs}, ${this.optsObject(e, ['series', 'title', 'color'])})`;
      }
      case 'plotshape':
      case 'plotchar':
      case 'plotarrow': {
        // Bind by name with Pine's documented POSITIONAL fallback (most scripts call these
        // positionally) — otherwise title/style/location/color/text silently default and the
        // marker renders unstyled at the wrong side. Signatures differ per function:
        //   plotshape(series, title, style, location, color, offset, text, …)
        //   plotchar (series, title, char,  location, color, offset, text, …)
        //   plotarrow(series, title, colorup, colordown, offset, …)  — no style/location/char
        const series = ex(this.namedArg(e, 'series') ?? pos[0]);
        const titleExpr = this.namedArg(e, 'title') ?? pos[1];
        const titleJs = titleExpr ? this.expr(titleExpr) : JSON.stringify(`${name} ${id}`);
        if (name === 'plotarrow') {
          return `$.marker(${id}, ${series}, ${ex(this.namedArg(e, 'colorup') ?? pos[2])}, undefined, ${titleJs}, 'abovebar', '', ${JSON.stringify(MARKER_KIND[name])})`;
        }
        const glyph = ex(
          name === 'plotchar'
            ? (this.namedArg(e, 'char') ?? pos[2])
            : (this.namedArg(e, 'style') ?? pos[2]),
        );
        const loc = ex(this.namedArg(e, 'location') ?? pos[3]);
        const markerColor = ex(this.namedArg(e, 'color') ?? pos[4]);
        const text = ex(this.namedArg(e, 'text') ?? pos[6]);
        return `$.marker(${id}, ${series}, ${markerColor}, ${text}, ${titleJs}, (${loc} ?? 'abovebar'), (${glyph} ?? ''), ${JSON.stringify(MARKER_KIND[name])})`;
      }
      case 'plotcandle':
      case 'plotbar':
        return (
          `$.plotcandle(${id}, ${ex(this.namedArg(e, 'open') ?? pos[0])}, ${ex(this.namedArg(e, 'high') ?? pos[1])}, ` +
          `${ex(this.namedArg(e, 'low') ?? pos[2])}, ${ex(this.namedArg(e, 'close') ?? pos[3])}, ${color()}, ` +
          `${ex(this.namedArg(e, 'wickcolor'))}, ${ex(this.namedArg(e, 'bordercolor'))}, ${title()})`
        );
      case 'hline':
        return `$.hline(${id}, ${ex(this.namedArg(e, 'price') ?? pos[0])}, ${title()})`;
      case 'fill': {
        const p1 = ex(this.namedArg(e, 'plot1') ?? pos[0]);
        const p2 = ex(this.namedArg(e, 'plot2') ?? pos[1]);
        // Two overloads share a prefix: fill(plot1, plot2, color, …) vs the gradient
        // fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color, …). Since
        // args are commonly positional, named keys alone can't tell them apart — disambiguate
        // by shape: a numeric 3rd arg (the color form's 3rd arg is always a color) or a
        // present 5th+6th positional arg marks the gradient overload.
        const tv = this.namedArg(e, 'top_value'),
          bv = this.namedArg(e, 'bottom_value');
        const tc = this.namedArg(e, 'top_color'),
          bc = this.namedArg(e, 'bottom_color');
        const top = pos[2]?.type?.kind;
        const isGradient =
          !!(tv || bv || tc || bc) || top === 'int' || top === 'float' || !!(pos[4] && pos[5]);
        if (isGradient) {
          return `$.fillGradient(${id}, ${p1}, ${p2}, ${ex(tv ?? pos[2])}, ${ex(bv ?? pos[3])}, ${ex(tc ?? pos[4])}, ${ex(bc ?? pos[5])}, ${title()})`;
        }
        return `$.fill(${id}, ${p1}, ${p2}, ${ex(this.namedArg(e, 'color') ?? pos[2])}, ${title()})`;
      }
      case 'bgcolor':
        return `$.bgcolor(${id}, ${ex(this.namedArg(e, 'color') ?? pos[0])})`;
      case 'barcolor':
        return `$.barcolor(${id}, ${ex(this.namedArg(e, 'color') ?? pos[0])})`;
    }
    return '$.NA';
  }

  /**
   * strategy.* order calls → `$.strategy.<fn>(...)`. Args are bound by name with a
   * positional fallback at Pine's documented index, so both call styles work; the
   * trailing `when` gate (named-only) is forwarded for conditional submission.
   */
  private strategyCall(fn: string, e: Call): string {
    const ex = (x?: Expr) => (x ? `(${this.expr(x)})` : 'undefined');
    const when = () => ex(this.namedArg(e, 'when'));
    switch (fn) {
      case 'entry':
      case 'order':
        return (
          `$.strategy.${fn}(${ex(this.arg(e, 0, 'id'))}, ${ex(this.arg(e, 1, 'direction'))}, ` +
          `${ex(this.arg(e, 2, 'qty'))}, ${ex(this.arg(e, 3, 'limit'))}, ${ex(this.arg(e, 4, 'stop'))}, ${when()})`
        );
      case 'close':
        return `$.strategy.close(${ex(this.arg(e, 0, 'id'))}, ${ex(this.namedArg(e, 'qty'))}, ${when()})`;
      case 'close_all':
        return `$.strategy.close_all(${when()})`;
      case 'exit':
        return (
          `$.strategy.exit(${ex(this.arg(e, 0, 'id'))}, ${ex(this.arg(e, 1, 'from_entry'))}, ` +
          `${ex(this.arg(e, 2, 'qty'))}, ${ex(this.arg(e, 4, 'profit'))}, ${ex(this.arg(e, 6, 'loss'))}, ` +
          `${ex(this.arg(e, 7, 'stop'))}, ${ex(this.arg(e, 5, 'limit'))}, ` +
          `${ex(this.arg(e, 8, 'trail_price'))}, ${ex(this.arg(e, 9, 'trail_points'))}, ${ex(this.arg(e, 10, 'trail_offset'))}, ${when()})`
        );
      case 'cancel':
        return `$.strategy.cancel(${ex(this.arg(e, 0, 'id'))}, ${when()})`;
      case 'cancel_all':
        return `$.strategy.cancel_all(${when()})`;
      // single-currency build: currency conversions are identity passthroughs.
      case 'convert_to_account':
      case 'convert_to_symbol':
        return ex(this.arg(e, 0, 'value'));
      case 'default_entry_qty':
        return `$.strategy.default_entry_qty(${ex(this.arg(e, 0, 'fill_price'))})`;
    }
    // Other strategy.* helpers (risk.*, account-info fns, …) aren't modeled yet.
    // Return na rather than '' so the call is still a valid JS expression
    // (e.g. `plot(strategy.foo(...))` must not emit `plot(())`).
    return '$.NA';
  }
}
