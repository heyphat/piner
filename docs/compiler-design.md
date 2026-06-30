# Pine Script v6 → JavaScript Compiler Design Brief

> **Audience:** the implementer building Phases 2–5 (lexer, parser, semantic
> analysis + slot allocation, codegen-to-JS, and the AST interpreter oracle).
> **Target:** Pine Script **v6** (pinned). Where source specs conflicted, this
> brief records the resolution inline (§9.1).

This is the contract the implementation follows. It is the companion to
[`architecture.md`](./architecture.md) (runtime design) and
[`pine-semantics.md`](./pine-semantics.md) (the language spec).

---

## 1. Pipeline & the AST contract

```
source.pine
  ▼ Phase 2  LEXER ........ char stream → tokens (with NEWLINE/INDENT/DEDENT)
  ▼ Phase 3  PARSER ....... tokens → AST (recursive descent + Pratt expressions)
  ▼ Phase 4  SEMANTIC ..... AST → annotated AST (types, qualifiers, slot ids)
  │            └─ SLOT ALLOCATION: history slots, stateful call-site ids, var/varip ids
  ├─▶ Phase 5a CODEGEN .... annotated AST → JS source emitting a main($) closure
  └─▶ Phase 5b INTERPRETER  annotated AST walked directly against the same $ runtime
```

**Central invariant:** both backends target the **same runtime `$` API** and make
the *identical sequence of `$` calls*, so the interpreter and the generated JS
produce byte-identical per-bar output. The interpreter is the auditable oracle;
the codegen is the fast path; a cross-check harness asserts they agree (§7).

**One AST, annotated in place** by Phase 4 (never rebuilt). Node fields:

| Field | Set by | Meaning |
|---|---|---|
| `kind` | Parser | discriminant (`Binary`, `HistoryRef`, `Call`, `VarDecl`, …) |
| `loc` | Lexer/Parser | `{line, col}` for diagnostics |
| `type` | Semantic | resolved type, or `void`/`na` |
| `qual` | Semantic | qualifier ∈ `{const, input, simple, series}` |
| `historySlot` | Slot alloc | history column id, or `null` |
| `stateSite` | Slot alloc | call-site id for stateful builtins, or `null` |
| `varSlot` | Slot alloc | `{id, mode}` for `var`/`varip`, else `null` |

Phase 4 only *adds* annotations; it never changes `kind`/structure. Both backends
**read** these annotations and never re-derive them — that's what guarantees they
agree.

---

## 2. Lexer (Phase 2)

### 2.1 Token kinds
- **Literals:** `INT`, `FLOAT`, `STRING`, `COLOR`, `BOOL`, `NA`.
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive.
- **Keywords:** `if else switch for to by in while break continue var varip and or
  not true false na import as export method type int float bool color string`.
  (`true/false`→BOOL, `na`→NA; `and/or/not/in/to/by/as` are word-operators.)
- **Operators/punct:** `+ - * / % == != < <= > >= = := += -= *= /= %= ? : => ( ) [ ] , .`
  `< >` double as type-template brackets; `[ ]` are overloaded (history / tuple /
  for-in) — same tokens, parser disambiguates.
- **Layout:** `NEWLINE`, `INDENT`, `DEDENT`, `EOF`.

**Maximal munch** for multi-char ops: `:=` before `=`/`:`; `==` before `=`;
`!= <= >=` before single-char; `+= -= *= /= %=` before bare op; `=>` before `=`.

### 2.2 Line-continuation rule (the hardest lexer concern)
Pine has **no continuation char and no terminator**. Continuation vs.
new-statement vs. block-open is decided by **indentation + bracket nesting**:

```
bracketDepth = 0; indentStack = [0]
for each physical line L (skip blank / comment-only lines):
  if bracketDepth > 0:                      # inside ( [ {
      emit L's tokens, NO NEWLINE/INDENT/DEDENT   # continuation, any indent
      update bracketDepth; continue
  ind = leadingIndentUnits(L)               # spaces/4, or tabs (1 tab = 1 level)
  if ind == 0:
      DEDENT to level 0; emit NEWLINE        # new global statement
  elif ind is a multiple of 4 (whole block levels):
      if level > top:  emit INDENT           # opens a local block
      elif level < top: DEDENT(s); emit NEWLINE
      else:             emit NEWLINE          # same-level new statement
  else:                                      # ind > 0, NOT a multiple of 4
      emit L's tokens, NO layout tokens       # WRAPPED continuation of prev line
  update bracketDepth across L
at EOF: DEDENT to 0; emit EOF
```

