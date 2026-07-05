/**
 * AST interpreter (Phase 5b; docs/compiler-design.md §7). Walks the annotated AST
 * making the SAME sequence of `$` calls as the generated JS, so the two backends
 * produce identical per-bar output. The interpreter is the auditable oracle.
 */
import type {
  Program,
  Stmt,
  Expr,
  IfNode,
  SwitchNode,
  ForNode,
  ForInNode,
  WhileNode,
  Call,
  Member,
  Ident,
  Reassign,
} from '../parser/ast.js';
import type { AnalyzeResult } from '../sema/analyze.js';
import type { ExecutionContext } from '../runtime/context.js';
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
} from '../codegen/intrinsics.js';

/** Compile the annotated program into a per-bar ScriptFn driven by the interpreter. */
export function makeInterpreted(result: AnalyzeResult): ($: ExecutionContext) => void {
  const program = result.program;
  const autoHistory = result.autoHistory;
  return ($: ExecutionContext) => new Interp($, program, autoHistory).run();
}

/** Sentinel return value for break/continue propagation in loops. */
const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');

class Interp {
  private env = new Map<string, unknown>();
  private ctx: any;
  constructor(
    private $: ExecutionContext,
    private program: Program,
    private autoHistory: { slot: number; leaf: string }[],
  ) {
    this.ctx = $;
  }

  run(): void {
    for (const { slot, leaf } of this.autoHistory) this.$.set(slot, this.ctx[leaf]);
    for (const s of this.program.body) this.stmt(s);
  }

  private stmt(s: Stmt): typeof BREAK | typeof CONTINUE | void {
    switch (s.kind) {
      case 'VarDecl': {
        const sym = s.sym!;
        if (sym.kind === 'var' || sym.kind === 'varip') {
          const id = sym.varSlot!.id;
          if (sym.kind === 'var') this.$.initVar(id, () => this.expr(s.init));
          else this.$.initVarip(id, () => this.expr(s.init));
          if (sym.historySlot != null) {
            this.$.set(
              sym.historySlot,
              (sym.kind === 'var' ? this.$.readVar(id) : this.$.readVarip(id)) as number,
            );
          }
        } else {
          const v = this.expr(s.init);
          this.env.set(sym.jsName!, v);
          if (sym.historySlot != null) this.$.set(sym.historySlot, v as number);
        }
        return;
      }
      case 'TupleDecl': {
        const raw = this.expr(s.init);
        const v = (Array.isArray(raw) ? raw : []) as unknown[]; // na tuple → all-na
        s.syms!.forEach((sym, i) => {
          this.env.set(sym.jsName!, v[i]);
          if (sym.historySlot != null) this.$.set(sym.historySlot, v[i] as number);
        });
        return;
      }
      case 'Reassign':
        return void this.reassign(s);
      case 'ExprStmt': {
        this.expr(s.expr);
        return;
      }
      case 'If':
        return this.ifStmt(s);
      case 'For':
        return this.forStmt(s);
      case 'ForIn':
        return this.forInStmt(s);
      case 'While':
        return this.whileStmt(s);
      case 'Switch': {
        const r = this.switchValue(s);
        return r === BREAK || r === CONTINUE ? r : undefined;
      }
      case 'Break':
        return BREAK;
      case 'Continue':
        return CONTINUE;
      case 'FuncDef':
      case 'TypeDef':
      case 'Import':
        return;
    }
  }

  private reassign(s: Reassign): void {
    const sym = s.sym;
    const value = this.compound(s.op, s.target, s.value);
    if (s.target.kind === 'Member') {
      const obj = this.expr(s.target.object) as Record<string, unknown>;
      obj[s.target.property] = value;
      return;
    }
    if (sym && (sym.kind === 'var' || sym.kind === 'varip')) {
      const id = sym.varSlot!.id;
      if (sym.kind === 'var') this.$.setVar(id, value);
      else this.$.setVarip(id, value);
      if (sym.historySlot != null) {
        this.$.set(
          sym.historySlot,
          (sym.kind === 'var' ? this.$.readVar(id) : this.$.readVarip(id)) as number,
        );
      }
      return;
    }
    const name = sym?.jsName ?? (s.target as Ident).name;
    this.env.set(name, value);
    if (sym?.historySlot != null) this.$.set(sym.historySlot, value as number);
  }

