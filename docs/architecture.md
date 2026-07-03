# Piner — Pine Script v6 Engine Architecture

A clean-room TypeScript engine to compile and run **TradingView Pine Script v6**
in any JS environment (browser-first). Designed from the public v6 docs only.
No PineTS (AGPL) code is used; where this doc names a PineTS _concept_ it is for
contrast, and a clean-room alternative is given.

---

## 0. Design principles

1. **The runtime model is the product, not the parser.** Pine's difficulty is
   bar-by-bar re-execution, history-referencing series, `na` propagation,
   `var`/`varip` persistence, and realtime rollback. The grammar is volume work.
2. **Transpile to a JS closure, run once per bar.** Validated as the only
   architecture with proven fidelity to the bar-by-bar model. We compile a Pine
   script into a single `main($)` JS function that the driver calls once per
   historical bar and once per realtime tick.
3. **Plain locals fast-path; recorded slots only when needed.** A value becomes a
   history-tracked "slot" only if (a) it is referenced with `[]`, or (b) it feeds
   a stateful built-in. Everything else is a plain JS local — far less allocation
   than "every variable is a Series".
4. **Rollback = truncate to committed length + re-run.** The realtime bar is just
   "the last bar, recomputed from snapshot each tick." This single mechanism
   produces correct repainting behavior for free.
5. **Determinism.** No `Date.now()`/`Math.random()` in the engine core; all time
   comes from the data feed. Makes runs reproducible and testable.

---

## 1. Compilation pipeline

```
Pine source
   │
   ▼  Lexer            tokens (handles significant newlines, line continuation,
   │                   string/number/color/comment literals)
   ▼  Parser           Pine AST (Program → declarations, statements, expressions)
   │
   ▼  Inliner          monomorphizes user-function/method calls (sema/inline.ts):
   │                   each call site → a fresh clone with independent slots
   ▼  Semantic analysis  ONE pass (sema/analyze.ts): name resolution, coarse types +
   │                   qualifiers, na-safety diagnostics, AND slot allocation
   │                   (sema/slots.ts: history sites, stateful call-site ids, var/varip)
   │
   ├─▶ CodeGen          annotated AST → JS source emitting a `main($)` closure
   └─▶ Interpreter      the same annotated AST walked directly against the same `$`
```

Two back-ends share everything up to the annotated AST, and both are built:

- **CodeGen → JS (primary).** Emit JS text, instantiate with `new Function`.
  Fastest; the per-bar body is plain JS the JIT can optimize.
- **AST interpreter (oracle).** Walk the typed AST directly. Slower, but it is the
  correctness oracle: the test suite runs _both_ on every script and asserts
  byte-for-byte-identical output, so any lowering bug is a test failure.

Both target the **same runtime `$` (`ExecutionContext`) API**, so they're
interchangeable and produce identical `$` call sequences by construction.

---

## 2. Directory layout

