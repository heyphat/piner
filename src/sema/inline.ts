/**
 * User-defined function inlining (Phase 6.5; docs/compiler-design.md §8 deferred
 * item, §5.2 / §9.3 scope-multiplicity).
 *
 * Pine has no first-class functions and no recursion, and every call site needs
 * INDEPENDENT internal state (a `ta.*` inside a UDF advances a distinct series per
 * written call). The simplest correct realization is monomorphization by
 * inlining: replace each `f(args)` with a synthetic always-true `if`-expression
 *
 *     if true
 *         <param> = <arg>      // one binding per parameter (arg evaluated once)
 *         ...
 *         <cloned function body>
 *
 * whose value is the body's last expression. Because each expansion is a fresh
 * deep clone, semantic analysis assigns it its own history/state/var slots — so
 * two calls to the same function get independent state for free, and an argument
 * containing a stateful call runs exactly once (it's bound to a local).
 */
import type { Program, Stmt, Expr, FuncDef, VarDecl, IfNode, Arg, Loc } from '../parser/ast.js';
import { NAMESPACES, type Diagnostic } from './analyze.js';
import { BUILTIN_METHODS } from '../codegen/intrinsics.js';

const MAX_EXPANSIONS = 5000; // runaway guard (also catches pathological fan-out)

export interface InlineResult {
  program: Program;
  diagnostics: Diagnostic[];
}

export function inlineUserFunctions(program: Program): InlineResult {
  return new Inliner(program).run();
}

const clone = <T>(node: T): T => structuredClone(node);

class Inliner {
  private funcs = new Map<string, FuncDef>();
  private methods = new Set<string>(); // names declared with the `method` keyword
  private active = new Set<string>(); // functions currently being expanded (cycle guard)
  private diagnostics: Diagnostic[] = [];
  private expansions = 0;

  constructor(private program: Program) {}

  run(): InlineResult {
    for (const s of this.program.body) {
      if (s.kind === 'FuncDef') {
        this.funcs.set(s.name, s);
        if (s.isMethod) this.methods.add(s.name);
      }
    }
    const body = this.program.body.map((s) => this.stmt(s));
    return { program: { ...this.program, body }, diagnostics: this.diagnostics };
  }

  private err(loc: Loc | undefined, message: string): void {
    this.diagnostics.push({ severity: 'error', message, line: loc?.line ?? 0, col: loc?.col ?? 0 });
  }

  // ── statements ────────────────────────────────────────────
  private stmt(s: Stmt): Stmt {
    switch (s.kind) {
      case 'VarDecl':
        return { ...s, init: this.expr(s.init) };
      case 'TupleDecl':
        return { ...s, init: this.expr(s.init) };
      case 'Reassign':
        return {
          ...s,
          target: this.expr(s.target) as VarDecl['init'] &
            Extract<Expr, { kind: 'Ident' | 'Member' }>,
          value: this.expr(s.value),
        };
      case 'ExprStmt':
        return { ...s, expr: this.expr(s.expr) };
      case 'If':
        return this.ifNode(s);
      case 'Switch':
        return {
          ...s,
          subject: s.subject ? this.expr(s.subject) : undefined,
          cases: s.cases.map((c) => ({
            test: c.test ? this.expr(c.test) : undefined,
            body: c.body.map((b) => this.stmt(b)),
          })),
        };
      case 'For':
        return {
          ...s,
          from: this.expr(s.from),
          to: this.expr(s.to),
          step: s.step ? this.expr(s.step) : undefined,
          body: s.body.map((b) => this.stmt(b)),
        };
      case 'ForIn':
        return { ...s, iterable: this.expr(s.iterable), body: s.body.map((b) => this.stmt(b)) };
      case 'While':
        return { ...s, cond: this.expr(s.cond), body: s.body.map((b) => this.stmt(b)) };
      // FuncDef bodies are inlined at call sites, not here; TypeDef/Import/Break/Continue are leaves.
      default:
        return s;
    }
  }

  private ifNode(s: IfNode): IfNode {
    return {
      ...s,
      cond: this.expr(s.cond),
      then: s.then.map((b) => this.stmt(b)),
      elifs: s.elifs.map((e) => ({
        cond: this.expr(e.cond),
        body: e.body.map((b) => this.stmt(b)),
      })),
      else: s.else ? s.else.map((b) => this.stmt(b)) : undefined,
    };
  }