Rule of thumb: **multiple-of-4 indent = block; any other non-zero indent =
continue the previous line; brackets suspend all of it.**

### 2.3 Gotchas
- Tabs vs spaces: 1 tab = 1 block level; spaces in units of 4; reject mixed.
- `//` comments to EOL; **no block comments**; `//` inside a string is not a comment.
- Strings `"`/`'` interchangeable; escapes `\" \' \n \t \\`. Triple-quoted
  (`"""…"""` / `'''…'''`) multiline strings span physical lines — source newlines
  become `\n`, indentation is literal, escapes still decode (Pine v6 Apr-2026).
- Numbers lex **unsigned**; `+`/`-` are separate operator tokens (so `a-1` works).
  Exception: float exponent sign is part of the token (`1.6e-19`). Accept `3.`, `.5`.
- Color = `#` + exactly 6 or 8 hex digits. `color.red` is `IDENT.IDENT`, not a literal.

---

## 3. Grammar (Phase 3)

### 3.1 Operator precedence (tightest = 1)
| Lvl | Operators | Assoc | Notes |
|---|---|---|---|
| 1 | `()` call, `.` member | left | **Tighter than `[]`** so `close[1]`, `a.b().c[2]` parse. (Docs omit this — resolved.) |
| 2 | `[]` history (postfix) | left | Cannot chain (`close[1][2]` illegal). |
| 3 | unary `+ - not` | right | |
| 4 | `* / %` | left | |
| 5 | `+ -` | left | `+` also string concat |
| 6 | `< <= > >=` | left | numeric only |
| 7 | `== !=` | left | any fundamental type |
| 8 | `and` | left | lazy/short-circuit in v6 |
| 9 | `or` | left | lazy |
| 10 | `?:` ternary | right | loosest; `a?x:b?y:z` = `a?x:(b?y:z)` |
| stmt | `=` decl, `:=` reassign | right | statement-level only |

### 3.2 Statements
`VersionAnno` (`//@version=6`) → exactly one `Declaration`
(`indicator/strategy/library`) → `TopStmt*`.

```
VarDecl   := [export] [var|varip] [[Qualifier] Type] IDENT "=" (Expr | Structure)
TupleDecl := "[" IDENT ("," IDENT)* "]" "=" (CallExpr | Structure)   # no qual/type/var
Reassign  := LValue (":=" | "+=" | "-=" | ...) Expr                  # LValue = IDENT | obj.field
ExprStmt  := Expr
FuncDef   := [export] IDENT "(" Params ")" "=>" (single-line body | NEWLINE INDENT body DEDENT)
TypeDef   := [export] "type" IDENT NEWLINE INDENT ([varip] [Type] Field ["=" Default])+ DEDENT
Import    := "import" user "/" lib "/" version ["as" alias]
Qualifier := "const" | "simple" | "series"
Type      := int|float|bool|color|string|line|box|label|table|... | UDT | array<T> | matrix<T> | map<K,V>
```
Functions are **global-scope only**, last expression is the return, **no recursion**.

### 3.3 Control flow (statement *or* expression)
`if`/`else if`/`else`; `switch` (subject = equality match; subjectless = first-true;
bare `=>` = default; **no fall-through**); `for IDENT = a to b [by c]`; `for x in coll`
/ `for [i, x] in coll`; `while`. As expressions, all branches unify to a common
type and the qualifier is the join over conditions + all branches. Loops may yield
a value captured by a leading `vars =`.

### 3.4 Expressions
literal · identifier · member (`a.b`) · call (positional + named `f(x=1)`) · method
chain · `T.new(...)` · history `e[n]` · unary · binary · ternary · tuple literal
`[a,b]` (prefix = tuple; postfix = history) · grouping · type-template.

---

## 4. Types & qualifiers (Phase 4 part 1)

### 4.1 Lattice
`const ⊏ input ⊏ simple ⊏ series`. **Allocate history storage iff the inferred
qualifier is `series`.** Weaker may promote up; stronger may not be used where
weaker is required (param ceilings, §4.3).