```
src/
  lexer/
    token.ts            Token, TokenKind, keyword/operator tables
    lexer.ts            source → Token[]   (indentation/continuation handling)
  parser/
    ast.ts              AST node types (discriminated unions) + annotation fields
    parser.ts           Token[] → Program (recursive descent + Pratt expressions)
  sema/
    types.ts            Qualifier, PineType, QualifiedType
    inline.ts           inlineUserFunctions — monomorphizes UDF/method call sites
    analyze.ts          ONE pass: name resolution, coarse type/qualifier inference,
                        na-safety diagnostics, input-schema extraction
    slots.ts            SlotAllocator — history columns, stateful call-site ids, var/varip
  codegen/
    emit.ts             annotated AST → JS source string (emits `main($)`)
    intrinsics.ts       Pine operators/builtins → `$` runtime calls; NS/stateful tables
  interp/
    interpreter.ts      AST walker against the same `$` (the correctness oracle)
  runtime/
    context.ts          ExecutionContext ($) — per-script runtime; plot/fill/marker/
                        bgcolor/alert sinks, request.security, source-input resolution
    series.ts           columnar polymorphic history store + NA/isNa helpers
    barstate.ts         BarState computation
    output.ts           OutputCollector — serializable visual IR (plots/fills/markers/
                        hlines/drawings/alerts); rollback drops uncommitted
    builtins/
      ta.ts             ta.*   (stateful: sma/ema/rsi/atr/macd/supertrend/…)
      math.ts           math.* (+ pi/e/phi constants)
      str.ts            str.*  (tostring/format/format_time/…)
      color.ts          color.* (new/rgb/from_gradient + v6 named palette)
      array.ts          array.*
      map.ts            map.*
      matrix.ts         matrix.*
      input.ts          input.* leaf evaluators
      drawing.ts        line/label/box/table/polyline/linefill (pooled, rollback-safe)
      strategy.ts       StrategyBroker + makeStrategyNs (order/broker model)
      request.ts        request.security helpers / HTF resampling
      constants.ts      plot/shape/location/hline/position/size/xloc/… constant tags
  engine/
    feed.ts             DataFeed / ArrayFeed (OHLCV provider)
    driver.ts           historical loop + realtime tick handling (rollback → replay)
    compiler.ts         top-level: source → CompiledScript (lex→parse→inline→analyze→emit)
    engine.ts           Engine wrapper (run, outputs, drawings, strategy)
  index.ts              public API
```

> Note: there is no separate `resolver.ts`/`checker.ts` — resolution, typing, and
> na-safety are one pass in `sema/analyze.ts`. Plot/fill/marker/alert sinks live on
> `ExecutionContext` (`runtime/context.ts`), not a separate `plot.ts`/`alert.ts`;
> the serializable output IR is `runtime/output.ts`. Rollback is a method on the
> context + store, not a separate `rollback.ts`.

---

## 3. Type & qualifier system (`sema/types.ts`)

Pine v6 types are a **(qualifier, type)** pair. The qualifier is what tells us
whether history tracking is needed.

```ts
export enum Qualifier {
  Const,
  Input,
  Simple,
  Series,
} // weakest → strongest

export type PineType =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'color' }
  | { kind: 'line' }
  | { kind: 'label' }
  | { kind: 'box' }
  | { kind: 'table' }
  | { kind: 'polyline' }
  | { kind: 'linefill' }
  | { kind: 'array'; of: PineType }
  | { kind: 'matrix'; of: PineType }
  | { kind: 'map'; key: PineType; value: PineType }
  | { kind: 'udt'; name: string } // user-defined type
  | { kind: 'tuple'; items: PineType[] }
  | { kind: 'void' }
  | { kind: 'na' };

export interface QualifiedType {
  qualifier: Qualifier;
  type: PineType;
}
```

**Why it matters:** only `series`-qualified values can carry history. The checker
infers qualifiers bottom-up (`const` literal + `series close` ⇒ `series`). A value
is a candidate for a history slot only if its inferred qualifier is `Series`.

`na` is its own bottom type that unifies with everything; at runtime it is JS
`NaN` for numerics and a sentinel `NA` object for non-numerics (objects, strings,
ids), so `na`-ness is always representable.

---

## 4. The slot model — how history & state actually work

This is the heart of the engine. Three concerns, all resolved at compile time by
the **SlotAllocator** (`sema/slots.ts`) so the runtime never does string lookups.

### 4.1 History slots (the `[]` operator)

If the analyzer sees a `series` value referenced as `x[n]` anywhere, it assigns
`x` a **history slot**. The codegen then records `x` each bar and reads history
from the store.