  private compound(op: string, target: Ident | Member, value: Expr): unknown {
    if (op === ':=') return this.expr(value);
    // Read the current value BEFORE the RHS (`x += f()` is `x := x + f()`,
    // left-to-right) — matches codegen when the RHS reassigns the target.
    const cur = this.expr(target) as number;
    const v = this.expr(value);
    switch (op) {
      case '+=':
        return this.$.add(cur, v as number);
      case '-=':
        return this.$.sub(cur, v as number);
      case '*=':
        return this.$.mul(cur, v as number);
      case '/=':
        return this.$.div(cur, v as number);
      case '%=':
        return this.$.mod(cur, v as number);
      default:
        return v;
    }
  }

  // ── control flow ──────────────────────────────────────────
  private ifStmt(s: IfNode): typeof BREAK | typeof CONTINUE | void {
    if (this.$.toBool(this.expr(s.cond))) return this.runBlock(s.then);
    for (const el of s.elifs) if (this.$.toBool(this.expr(el.cond))) return this.runBlock(el.body);
    if (s.else) return this.runBlock(s.else);
  }

  private forStmt(s: ForNode): void {
    const from = this.expr(s.from) as number;
    const to = this.expr(s.to) as number;
    // Direction is derived from from/to; an explicit `by` is the step MAGNITUDE
    // (default 1), so `for i = n to 0` counts down and `10 to 0 by 2` → 10,8,…,0.
    const mag = s.step ? Math.abs(this.expr(s.step) as number) : 1;
    const up = from <= to;
    const step = up ? mag : -mag;
    const name = s.varSym!.jsName!;
    for (let i = from; up ? i <= to : i >= to; i += step) {
      this.$.consumeLoopIteration();
      this.env.set(name, i);
      const r = this.runBlock(s.body);
      if (r === BREAK) break;
    }
  }
  private forInStmt(s: ForInNode): void {
    const iter = this.expr(s.iterable) as Iterable<unknown>;
    let idx = 0;
    for (const v of iter ?? []) {
      this.$.consumeLoopIteration();
      if (s.indexSym) this.env.set(s.indexSym.jsName!, idx);
      this.env.set(s.valueSym!.jsName!, v);
      const r = this.runBlock(s.body);
      if (r === BREAK) break;
      idx++;
    }
  }
  private whileStmt(s: WhileNode): void {
    while (this.$.toBool(this.expr(s.cond))) {
      this.$.consumeLoopIteration();
      const r = this.runBlock(s.body);
      if (r === BREAK) break;
    }
  }

  private runBlock(body: Stmt[]): typeof BREAK | typeof CONTINUE | void {
    for (const st of body) {
      const r = this.stmt(st);
      if (r === BREAK || r === CONTINUE) return r;
    }
  }

  private readSymVal(sym: {
    kind: string;
    varSlot?: { id: number } | null;
    jsName?: string;
  }): unknown {
    if (sym.kind === 'var') return this.$.readVar(sym.varSlot!.id);
    if (sym.kind === 'varip') return this.$.readVarip(sym.varSlot!.id);
    return this.env.get(sym.jsName!);
  }

  /** Block value = last statement's value (expression, or assigned value). */
  private blockValue(body: Stmt[]): unknown {
    for (let i = 0; i < body.length - 1; i++) {
      const r = this.stmt(body[i]);
      if (r === BREAK || r === CONTINUE) return r; // loop control escapes the value block (break in a switch case)
    }
    const last = body[body.length - 1];
    if (last) {
      if (last.kind === 'ExprStmt') return this.expr(last.expr);
      if (last.kind === 'VarDecl' && last.sym) {
        this.stmt(last);
        return this.readSymVal(last.sym);
      }
      if (last.kind === 'Reassign' && last.target.kind === 'Ident' && last.sym) {
        this.stmt(last);
        return this.readSymVal(last.sym);
      }
      // `if`/`switch` are expressions in Pine — a trailing one is the block's value. Evaluate it.
      if (last.kind === 'If' || last.kind === 'Switch') return this.expr(last);
      const r = this.stmt(last);
      if (r === BREAK || r === CONTINUE) return r;
    }
    return this.$.NA;
  }