### 4.2 Leaf qualifiers
| Source | Qualifier |
|---|---|
| literals (incl. bare `na`) | const |
| `input.*()` | input |
| **`input.source()`** | **series float** (exception) |
| `open/high/low/close/volume/hl2/hlc3/ohlc4/hlcc4/time/time_close/bar_index/last_bar_index` | series |
| `barstate.*` | series bool |
| `syminfo.*`, `timeframe.*` | simple |
| **`ta.*()` results** | **always series** |
| `request.security()` | series |
| reference/special types, collections, **UDT instances** | always series |

### 4.3 Bottom-up qualifier inference (`⊔` = max)
1. leaf literal → const; leaf builtin/var/param → declared qualifier
2. unary → Q(x)
3. binary `a OP b` → Q(a) ⊔ Q(b) (incl. comparisons/logical; result *type* is bool but qualifier is the join)
4. history `a[n]` → series
5. ternary / if-expr / switch-expr → join of **all** conditions and **all** branches
6. function call result → **by contract, not arg-join**: `ta.*`/`request.security`/`.new()`/collection ctors → series; `input.*` → input (except `input.source` → series); `math.*`/pure → join of args; **user fns** → inferred from body per call site
7. loops → a variable mutated across bars/iterations is series
8. `var`/`varip` → join over initializer **and all reassignments** (mode is orthogonal to qualifier)
9. tuple destructure → all targets share one joined qualifier

**Param ceilings flow the other way:** validate each argument against the param's
max-allowed qualifier (classic trap: `series int` length into `ta.sma` is an error).

### 4.4 Type rules
Fundamentals `int float bool color string` (+ enum). `bool` is **never `na`** in v6.
Auto **int→float** promotion (one-directional). **v6 `/` is float division**
(`5/2 == 2.5`); wrap in `int()` to truncate. **No implicit numeric→bool** — require `bool()`.