```ts
// runtime/series.ts
export class SeriesStore {
  private cols: Float64Array[] = []; // one growable column per numeric slot
  private len = 0; // committed + current bar count
  // object-typed slots (line/label/string ids) use any[][] columns instead

  declareNumericSlot(): number {
    this.cols.push(new Float64Array(1024));
    return this.cols.length - 1;
  }

  set(slot: number, value: number) {
    this.cols[slot][this.len] = value;
  }

  /** x[offset] — 0 = current bar, out of range ⇒ NaN (na), never throws */
  get(slot: number, offset: number): number {
    const i = this.len - offset; // current bar is at index `len`
    if (i < 0 || offset < 0) return NaN; // before history start ⇒ na
    return this.cols[slot][i];
  }

  beginBar() {
    this.ensureCapacity();
  } // grow Float64Arrays geometrically
  commitBar() {
    this.len++;
  } // advance only when bar confirmed
  truncateTo(n: number) {
    this.len = n;
  } // ← rollback primitive (§6)
}
```

> Contrast with PineTS, which wraps each series in a `Series` object using
> `realIndex = data.length - 1 - (offset + this.offset)` and returns `NaN` out of
> range. We instead use **flat typed-array columns indexed by a global bar
> counter**. Same observable semantics (0 = current, out-of-range = `na`), but
> zero per-series object allocation and cache-friendly for `ta.*` windows.

Built-in series `open/high/low/close/volume/time/hl2/...` are just pre-declared
slots filled by the feed each bar.

### 4.2 Stateful built-in instances

`ta.sma(close, 20)` keeps a rolling window. Two calls = two independent states.
Each _call site_ gets a **state slot**; the builtin receives it and stashes state
keyed by it.

```ts
// codegen output for `ta.sma(close, 20)` at call-site #7
$.ta.sma($.get(CLOSE, 0), 20, 7);
```

```ts
// runtime/builtins/ta.ts
export class Ta {
  private state = new Map<number, RmaState | SmaState | ...>();
  sma(src: number, len: number, site: number): number {
    let st = this.state.get(site) as SmaState | undefined;
    if (!st) { st = { buf: new RingBuffer(len), sum: 0 }; this.state.set(site, st); }
    return st.push(src);    // returns na until `len` values seen
  }
}
```

State slots are part of the rollback snapshot (§6).

### 4.3 `var` / `varip` persistence

Ordinary assignments re-run every bar (plain JS locals). `var` initializes once
and persists; `varip` persists across realtime ticks too.

```ts
// runtime/context.ts
private vars = new Map<number, any>();   // var store, keyed by compile-time slot
private varips = new Map<number, any>(); // varip store — exempt from rollback

initVar(slot: number, init: () => any): any {     // for `var x = init`
  if (!this.vars.has(slot)) this.vars.set(slot, init());
  return this.vars.get(slot);
}
setVar(slot: number, v: any) { this.vars.set(slot, v); }
```

Codegen for `var float v = na` / later `v := v + close`:

```ts
let v = $.getVar(V_SLOT, () => NaN); // init-once
v = $.add(v, $.get(CLOSE, 0));
$.setVar(V_SLOT, v);
```

`varip` uses the same shape but reads/writes `this.varips`, which `rollback()`
does **not** clear.

---

## 5. The execution context (`$`)

The single object every generated script receives. Fast methods, integer slots.

```ts
// runtime/context.ts
export class ExecutionContext {
  idx = 0; // current bar index (0-based)
  execTick = 0; // monotonic; ++ each time a bar STARTS executing → repaint detection
  bar!: BarState; // isnew / isconfirmed / islast / ishistory / isrealtime ...

  readonly series = new SeriesStore();
  readonly ta: Ta;
  readonly math: MathNs;
  readonly str: StrNs;
  readonly arr: ArrayNs;
  readonly req: RequestNs;
  readonly strat: StrategyNs;
  readonly out: OutputCollector; // plots + drawings sink

  // history & na
  get(slot: number, off: number) {
    return this.series.get(slot, off);
  }
  set(slot: number, v: number) {
    this.series.set(slot, v);
  }
  na(v: any) {
    return v !== v || v == null || v === NA;
  } // NaN-safe
  nz(v: any, r = 0) {
    return this.na(v) ? r : v;
  }

  // arithmetic that propagates na (NaN) — generated code calls these so a single
  // na operand poisons the result, matching the docs.
  add(a: number, b: number) {
    return a + b;
  } // NaN + x === NaN already
  // comparisons: SEE §8 open question — do NOT assume na ⇒ false yet.
}
```