  private switchValue(s: SwitchNode): unknown {
    const subj = s.subject ? this.expr(s.subject) : undefined;
    let defaultBody: Stmt[] | null = null;
    for (const c of s.cases) {
      if (!c.test) {
        defaultBody = c.body;
        continue;
      }
      const match = s.subject
        ? this.$.eq(subj, this.expr(c.test))
        : this.$.toBool(this.expr(c.test));
      if (match) return this.blockValue(c.body);
    }
    return defaultBody ? this.blockValue(defaultBody) : this.$.NA;
  }

  // ── expressions ───────────────────────────────────────────
  private expr(e: Expr): unknown {
    switch (e.kind) {
      case 'Number':
        return e.value;
      case 'String':
        return e.value;
      case 'Bool':
        return e.value;
      case 'Color':
        return this.$.colorLit(e.value);
      case 'Na':
        return this.$.NA;
      case 'Ident':
        return this.ident(e);
      case 'Member':
        return this.member(e);
      case 'History': {
        if (e.historySlot == null) return this.$.NA;
        if (e.historyExpr) this.$.set(e.historySlot, this.expr(e.base)); // materialize this bar's value
        return this.$.get(e.historySlot, this.expr(e.offset) as number);
      }
      case 'Unary':
        return e.op === 'not'
          ? this.$.not(this.expr(e.operand) as boolean)
          : e.op === '-'
            ? this.$.neg(this.expr(e.operand) as number)
            : this.expr(e.operand);
      case 'Binary':
        return this.binary(e);
      case 'Ternary':
        return this.$.toBool(this.expr(e.cond)) ? this.expr(e.then) : this.expr(e.else);
      case 'Call':
        return this.call(e);
      case 'Tuple':
        return e.items.map((it) => this.expr(it));
      case 'If': {
        if (this.$.toBool(this.expr(e.cond))) return this.blockValue(e.then);
        for (const el of e.elifs)
          if (this.$.toBool(this.expr(el.cond))) return this.blockValue(el.body);
        return e.else ? this.blockValue(e.else) : this.$.NA;
      }
      case 'Switch':
        return this.switchValue(e);
      case 'For':
      case 'ForIn':
      case 'While':
        return this.$.NA;
    }
  }

  private ident(e: Ident): unknown {
    const sym = e.sym!;
    switch (sym.kind) {
      case 'builtin-series':
        return this.ctx[sym.name];
      case 'var':
        return this.$.readVar(sym.varSlot!.id);
      case 'varip':
        return this.$.readVarip(sym.varSlot!.id);
      case 'plain':
      case 'param':
        return this.env.get(sym.jsName!);
      case 'builtin-ns':
        return this.ctx[nsRuntime(sym.name) ?? sym.name];
      default:
        return this.$.NA;
    }
  }

  private member(e: Member): unknown {
    if (e.constExpr) return this.expr(e.constExpr); // resolved enum member
    // strategy.closedtrades.first_index / strategy.opentrades.capital_held — bare scalar stats.
    if (
      e.object.kind === 'Member' &&
      e.object.object.kind === 'Ident' &&
      e.object.object.sym?.kind === 'builtin-ns' &&
      e.object.object.name === 'strategy' &&
      (e.object.property === 'closedtrades' || e.object.property === 'opentrades')
    ) {
      return (this.ctx.strategy as any).tradeStat(e.object.property, e.property);
    }
    if (e.object.kind === 'Ident' && e.object.sym?.kind === 'builtin-ns') {
      // no-paren stateful ta variable (`ta.tr`) → a site-keyed call.
      if (e.object.name === 'ta' && TA_VARS.has(e.property))
        return (this.ctx.ta as any)[e.property](e.stateSite ?? 0);
      const rt = nsRuntime(e.object.name) ?? e.object.name;
      return this.ctx[rt][e.property];
    }
    const obj = this.expr(e.object) as Record<string, unknown>;
    return obj?.[e.property];
  }