### 4.5 `na` propagation
- Arithmetic: contagious — any `na` operand → `na`. `nz/na()/fixnan` handle it.
- Logical `and/or/not`: bool operands, never `na`, strict true/false.
- **Comparison (`== != < <= > >=`): any `na` operand → `false`** (resolved for v6:
  bool can't be `na`). **Therefore `x == na` / `x != na` are always false — flag them
  as bugs and tell the user to use `na(x)` / `not na(x)`.** This is the highest-value lint.
- `if`/ternary condition is bool, always definitively true/false.
- `na()`/`nz()`/`fixnan()` reject bool args. Unmatched bool branch → `false`; non-bool → `na`. First-bar `bool[]` → `false`.

---

## 5. Slot allocation (Phase 4 part 2) — single deterministic pre-order walk

Three independent id namespaces; ids are **lexical** (stable across bars/ticks),
never merged by argument equality, never split per loop iteration.

### 5.1 History slots
A value needs a history column **iff it is the operand of `[]`**.
- `v[n]` where `v` is a symbol → mark that **symbol** historied (one slot per symbol).
- `f(args)[n]` → slot keyed to **that call site**.
- builtin series `close[n]` → slot for that producing expression.
- **No transitive closure**: marking `v` historied does not historify its RHS (the RHS recomputes each bar into the column). `v := w` then `w[n]` does not historify `v`.
- Self-ref `v := v[1] + x` needs `v` historied AND written each bar. Out-of-range → `na`. Size from max constant offset; series-int offset → dynamic buffer.
- **Lint:** `v[n]` where `v` is local-scope is unreliable → warn.

### 5.2 Stateful-builtin call-site ids
Stateful = carries cross-bar state. **Treat all `ta.*` (and `math.sum`) as stateful**; pure elementwise math is not (unless its result is `[]`-referenced → §5.1).
- N textual occurrences ⇒ N ids (never CSE-merge identical calls).
- One call inside a `for` loop ⇒ ONE id (shared across iterations).
- A call inside `if`/`switch`/ternary / `and`/`or` RHS ⇒ still ONE id, advanced only when reached — **danger**: skipping corrupts internal series → warn (§8).
- Stateful builtin inside a UDF ⇒ id per (outer call site × inner call site).

### 5.3 `var` / `varip` slots
- Plain (no keyword): **no persistent slot** — re-init every bar; cross-bar persistence only via `[]`.
- `var`: init once on first execution of the declaring scope (global → first bar; local → first bar the branch is reached). Guard with an init flag.
- `varip`: init on first execution (may be an intrabar tick).
- **Rollback:** restore `var` slots + init flags to the committed snapshot before each realtime tick; **`varip` escapes rollback**. One slot per textual decl (per outer UDF call inside a UDF; shared across loop iterations).
- A `var` that is also `[]`-referenced needs **both** a persistence slot and a history column.

### 5.4 Scope legality (same walk)
- **Global-only (error in local scope):** `indicator strategy library plot plotshape plotchar plotarrow plotcandle plotbar barcolor bgcolor hline fill alertcondition`, and all `type`/`enum`/function defs.
- `input.*()` allowed locally but **hoisted** to global (read once).
- **No recursion.**

---

## 6. Codegen (Phase 5a): AST node → JS against `$`

`main($)` runs once per bar. The driver owns the bar loop, ring buffers (sized
from `historySlot`), state cells (keyed by `stateSite`), var/varip slots, and
rollback. Plain variables are ordinary JS `let`s re-initialized each bar.

| AST node | Emitted JS | Notes |
|---|---|---|
| int/float/bool/string literal | literal | |
| color `#RRGGBB[AA]` | `$.color("#…")` | |
| `na` | `$.NA` | |
| builtin series read (`close`) | `$.series.close` | current-bar value |
| plain var read | JS local `v` | re-init each bar |
| `var`/`varip` read | `$.getVar(id)` / `$.getVarip(id)` | |
| `var`/`varip` init | `$.initVar(id, () => expr)` / `$.initVarip(...)` | init-flag guard |
| reassign `v := e` (plain) | `v = e` | also `+= -= …` |
| reassign `var`/`varip` | `$.setVar(id, e)` / `$.setVarip(id, e)` | |
| history `e[n]` | `$.get(slot, n)` | `slot = node.historySlot`; OOB → `$.NA` |
| member `a.b` | `a.b` / namespace | UDT field / namespace |
| field reassign `obj.f := e` | `obj.f = e` | |
| `T.new(...)` | emitted ctor | series |
| **stateful builtin** `ta.x(args)` | `$.ta.x(args, site)` | `site = node.stateSite` |
| pure builtin `math.x(args)` | `$.math.x(args)` | no site |
| `input.*(...)` | `$.input.x(...)` | hoisted to one-time init |
| arithmetic `a+b` | `$.add(a,b)` | also `$.sub/mul/div/mod`; **div = float** |
| unary minus | `$.neg(x)` | na-propagating |
| string concat `+` | `$.concat(a,b)` | |
| comparison `a<b` | `$.lt(a,b)` (`le/gt/ge/eq/ne`) | **na operand → false** |
| `and`/`or` | JS `&&`/`||` | lazy; warn if stateful call in RHS |
| `not` | `$.not(x)` | |
| ternary `c?a:b` | `(c ? a : b)` | lazy; warn on stateful in branch |
| `if`/`switch` expr | IIFE; unmatched → `$.NA` (or `false` if bool) | branches pre-unified |
| `for`/`while`/`for…in` | JS loop; bounds re-eval each iter (v6) | shared state ids respected |
| tuple destructure | `const [a,b] = f()` | one shared qualifier |
| UDF call | emitted JS fn, per-call-site slot namespace threaded | independent scope |
| global `plot()` | `$.plot(series, {opts})` | registered at compile time |

na-propagating ops funnel through `$` (not raw JS) so NaN-propagation, v6
float-division, and na→false comparisons live in one place — identical across backends.

---

## 7. Interpreter (Phase 5b) — the oracle

A tree-walker over the **same annotated AST** making the **same `$` calls** as
codegen — one case per §6.2 row, reading the same annotation fields:

```
eval(node, env):
  HistoryRef:   $.get(node.historySlot, eval(node.offset))
  Binary("+"):  $.add(eval(l), eval(r))
  Comparison("<"): $.lt(eval(l), eval(r))
  StatefulCall: $.ta[name](evalArgs(args), node.stateSite)
  VarRead:      node.varSlot.mode==='varip' ? $.getVarip(id) : $.getVar(id)
```

Runs against the **same driver and `$`** (same buffers, state cells, slots,
rollback). **Cross-check harness:** for every test program and bar, run codegen→`$₁`
and interpreter→`$₂` on identical input and assert every output is equal
(NaN-aware: `na===na`), on both historical bars and a realtime-tick replay
(exercises rollback + `varip` escape). Any divergence = a backend bug; the
interpreter is ground truth.

---

## 8. Recommended implementation subset (Phases 2–5)

Smallest surface that runs **real indicators** (SMA/EMA cross, RSI, Bollinger,
MACD, ATR bands, OBV) end-to-end through **both** backends.

**Implement now:** full lexer (§2); parser for the full precedence table,
`indicator/strategy` decls, var/varip decls with optional qual/type, tuple decls,
`:=` (+ compound), expr stmts, single+multi-line UDFs, if/else, both switch shapes,
for / for-in / while, break/continue, named args, member + method chains, history,
tuple literals, `T.new`, collection type templates, `type` defs, `import`; full
qualifier inference + int→float + float-div + `bool()` + the na rules incl. the
`==na` lint; history/state/var slot allocation; scope legality + input hoisting +
no-recursion + conditional-stateful warning; full codegen + interpreter + the
cross-check harness.

**Builtins now:** series leaves + `barstate.*`; stateful `ta.sma/ema/rma/wma/rsi/
atr/tr/highest/lowest/change/crossover/crossunder/cross/barssince/valuewhen/cum/
stdev(/dev)`; pure `math.max/min/abs/round/pow/sqrt/sign/avg`; `na/na()/nz/fixnan`;
`input.int/float/bool/source`; `color.new/rgb` + color constants; `plot/plotshape/
hline/fill` + `plot.style_*`/`shape.*`/`location.*`/`hline.style_*` constants.

**Originally deferred for this subset** (all but library `export` are now done — see
the update note below): `request.*`; the strategy order engine; `enum`, user
`method`, library `export`; `timeframe/session/ticker` queries; full intrabar tick
fidelity.

> **Update (current):** every originally-deferred item is now implemented —
> `array.*`/`map.*`/`matrix.*`, all drawing objects (`line/label/box/table/polyline/
> linefill`), `alert`/`alertcondition`, expanded `ta.*` (macd/bb/stoch/supertrend/…),
> **user-defined functions** *and* user `method` receivers (via call-site
> inlining/monomorphization — `src/sema/inline.ts`: each call site gets a fresh clone
> → independent history/state/var slots, args bound once, recursion rejected),
> **`request.security()`** (Phase 7, v1), the **`strategy.*`** broker (Phase 8, v1),
> and **v5** scripts. The **only** language feature still deferred is library
> `import`/`export` (needs a multi-module resolver) — plus fundamental `request.*`
> data feeds.

---

## 9. Open risks & the two unsettled semantics

### 9.1 Resolved conflicts (recorded)
- `.`/`()` bind **tighter** than `[]` (docs omit this).
- 1 tab = 1 block level; spaces in units of 4; reject mixed.
- `na` through comparisons → `false`; `bool` never `na` (v6, via FAQ + migration guide).
- `var`/`varip` are persistence modes orthogonal to qualifier; qualifier = join over init + all reassignments.

### 9.2 Two unsettled semantics — keep behind flags
1. **`naComparisonMode`** (default `v6`: comparison with `na` → `false`, `bool`
   never `na`, emit the `==na` lint). All comparisons funnel through `$.eq/$.ne/…`
   so flipping to a `v5` three-valued mode is a one-place change. Pin from `//@version=`.
2. **`securityLookahead`** (default `off`) — **resolved & implemented (Phase 7).**
   `request.security` defaults to `barmerge.lookahead_off` (non-repainting since v3):
   a historical bar sees the previous confirmed HTF value; `lookahead_on` exposes the
   documented future leak. Pinned by `test/security.test.ts`.

### 9.3 Standing risks
- `forBoundsAllowSeries` (default on for v6): `to` re-evaluated each iteration.
- Conditional/lazy stateful calls can corrupt internal series → **warn**, recommend hoisting.
- Buffer sizing from max constant offset; series-int offset → on-demand buffer (cap ~5000).
- UDF scope multiplicity: state/var id per (outer call × inner call) — cross-check must include two identical UDF calls with an inner `ta.*` to lock in independent trails (no CSE merging).