`BarState` is recomputed each bar from the feed + driver phase:

```ts
export interface BarState {
  isnew: boolean;
  isconfirmed: boolean;
  islast: boolean;
  ishistory: boolean;
  isrealtime: boolean;
  islastconfirmedhistory: boolean;
}
```

---

## 6. The driver — historical loop + realtime rollback (`engine/driver.ts`)

```ts
export class Driver {
  private committed = 0; // # of confirmed bars in the SeriesStore

  runHistorical(main: ScriptFn, feed: Bar[], $: ExecutionContext) {
    for (let i = 0; i < feed.length; i++) {
      this.beginBar($, feed[i], /*confirmed*/ true);
      main($);
      this.commitBar($); // series.commitBar(); committed = ++len
    }
  }

  /** A realtime update: the open bar gets recomputed from the committed snapshot. */
  onTick(main: ScriptFn, tick: Bar, $: ExecutionContext, isClose: boolean) {
    this.rollback($); // truncate everything back to `committed`
    this.beginBar($, tick, /*confirmed*/ isClose);
    main($);
    if (isClose) this.commitBar($); // confirmed close → bar becomes permanent
    // else: stays uncommitted; next tick rolls back & recomputes → repaint
  }

  private rollback($: ExecutionContext) {
    $.series.truncateTo(this.committed); // history slots
    $.ta.restore(this.snapshot); // stateful builtin states
    $.restoreVars(this.snapshot); // `var` store  (varip is NOT restored)
    $.out.dropUncommitted(); // remove this bar's plots/drawings
  }
}
```

**Why this is correct:** the docs say realtime bars re-execute every tick and the
script's variables/expressions/outputs are _cleared/reset_ before each
recalculation, while `varip` escapes it. Truncating the store to the committed
length and replaying is exactly that reset. Because realtime `high/low/close`
mutate per tick (only `open` fixed) and historical bars store only final OHLC,
replaying with the live tick's mutable values reproduces **repainting** with no
special-casing. `barstate.isconfirmed` is simply `isClose`.

The **snapshot** is taken once when transitioning from historical → realtime
(after the last confirmed bar): deep-ish copy of builtin states + `var` store. It
is cheap because state objects are small (ring buffers, accumulators).

---

## 7. Built-in library structure (`runtime/builtins/`)

Namespaces are plain objects on `$`. Each fn that needs history takes a trailing
`site: number`. Categories:

| Namespace                                                         | Notes                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ta.*`                                                            | **Stateful.** sma/ema/rma/wma/vwma, rsi, atr, macd, bb, stoch, change, mom, highest/lowest, barssince, valuewhen, pivothigh/low, cum, cross/crossover/crossunder. Each call site = independent ring/accumulator. |
| `math.*`                                                          | Pure; trivial.                                                                                                                                                                                                   |
| `str.*`                                                           | Pure; format/tostring/split/etc.                                                                                                                                                                                 |
| `color.*`                                                         | Pure; rgb/new/from_gradient.                                                                                                                                                                                     |
| `array.* / matrix.* / map.*`                                      | Reference objects; ids handed back to script. Stored in object-typed slots so they can be history-referenced and rolled back.                                                                                    |
| `input.*`                                                         | Read once at compile/instantiation; produces the settings panel schema in `ScriptMetadata`.                                                                                                                      |
| `plot / plotshape / plotchar / hline / fill / bgcolor / barcolor` | Push to `OutputCollector` per bar (tagged with bar idx so rollback can drop uncommitted).                                                                                                                        |
| `line/label/box/table/polyline/linefill`                          | Drawing objects with create/set/delete; live in object slots; deletions/edits replay deterministically.                                                                                                          |
| `request.security()`                                              | Runs a **nested engine** over HTF data; see §9.                                                                                                                                                                  |
| `strategy.*`                                                      | Broker simulator; see §10.                                                                                                                                                                                       |
| `alert / alertcondition`                                          | Uses `execTick` to fire once per confirmed bar; collected as events.                                                                                                                                             |

A builtin is registered with metadata so the type checker knows its signature,
return qualifier, and whether it is stateful (needs a site id):

```ts
export interface BuiltinSig {
  name: string; // "ta.sma"
  params: QualifiedType[];
  ret: QualifiedType;
  stateful: boolean; // → allocate a state slot at the call site
  forbidInLoop?: boolean; // some ta.* may not be called conditionally; checker warns
}
```

---

## 8. `na` and comparison semantics — RESOLVED

Two semantics that were once open are now resolved against the v6 docs and pinned
by tests:

1. **`na` through comparisons → `false`.** In v6 `bool` is never `na`, so
   `na < x`, `x == na`, etc. all yield `false`. Comparisons funnel through
   `$.lt/$.le/$.gt/$.ge/$.eq/$.ne` so the rule lives in one place. The analyzer also
   lints `x == na` / `x != na` (always false) and tells the user to use
   `na(x)` / `not na(x)`. ⚠️ Note `na(x)` is the **is-na function**, distinct from
   the `na` literal — a real parser fix.
2. **`request.security()` default lookahead = `barmerge.lookahead_off`** (the
   non-repainting default since v3). On historical bars a bar sees the _previous
   confirmed_ HTF value; `lookahead_on` exposes the documented future leak.

`NA` is a **cloneable sentinel** (not a `Symbol`, so `structuredClone` of a
reference-typed `var x = na` doesn't throw):

```ts
// runtime/series.ts
export const NA = { __na: true } as const; // non-numeric na sentinel (cloneable)
export const isNa = (v: any) => v !== v || v == null || v === NA;
```

---

## 9. Multi-timeframe — `request.security()` (`runtime/context.ts` + `runtime/builtins/request.ts`)

> **Status: implemented (v1).** Same-symbol HTF requests resample the chart's own
> bars and evaluate the expression in a sub-context (`ExecutionContext.security` /
> `computeSecurity`); `lookahead_off` (default, non-repainting) and `lookahead_on`
> both modeled; tuple requests supported. Cross-symbol is data-agnostic: piner
> declares the dependency and the **host injects** bars (`ctx.securityBars[...]`);
> without injection it degrades to `na`. `request.security_lower_tf` buckets
> host-injected intrabars. Realtime re-request is the remaining tail.

`security()` evaluates an expression in another symbol/timeframe context. Clean
design: **recursively instantiate the same engine** on the requested series,
then map HTF bars onto the chart timeline.

- **Historical bars:** return only **confirmed** HTF values (last closed HTF bar).
- **Realtime bars:** may return the **unconfirmed** developing HTF value → this is
  the documented HTF repaint; expose it, don't hide it.
- **`barmerge.lookahead`:** `lookahead_on` without offset returns the first
  intrabar of the HTF period (future leak on history); `lookahead_on` + `[1]`
  offset is the non-repainting idiom (always last confirmed). Model both via a
  per-request alignment function `mapHtfToChart(chartTime, lookahead, offset)`.
- `barstate.isconfirmed` does **not** work inside the requested context — mirror
  that limitation.

```ts
// runtime/context.ts (actual signature) — the expression is pre-wrapped by codegen
// into a thunk that re-evaluates against the HTF sub-context.
security(site: number, symbol: string, tf: unknown, lookahead: unknown,
         evalFn: (sub: ExecutionContext) => unknown): unknown { ... }