  private binary(e: Extract<Expr, { kind: 'Binary' }>): unknown {
    // v6: bools cannot hold na — na coerces to false. Lazy RHS preserved by &&/||.
    if (e.op === 'and')
      return this.$.toBool(this.expr(e.left)) && this.$.toBool(this.expr(e.right));
    if (e.op === 'or') return this.$.toBool(this.expr(e.left)) || this.$.toBool(this.expr(e.right));
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    switch (e.op) {
      case '==':
        return this.$.eq(l, r);
      case '!=':
        return this.$.ne(l, r);
      case '<':
        return this.$.lt(l, r);
      case '<=':
        return this.$.le(l, r);
      case '>':
        return this.$.gt(l, r);
      case '>=':
        return this.$.ge(l, r);
      case '+':
        return e.type?.kind === 'string'
          ? this.$.concat(l, r)
          : this.$.add(l as number, r as number);
      case '-':
        return this.$.sub(l as number, r as number);
      case '*':
        return this.$.mul(l as number, r as number);
      case '/':
        return this.$.div(l as number, r as number);
      case '%':
        return this.$.mod(l as number, r as number);
    }
  }

  private call(e: Call): unknown {
    const callee = e.callee;
    // UDT constructor `T.new(...)` → a null-prototype field record.
    if (e.udtFields) {
      const pos = e.args.filter((a) => !a.name);
      const named = new Map(e.args.filter((a) => a.name).map((a) => [a.name, a.value] as const));
      const obj = Object.create(null) as Record<string, unknown>;
      e.udtFields.forEach((f, i) => {
        const v = named.get(f.name) ?? pos[i]?.value ?? f.default;
        obj[f.name] = v ? this.expr(v) : this.$.NA;
      });
      return obj;
    }
    if (
      callee.kind === 'Member' &&
      callee.object.kind === 'Ident' &&
      callee.object.sym?.kind === 'builtin-ns'
    ) {
      const ns = callee.object.name;
      const fn = callee.property;
      const rt = nsRuntime(ns) ?? ns;
      if (ns === 'ta' || (ns === 'math' && fn === 'sum')) {
        // Normalize the arg *expressions* first, then evaluate — so dropped args
        // (e.g. valuewhen's occurrence) are not executed, matching codegen.
        const oneExpr = { kind: 'Number', value: 1, isInt: true } as Expr;
        const zeroExpr = { kind: 'Number', value: 0, isInt: true } as Expr;
        const argExprs = normalizeTaArgs(
          fn,
          e.args.map((a) => a.value),
          oneExpr,
          zeroExpr,
        );
        const values = argExprs.map((x) => this.expr(x));
        if ((fn === 'pivothigh' || fn === 'pivotlow') && values.length === 2) {
          values.unshift(fn === 'pivothigh' ? this.ctx.high : this.ctx.low);
        }
        if ((fn === 'highest' || fn === 'highestbars') && values.length === 1)
          values.unshift(this.ctx.high);
        if ((fn === 'lowest' || fn === 'lowestbars') && values.length === 1)
          values.unshift(this.ctx.low);
        return (this.ctx.ta as any)[fn](...values, e.stateSite ?? 0);
      }
      if (ns === 'input') {
        const defval = this.named(e, 'defval') ?? e.args.filter((a) => !a.name)[0]?.value;
        return (this.ctx.input as any)[fn](
          e.inputKey ?? '',
          defval ? this.expr(defval) : undefined,
        );
      }
      if (ns === 'request' && fn === 'security') {
        const pos = e.args.filter((a) => !a.name).map((a) => a.value);
        const sym = this.expr(this.named(e, 'symbol') ?? pos[0]) as string;
        const tf = this.expr(this.named(e, 'timeframe') ?? pos[1]);
        const exprNode = (this.named(e, 'expression') ?? pos[2])!;
        const laArg = this.named(e, 'lookahead') ?? pos[4];
        const la = laArg ? this.expr(laArg) : false;
        return this.$.security(e.securitySite ?? 0, sym, tf, la, (sub) => {
          const s$ = this.$,
            sctx = this.ctx;
          this.$ = sub;
          this.ctx = sub; // rebind to HTF context; env (plain locals) is shared
          try {
            return this.expr(exprNode);
          } finally {
            this.$ = s$;
            this.ctx = sctx;
          }
        });
      }
      if (ns === 'request' && fn === 'security_lower_tf') {
        const pos = e.args.filter((a) => !a.name).map((a) => a.value);
        const sym = this.expr(this.named(e, 'symbol') ?? pos[0]) as string;
        const tf = this.expr(this.named(e, 'timeframe') ?? pos[1]);
        const exprNode = (this.named(e, 'expression') ?? pos[2])!;
        return this.$.securityLowerTf(e.securitySite ?? 0, sym, tf, (sub) => {
          const s$ = this.$,
            sctx = this.ctx;
          this.$ = sub;
          this.ctx = sub;
          try {
            return this.expr(exprNode);
          } finally {
            this.$ = s$;
            this.ctx = sctx;
          }
        });
      }
      if (ns === 'strategy') return this.strategyCall(fn, e);
      if (ns === 'syminfo' && (fn === 'prefix' || fn === 'ticker')) {
        const arg = e.args.filter((a) => !a.name)[0]?.value;
        return this.$.syminfoParse(fn, arg ? this.expr(arg) : undefined);
      }
      return (this.ctx[rt] as any)[fn](
        ...this.nsArgValues(e, NS_CALL_PARAMS[`${ns}.${fn}`], NS_OPTS_POSITIONAL[`${ns}.${fn}`]),
      );
    }
    // two-level namespace: chart.point.new(...)
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
          return (this.ctx.strategy as any).tradeField(
            scope,
            callee.property,
            i ? this.expr(i) : 0,
          );
        }
        // strategy.risk.X(...) → the broker's risk-rule setters.
        if (scope === 'risk' && STRATEGY_RISK_PARAMS[callee.property]) {
          return (this.ctx.strategy.risk as any)[callee.property](
            ...this.nsArgValues(e, STRATEGY_RISK_PARAMS[callee.property]),
          );
        }
        return this.$.NA;
      }
      const rt = nsRuntime(callee.object.object.name) ?? callee.object.object.name;
      return (this.ctx[rt][callee.object.property] as any)[callee.property](...this.nsArgValues(e));
    }
    if (callee.kind === 'Member') {
      // method-call form: recv.method(args). Named args bundle into a trailing opts object
      // (nsArgValues no-sig) so styling on setters / table.cell reaches the runtime's `opts`
      // instead of being flattened into positionals (which corrupted the opts bag).
      return this.$.method(this.expr(callee.object), callee.property, this.nsArgValues(e));
    }
    if (callee.kind === 'Ident') return this.globalCall(callee.name, e);
    return this.$.NA;
  }

  /** Mirror of codegen's nsArgs: positional values, then a named-args opts object.
   *  With `sig` (ordered positional param names), named args matching a positional
   *  param slot into position and only the rest go to opts (named-constructor fix). */
  private nsArgValues(e: Call, coords?: readonly string[], optsPos?: readonly string[]): unknown[] {
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
      // param name (optsPos), then NAMED args that aren't coords. Decide membership
      // syntactically first — coord slots must EVALUATE before opts values to match the
      // emitted `$.fn(coord…, {opts})` left-to-right argument order.
      const extraPos: [string, Expr][] = [];
      for (let i = coords.length; i < positionalArgs.length; i++) {
        const pname = optsPos?.[i - coords.length];
        if (pname) extraPos.push([pname, positionalArgs[i].value]);
      }
      const namedOpts = e.args.filter((a) => a.name && !coords.includes(a.name));
      const hasOpts = extraPos.length > 0 || namedOpts.length > 0;
      // Pad coord slots up to coords.length when an opts bag exists so it lands in the
      // runtime's trailing `opts` parameter, not a skipped middle positional.
      const span = hasOpts ? Math.max(slots.length, coords.length) : slots.length;
      const out: unknown[] = [];
      for (let i = 0; i < span; i++)
        out.push(slots[i] !== undefined ? this.expr(slots[i]!) : undefined);
      if (hasOpts) {
        const opts: Record<string, unknown> = {};
        for (const [pname, v] of extraPos) opts[pname] = this.expr(v);
        for (const a of namedOpts) opts[a.name!] = this.expr(a.value);
        out.push(opts);
      }
      return out;
    }
    const positional = e.args.filter((a) => !a.name).map((a) => this.expr(a.value));
    const named = e.args.filter((a) => a.name);
    if (named.length) {
      const opts: Record<string, unknown> = {};
      for (const a of named) opts[a.name!] = this.expr(a.value);
      positional.push(opts);
    }
    return positional;
  }

  private arg(e: Call, index: number, name: string): Expr | undefined {
    const named = e.args.find((a) => a.name === name);
    if (named) return named.value;
    const positional = e.args.filter((a) => !a.name);
    return positional[index]?.value;
  }

  private globalCall(name: string, e: Call): unknown {
    if (NOOP_FNS.has(name)) return undefined;
    if (name === 'max_bars_back') return undefined; // lookback hint → noop
    if (OUTPUT_FNS.has(name)) return this.outputCall(name, e);
    const a = (i: number) => (e.args[i] ? this.expr(e.args[i].value) : undefined);
    if (DRAWING_CASTS.has(name)) return a(0); // box(x)/line(x)/… identity cast
    if (name === 'fixnan') return this.$.fixnan(a(0) as number, e.stateSite ?? 0);
    if (name === 'input') {
      const defval = this.named(e, 'defval') ?? e.args.filter((a) => !a.name)[0]?.value;
      return (this.ctx.input as any).auto(e.inputKey ?? '', defval ? this.expr(defval) : undefined);
    }
    if (name === 'timestamp') return this.$.timestamp(...e.args.map((a) => this.expr(a.value)));
    if (name === 'time') return (this.$ as any).timeFn(...e.args.map((a) => this.expr(a.value)));
    if (name === 'time_close')
      return (this.$ as any).timeCloseFn(...e.args.map((a) => this.expr(a.value)));
    if (name === 'nz')
      return e.args[1] !== undefined ? this.$.nz(a(0), a(1) as number) : this.$.nz(a(0));
    if (name === 'na') return this.$.na(a(0));
    if (name === 'alert') return this.$.alert((a(0) as string) ?? '');
    if (name === 'alertcondition') {
      const cond = this.expr(this.arg(e, 0, 'condition') ?? e.args[0].value) as boolean;
      const title = this.arg(e, 1, 'title');
      const msg = this.arg(e, 2, 'message');
      // `undefined` (not '') for an absent title/message so `message ?? title ?? 'alert'` works.
      return this.$.alertcondition(
        cond,
        title ? (this.expr(title) as string) : undefined,
        msg ? (this.expr(msg) as string) : undefined,
      );
    }
    if (CAST_FNS[name]) return (this.$ as any)[CAST_FNS[name]](a(0));
    if (DATE_FNS.has(name)) return this.$.dateAt(name, a(0) as number);
    return this.$.NA;
  }

  private named(e: Call, name: string): Expr | undefined {
    return e.args.find((a) => a.name === name)?.value;
  }
  private optsObj(e: Call, exclude: string[]): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const a of e.args) if (a.name && !exclude.includes(a.name)) o[a.name] = this.expr(a.value);
    return o;
  }

  private outputCall(name: string, e: Call): unknown {
    const id = e.outputId ?? 0;
    const pos = e.args.filter((a) => !a.name).map((a) => a.value);
    const ev = (x?: Expr) => (x ? this.expr(x) : undefined);
    const title = () => {
      const t = this.named(e, 'title');
      return t ? (this.expr(t) as string) : `${name} ${id}`;
    };
    const color = () => ev(this.named(e, 'color'));

    switch (name) {
      case 'plot': {
        // Pine: plot(series, title, color, …) — title is pos[1], color is pos[2].
        const titleExpr = this.named(e, 'title') ?? pos[1];
        const titleVal = titleExpr ? (this.expr(titleExpr) as string) : `plot ${id}`;
        return this.$.plot(
          id,
          ev(this.named(e, 'series') ?? pos[0]) as number,
          ev(this.named(e, 'color') ?? pos[2]),
          titleVal,
          this.optsObj(e, ['series', 'title', 'color']),
        );
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
        const series = ev(this.named(e, 'series') ?? pos[0]);
        const titleExpr = this.named(e, 'title') ?? pos[1];
        const titleVal = titleExpr ? (this.expr(titleExpr) as string) : `${name} ${id}`;
        if (name === 'plotarrow') {
          return this.$.marker(
            id,
            series,
            ev(this.named(e, 'colorup') ?? pos[2]),
            undefined,
            titleVal,
            'abovebar',
            '',
            MARKER_KIND[name],
          );
        }
        const glyph = ev(
          name === 'plotchar'
            ? (this.named(e, 'char') ?? pos[2])
            : (this.named(e, 'style') ?? pos[2]),
        ) as string;
        const loc = ev(this.named(e, 'location') ?? pos[3]) as string;
        const markerColor = ev(this.named(e, 'color') ?? pos[4]);
        const text = ev(this.named(e, 'text') ?? pos[6]);
        return this.$.marker(
          id,
          series,
          markerColor,
          text,
          titleVal,
          loc ?? 'abovebar',
          glyph ?? '',
          MARKER_KIND[name],
        );
      }
      case 'plotcandle':
      case 'plotbar':
        return this.$.plotcandle(
          id,
          ev(this.named(e, 'open') ?? pos[0]) as number,
          ev(this.named(e, 'high') ?? pos[1]) as number,
          ev(this.named(e, 'low') ?? pos[2]) as number,
          ev(this.named(e, 'close') ?? pos[3]) as number,
          color(),
          ev(this.named(e, 'wickcolor')),
          ev(this.named(e, 'bordercolor')),
          title(),
        );
      case 'hline':
        return this.$.hline(id, ev(this.named(e, 'price') ?? pos[0]) as number, title());
      case 'fill': {
        const p1 = ev(this.named(e, 'plot1') ?? pos[0]) as number;
        const p2 = ev(this.named(e, 'plot2') ?? pos[1]) as number;
        // Two overloads share a prefix: fill(plot1, plot2, color, …) vs the gradient
        // fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color, …). Since
        // args are commonly positional, named keys alone can't tell them apart — disambiguate
        // by shape: a numeric 3rd arg (the color form's 3rd arg is always a color) or a
        // present 5th+6th positional arg marks the gradient overload.
        const tv = this.named(e, 'top_value'),
          bv = this.named(e, 'bottom_value');
        const tc = this.named(e, 'top_color'),
          bc = this.named(e, 'bottom_color');
        const top = pos[2]?.type?.kind;
        const isGradient =
          !!(tv || bv || tc || bc) || top === 'int' || top === 'float' || !!(pos[4] && pos[5]);
        if (isGradient) {
          return this.$.fillGradient(
            id,
            p1,
            p2,
            ev(tv ?? pos[2]) as number,
            ev(bv ?? pos[3]) as number,
            ev(tc ?? pos[4]),
            ev(bc ?? pos[5]),
            title(),
          );
        }
        return this.$.fill(id, p1, p2, ev(this.named(e, 'color') ?? pos[2]), title());
      }
      case 'bgcolor':
        return this.$.bgcolor(id, ev(this.named(e, 'color') ?? pos[0]));
      case 'barcolor':
        return this.$.barcolor(id, ev(this.named(e, 'color') ?? pos[0]));
    }
    return this.$.NA;
  }

  /** Mirror of codegen's strategyCall: name-or-positional arg binding + `when` gate. */
  private strategyCall(fn: string, e: Call): unknown {
    const st = this.ctx.strategy as any;
    const ev = (x?: Expr) => (x ? this.expr(x) : undefined);
    const when = () => ev(this.named(e, 'when'));
    switch (fn) {
      case 'entry':
      case 'order':
        return st[fn](
          ev(this.arg(e, 0, 'id')),
          ev(this.arg(e, 1, 'direction')),
          ev(this.arg(e, 2, 'qty')),
          ev(this.arg(e, 3, 'limit')),
          ev(this.arg(e, 4, 'stop')),
          when(),
        );
      case 'close':
        return st.close(ev(this.arg(e, 0, 'id')), ev(this.named(e, 'qty')), when());
      case 'close_all':
        return st.close_all(when());
      case 'exit':
        return st.exit(
          ev(this.arg(e, 0, 'id')),
          ev(this.arg(e, 1, 'from_entry')),
          ev(this.arg(e, 2, 'qty')),
          ev(this.arg(e, 4, 'profit')),
          ev(this.arg(e, 6, 'loss')),
          ev(this.arg(e, 7, 'stop')),
          ev(this.arg(e, 5, 'limit')),
          ev(this.arg(e, 8, 'trail_price')),
          ev(this.arg(e, 9, 'trail_points')),
          ev(this.arg(e, 10, 'trail_offset')),
          when(),
        );
      case 'cancel':
        return st.cancel(ev(this.arg(e, 0, 'id')), when());
      case 'cancel_all':
        return st.cancel_all(when());
      case 'convert_to_account':
      case 'convert_to_symbol':
        return ev(this.arg(e, 0, 'value')); // single-currency: identity passthrough
      case 'default_entry_qty':
        return (st as any).default_entry_qty(ev(this.arg(e, 0, 'fill_price')));
    }
    return this.$.NA; // other strategy.* helpers not modeled yet → na (valid value)
  }
}