  // ── expressions ───────────────────────────────────────────
  private expr(e: Expr): Expr {
    switch (e.kind) {
      case 'Number':
      case 'String':
      case 'Bool':
      case 'Color':
      case 'Na':
      case 'Ident':
        return e;
      case 'Member':
        return { ...e, object: this.expr(e.object) };
      case 'History':
        return { ...e, base: this.expr(e.base), offset: this.expr(e.offset) };
      case 'Unary':
        return { ...e, operand: this.expr(e.operand) };
      case 'Binary':
        return { ...e, left: this.expr(e.left), right: this.expr(e.right) };
      case 'Ternary':
        return { ...e, cond: this.expr(e.cond), then: this.expr(e.then), else: this.expr(e.else) };
      case 'Tuple':
        return { ...e, items: e.items.map((it) => this.expr(it)) };
      case 'If':
        return this.ifNode(e);
      case 'Switch':
        return this.stmt(e) as Expr;
      case 'For':
      case 'ForIn':
      case 'While':
        return this.stmt(e) as Expr;
      case 'Call': {
        // user-method dot-call sugar: `recv.m(args)` → `m(recv, args)` when `m` is a
        // user `method` and not a built-in collection/drawing method (those dispatch
        // by receiver shape, e.g. `arr.push(x)`). The receiver becomes `this` (param 0).
        // A bare Ident receiver naming a builtin namespace (`str.contains(...)`, …) is a
        // namespace CALL, never method sugar — otherwise a user `method contains` would
        // hijack it. (Trade-off: a user variable shadowing a namespace name loses dot-call
        // sugar; the inliner runs before name resolution, so it can't tell, and protecting
        // the builtin is the common case.)
        if (
          e.callee.kind === 'Member' &&
          this.methods.has(e.callee.property) &&
          !BUILTIN_METHODS.has(e.callee.property) &&
          !(e.callee.object.kind === 'Ident' && NAMESPACES.has(e.callee.object.name))
        ) {
          const recv = this.expr(e.callee.object);
          const args: Arg[] = [
            { value: recv },
            ...e.args.map((a) => ({ name: a.name, value: this.expr(a.value) })),
          ];
          return this.expand(e.callee.property, args, e.loc);
        }
        const callee = this.expr(e.callee);
        const args: Arg[] = e.args.map((a) => ({ name: a.name, value: this.expr(a.value) }));
        if (callee.kind === 'Ident' && this.funcs.has(callee.name)) {
          return this.expand(callee.name, args, e.loc);
        }
        return { ...e, callee, args };
      }
    }
  }

  // ── expansion ─────────────────────────────────────────────
  private expand(name: string, args: Arg[], loc: Loc | undefined): Expr {
    if (this.active.has(name)) {
      this.err(loc, `recursive call to '${name}' is not supported (Pine forbids recursion)`);
      return { kind: 'Na', loc };
    }
    if (++this.expansions > MAX_EXPANSIONS) {
      this.err(loc, `function inlining exceeded ${MAX_EXPANSIONS} expansions (possible runaway)`);
      return { kind: 'Na', loc };
    }
    const func = this.funcs.get(name)!;
    const positional = args.filter((a) => !a.name);
    // Bind each argument expression to a FRESH temp first, then bind the params from
    // the temps. Every argument (and default) thus evaluates in the CALLER's scope
    // before any parameter name exists, so an argument referencing a caller variable
    // named like a parameter (`f(a, b) => a - b` called as `f(1, a)`) cannot capture
    // the fresh `a` binding — in either direction. This also covers the method-receiver
    // case (`d.show(this.name)`: the arg reads the caller's `this`, not the receiver),
    // which previously needed a receiver-last reordering. The expansion counter makes
    // the temp names collision-proof across nested expansions.
    const expId = this.expansions;
    const tempDecls: VarDecl[] = [];
    const paramDecls: VarDecl[] = func.params.map((p, i) => {
      const named = args.find((a) => a.name === p.name);
      let init: Expr;
      if (named) init = named.value;
      else if (positional[i]) init = positional[i].value;
      else if (p.default) init = this.expr(clone(p.default));
      else {
        this.err(loc, `missing argument for parameter '${p.name}' in call to '${name}'`);
        init = { kind: 'Na', loc };
      }
      const tempName = `__arg${i}_${expId}`;
      tempDecls.push({ kind: 'VarDecl', mode: 'none', name: tempName, init, loc });
      return {
        kind: 'VarDecl',
        mode: 'none',
        name: p.name,
        init: { kind: 'Ident', name: tempName, loc },
        loc,
      };
    });

    // Clone the body and inline its own calls under this function's active scope.
    this.active.add(name);
    const body = func.body.map((b) => this.stmt(clone(b)));
    this.active.delete(name);

    return {
      kind: 'If',
      cond: { kind: 'Bool', value: true, loc },
      then: [...tempDecls, ...paramDecls, ...body],
      elifs: [],
      synthetic: true,
      loc,
    };
  }
}