```

---

## 10. Strategy engine (`runtime/builtins/strategy.ts`)

> **Status: implemented (v1).** `StrategyBroker` + `makeStrategyNs`: orders fill at
> the next bar's open (or same-bar close with `process_orders_on_close`), with
> market/limit/stop/stop-limit, reverse + pyramiding, sizing
> (fixed/cash/percent_of_equity), commission, slippage, exit brackets (profit/loss/
> stop/limit/**trailing**, OCA), PnL + closed-trade list + equity curve +
> drawdown/run-up, live read-backs, per-trade introspection, and performance stats.
> Tail: OCA-group nuances, `calc_on_every_tick`, `strategy.risk.*`, margin.

A deterministic broker simulator driven by the same bar loop.

- **Execution frequency:** indicators/libraries run on every realtime tick;
  strategies run only on **bar close** unless `calc_on_every_tick=true`. The
  driver branches on script type + this flag.
- **Order model:** `strategy.entry/order/exit/close/cancel`, market/limit/stop,
  pyramiding, position sizing, commission/slippage. Maintain an order book and a
  position; fill against next-bar OHLC per Pine's fill rules.
- **Outputs:** trade list, equity curve, and `strategy.*` read-backs
  (`position_size`, `equity`, `openprofit`, ...) exposed as series slots so the
  script can reference and plot them.
- Backtesting replays history; forward/realtime ticks reuse the same rollback.

---

## 11. Data feed & public API

```ts
// engine/feed.ts
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface DataFeed {
  history(symbol: string, tf: string): Promise<Bar[]>;
  subscribe?(symbol: string, tf: string, onTick: (b: Bar, isClose: boolean) => void): () => void;
}
```

```ts
// index.ts
const compiled = compile(pineSource); // → { main, interpret, source, metadata, diagnostics }
const engine = new Engine(compiled, new ArrayFeed(bars) /*, { backend, inputs }*/);
await engine.run({ symbol: 'BTCUSD', timeframe: '60' });
engine.outputs; // OutputCollector: .plots / .fills / .hlines / .markers / .alerts
engine.drawings; // live line/label/box/table/polyline/linefill objects
engine.strategy; // StrategyReport (net/gross PnL, trades, equity curve)
// browser charting (lightweight-charts etc.) reads these buffers
```

`ScriptMetadata` carries the inputs schema, plot declarations, and overlay flags
so a UI can render the settings panel and wire plots to a chart.

---

## 12. Build order (suggested phases)

1. **Runtime core first** (no parser): hand-write a `main($)` for a couple of
   indicators against `SeriesStore` + `Context` + driver + rollback. Prove the
   bar-by-bar + history + `var` + rollback model on real OHLCV.
2. **Lexer + parser + AST** for the v6 grammar.
3. **Resolver + checker + slot allocator** (qualifiers, history/state slots).
4. **CodeGen → JS**; diff its output against the hand-written closures.
5. **AST interpreter** as the correctness oracle; run both on a conformance suite.
6. **Built-in library** breadth: `ta.*` → `math/str` → collections → drawings.
7. **`request.security()`** + multi-timeframe alignment.
8. **Strategy/broker** engine.
9. **Conformance corpus**: scrape documented examples, assert plot equality vs.
   expected; pin the two refuted-semantics questions (§8) with tests.

---

## 13. Hard-semantics → mechanism map (quick reference)

| Pine semantic (verified)                                        | Engine mechanism                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Whole script runs once per bar, repeatedly per realtime tick    | `Driver.runHistorical` loop + `onTick`                             |
| `close[1]`, constant offset shifts per bar, out-of-range = `na` | `SeriesStore.get(slot, off)` over a global bar counter             |
| `na` propagates through arithmetic                              | numerics = JS `NaN`; non-numerics = `NA` sentinel                  |
| `var` init-once / persist                                       | `Context.getVar(slot, init)` + `vars` map                          |
| `varip` persists across ticks                                   | separate `varips` map, exempt from `rollback()`                    |
| Realtime rollback clears vars/exprs/outputs                     | `truncateTo(committed)` + state restore + drop uncommitted outputs |
| Repainting (mutable realtime H/L/C)                             | replay open bar each tick with live tick values                    |
| `barstate.isconfirmed`                                          | `= isClose` of the current tick                                    |
| `request.security()` confirmed vs unconfirmed                   | nested engine; historical = last confirmed, realtime = developing  |
| `execTick` repaint/alert dedupe                                 | monotonic counter ++ per bar start                                 |

```

```
