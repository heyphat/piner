/**
 * strategy.* — a deterministic broker simulator (Phase 8).
 *
 * Execution model (Pine default): the script runs on each bar's close and queues
 * orders; the broker fills market orders at the NEXT bar's open, and checks
 * stop/limit/exit brackets against each bar's range. The position is kept as
 * per-entry LOTS (id, qty, fill price, fill bar, entry commission) so closes are
 * FIFO and every entry→exit pair books its own closed-trade row, TradingView-style.
 * Position, realized/open PnL, an equity curve (with intrabar drawdown/run-up
 * extremes), and the closed-trade list are tracked. Covers market/stop/limit
 * entries, close/close_all, exit brackets (per-entry profit/loss ticks, absolute
 * stop/limit, trailing stops walked along the assumed intrabar path), pyramiding,
 * slippage, commission, and process_orders_on_close.
 */
import { isNa } from '../series.js';

const DIR_LONG = 1;
const DIR_SHORT = -1;
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * Derive an order's trigger fields from its limit/stop args.
 * Both stop AND limit → a STOP-LIMIT (stop arms a resting limit); stop only → stop;
 * limit only → limit; neither → market. `price` is the stop trigger for stop/stoplimit,
 * else the limit price.
 */
function orderTrigger(limit?: number, stop?: number): Pick<Order, 'otype' | 'price' | 'limit'> {
  if (stop != null && limit != null) return { otype: 'stoplimit', price: stop, limit };
  if (stop != null) return { otype: 'stop', price: stop };
  if (limit != null) return { otype: 'limit', price: limit };
  return { otype: 'market', price: undefined };
}
/** Coerce an optional numeric arg: na/undefined → undefined (not set). */
const opt = (x: unknown): number | undefined =>
  x === undefined || isNa(x) ? undefined : Number(x);

export interface StrategyHost {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
  idx: number;
  mintick: number;
  /** Trading-day bucket for the strategy.risk intraday rules: the calendar trading
   *  day on daily-or-faster timeframes, one bucket per bar above daily. */
  tradingDayKey: number;
}

export interface StrategySettings {
  initialCapital: number;
  qtyType: 'fixed' | 'cash' | 'percent_of_equity';
  qtyValue: number;
  commissionType: 'percent' | 'cash_per_contract' | 'cash_per_order';
  commissionValue: number;
  pyramiding: number;
  slippage: number; // in ticks
  /** When true, the broker runs an extra fill pass on each bar's CLOSE tick (Pine's
   *  process_orders_on_close) so market orders fill at the same bar's close instead
   *  of the next bar's open. Default false. */
  processOrdersOnClose: boolean;
  /** Percent of a long position's value that must be covered by the strategy's own
   *  equity (margin_long). 0 disables the funds check and margin calls for longs —
   *  the Pine v5 default; v6 defaults to 100 (no leverage). */
  marginLong: number;
  /** Same for shorts (margin_short). Note that at 100 a short can still be margin
   *  called (its liquidation price is finite), unlike a fully-funded long. */
  marginShort: number;
  /** Minimum contract size of the traded symbol — the truncation unit of TV's
   *  margin-call step 9 ("we truncate the value to the same decimal point as the
   *  minimum contract size for the current symbol"). Exchange metadata, not a
   *  strategy() parameter: hosts configure it per symbol. Default 0.001 (the
   *  common crypto lot step, verified on BINANCE:XAUUSDT.P). */
  minQty: number;
}

interface Order {
  id: string;
  dir: number; // +1 long, -1 short
  qty?: number;
  kind: 'entry' | 'order' | 'close' | 'closeAll';
  otype: 'market' | 'limit' | 'stop' | 'stoplimit';
  price?: number; // limit/stop price; for stoplimit this is the STOP trigger
  limit?: number; // stoplimit only: the resting limit price once the stop triggers
  triggered?: boolean; // stoplimit only: the stop has fired → now a resting limit
  /** Submission sequence — lots inherit it so exit brackets can scope to the
   *  entries that existed when the bracket was called (Pine's rule). */
  seq?: number;
}

interface ExitBracket {
  id: string;
  fromEntry: string; // '' → every entry in scope, regardless of id
  qty?: number;
  profit?: number; // ticks (measured from each entry lot's own fill price)
  loss?: number; // ticks (measured from each entry lot's own fill price)
  stop?: number; // price
  limit?: number; // price
  trailPrice?: number; // activation price
  trailPoints?: number; // activation distance from entry (ticks)
  trailOffset?: number; // trail distance behind the extreme (ticks)
  trailStop?: number; // current ratcheting trailing-stop level (price), NaN until armed
  filled?: number; // contracts this bracket has closed (caps at `qty` when set)
  /** Call-time scope: only lots from orders submitted at-or-before this sequence
   *  are eligible — per Pine, an exit call covers entries created before or on
   *  its bar and "does not affect subsequent entries" (exit-persist demo). */
  maxSeq: number;
}

/** One open entry: `strategy.entry`/`order` fills append these; closes consume them FIFO. */
interface Lot {
  id: string;
  qty: number; // unsigned contracts remaining
  price: number; // this entry's fill price
  bar: number; // bar index of the fill
  time: number; // fill time (bar time, ms) — serves entry_time
  orderSeq: number; // submission seq of the order that opened this lot (exit scoping)
  entryCmd: boolean; // opened by strategy.entry (counts toward the pyramiding cap)
  fee: number; // entry-side commission still carried (pro-rated out as the lot closes)
  // Per-CONTRACT favorable/adverse price excursions over the lot's life (≥ 0,
  // price units), updated each mark-to-market from the bar's high/low. Being
  // per-contract they survive partial closes unscaled; a trade row multiplies by
  // its own qty. Serve max_runup / max_drawdown (+_percent).
  maxFavMove: number;
  maxAdvMove: number;
}

export interface ClosedTrade {
  entryId: string;
  dir: number;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  /** Fill times (bar time, ms) of the entry/exit — serve entry_time/exit_time. */
  entryTime: number;
  exitTime: number;
  profit: number;
  cumProfit: number;
  /** Both sides' commission booked on this row (entry share + exit share). */
  commission: number;
  /** Trade-life intrabar extremes for this row's quantity (money, ≥ 0). */
  maxRunup: number;
  maxDrawdown: number;
  /** Set on portfolio-merged ledgers only: which sleeve produced this row. */
  symbol?: string;
}

/** The broker-verbatim backtest report (`Engine.strategy` / `StrategyBroker.report()`).
 *  Derived analytics (Sharpe, Sortino, CAGR, …) are NOT here — they live in
 *  `computeStrategyMetrics` (engine/strategy-metrics.ts), which consumes this. */
export interface StrategyReport {
  initialCapital: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  wins: number;
  losses: number;
  evens: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  /** Intrabar-path run-up extremes, mirroring maxDrawdown(_percent). */
  maxRunup: number;
  maxRunupPercent: number;
  /** All commission charged, both sides (TradingView's "Commission Paid"). */
  totalCommission: number;
  closedTrades: ClosedTrade[];
  /** Per-bar equity, indexed by bar index (sparse before the strategy activated). */
  equityCurve: number[];
  /** Bars processed while the strategy was active (the exposure denominator). */
  barsProcessed: number;
  /** Bars on which a position was open after the bar's fill pass. */
  barsInMarket: number;
  /** Forced liquidations by the margin simulation (TradingView's "Margin Calls"
   *  Performance Summary field). Always 0 when margin_long/short are 0. */
  marginCalls: number;
}

/**
 * The funding account a broker draws on — extracted (portfolio plan, gate G3) so
 * several brokers can share one pot in a portfolio run while a lone broker keeps
 * today's behavior exactly: every quantity below reduces to the broker's own
 * `initial + realized (+ openProfit)` in the same floating-point order as before.
 *
 * The account holds NO PnL state of its own: realized/open PnL stay on the
 * brokers (so the realtime rollback machinery stays per-broker) and the account
 * derives portfolio sums on demand.
 */
export class Account {
  private readonly brokers: StrategyBroker[] = [];
  constructor(public initial: number) {}

  attach(b: StrategyBroker): this {
    if (!this.brokers.includes(b)) this.brokers.push(b);
    return this;
  }

  /** Σ attached brokers' realized PnL (closed trades + booked entry fees). */
  get realized(): number {
    let s = 0;
    for (const b of this.brokers) s += b.realized;
    return s;
  }

  /** Account equity: initial + Σ realized + Σ open PnL, each broker valued at its
   *  live close when its own bar is in progress and at its last mark otherwise
   *  (between a sleeve's bars the live close is NaN — stale-close reads, spec S5). */
  get equity(): number {
    let s = this.initial;
    for (const b of this.brokers) s += b.realized;
    for (const b of this.brokers) s += b.accountOpenProfit;
    return s;
  }

  /**
   * Equity with `x`'s own open position excluded — the funds base for x's margin
   * and intrabar-marking math, where own-open PnL is endogenous (re-added along
   * the bar's price path). For a private account this is exactly
   * `initial + realized`, bit-for-bit.
   */
  equityExcludingOpen(x: StrategyBroker): number {
    let s = this.initial;
    for (const b of this.brokers) s += b.realized;
    for (const b of this.brokers) if (b !== x) s += b.accountOpenProfit;
    return s;
  }

  /**
   * Σ other brokers' margin requirement at their marks — what the rest of the
   * basket already consumes of the pot. x's own funds check adds this to its own
   * requirement (spec S4: first-come-first-served in clock order), and the
   * liquidation walk treats it as spoken-for equity. 0 for a private account.
   */
  requiredMarginExcluding(x: StrategyBroker): number {
    let s = 0;
    for (const b of this.brokers) if (b !== x) s += b.accountRequiredMargin;
    return s;
  }

  /**
   * Broadcast one broker's mark-to-market equity path to EVERY OTHER attached
   * broker (spec S7). Sleeves run on disjoint clocks, so the pot's peak can land
   * at a master time where a given sleeve has no bar; without this, that
   * sleeve's peak/valley/day-max trackers under-measure the shared drawdown and
   * its `strategy.risk.max_drawdown` / `max_intraday_loss` never trip. Folding
   * every pot mark into every tracker restores S7's contract: each sleeve trips
   * at its own next mark — the portfolio halts within one bar per sleeve.
   * No-op for a private account (no other brokers), keeping V2 bit-for-bit.
   */
  broadcastMarks(pts: number[], marker: StrategyBroker): void {
    for (const b of this.brokers) if (b !== marker) b.foldEquityMarks(pts);
  }
}

export class StrategyBroker {
  active = false;
  host!: StrategyHost;
  settings: StrategySettings = {
    initialCapital: 1_000_000,
    qtyType: 'fixed',
    qtyValue: 1,
    commissionType: 'percent',
    commissionValue: 0,
    pyramiding: 1,
    slippage: 0,
    processOrdersOnClose: false,
    // Pine v6 defaults (v5 was 0/0 — declare margin_long=0, margin_short=0 to opt out).
    marginLong: 100,
    marginShort: 100,
    minQty: 0.001,
  };
  /** The funding account. Private per-broker by default (kept in sync with
   *  settings.initialCapital by configure()); a portfolio host swaps in a shared
   *  Account via setAccount(). */
  account: Account = new Account(this.settings.initialCapital).attach(this);
  /** False once a portfolio host owns the account — configure() then stops
   *  syncing settings.initialCapital into it (the pot is the host's to fund). */
  private ownAccount = true;

  /** Portfolio hook: draw on a shared account instead of the private one.
   *  Re-seeds the drawdown/run-up baselines from the shared pot. */
  setAccount(a: Account): void {
    this.account = a;
    a.attach(this);
    this.ownAccount = false;
    this.peakEquity = a.initial;
    this.valleyEquity = a.initial;
  }

  // position (aggregate size; per-entry detail lives in entryLots)
  size = 0; // signed
  /** The entry id that INITIALLY opened the live position (survives partial closes). */
  private entryId = '';
  // Per-entry open lots making up the current position, in fill order (FIFO).
  // Each lot carries its own fill price/bar/commission so `strategy.close(id)`,
  // `strategy.exit(from_entry=…)`, per-entry profit/loss tick levels, and the
  // one-trade-row-per-entry ledger all resolve against the right entry.
  private entryLots: Lot[] = [];
  /** OPEN trades opened by `strategy.entry` (the pyramiding cap's basis). Per the
   *  TV docs, a blocked entry waits "until at least one of the existing trades
   *  closes" — a close FREES capacity, so this counts live lots, not adds. */
  private get openEntryCmdCount(): number {
    let n = 0;
    for (const lt of this.entryLots) if (lt.entryCmd) n++;
    return n;
  }

  realized = 0;
  grossProfit = 0;
  grossLoss = 0;
  wins = 0;
  losses = 0;
  evens = 0;
  closedTrades: ClosedTrade[] = [];
  equityCurve: number[] = [];
  private peakEquity = 0;
  private valleyEquity = 0;
  /** Last mark-to-market price (this broker's bar close at its latest mark). */
  private lastMark = NaN;
  maxDrawdown = 0;
  maxDrawdownPercent = 0;
  maxRunup = 0;
  maxRunupPercent = 0;
  maxContractsAll = 0;
  maxContractsLong = 0;
  maxContractsShort = 0;
  // Market-exposure counters (report-only; drive the exposure % metric). A bar is
  // "in market" when a position is open after its onBar fill pass — a position
  // opened by the process_orders_on_close pass counts from the NEXT bar.
  private barsProcessed = 0;
  private barsInMarket = 0;
  /** All commission charged so far, both sides (TradingView's "Commission Paid"). */
  totalCommission = 0;
  /** Forced liquidations booked by the margin simulation (report `marginCalls`). */
  private marginCallCount = 0;

  private pending: Order[] = [];
  private exits: ExitBracket[] = [];
  /** Monotonic order-submission counter (drives exit-bracket call-time scoping). */
  private orderSeq = 0;

  // ── strategy.risk.* rule settings (declared with simple args, so the setters run
  //    idempotently every bar; repeated calls keep the most restrictive value) ─
  private riskDirection: 'all' | 'long' | 'short' = 'all';
  private riskMaxPositionSize?: number;
  private riskMaxConsLossDays?: number;
  private riskMaxDrawdownCash?: number;
  private riskMaxDrawdownPct?: number; // % of maximum equity
  private riskMaxIntradayOrders?: number;
  private riskMaxIntradayLossCash?: number;
  private riskMaxIntradayLossPct?: number; // % of the day's maximum equity
  // strategy.risk runtime state
  private riskHalted = false; // permanent halt (max_drawdown / max_cons_loss_days)
  private riskHaltedDay = NaN; // intraday halt: the trading-day key it applies to
  private riskDay = NaN; // current trading-day key
  private riskDayStartEquity = NaN; // equity when the trading day opened
  private riskDayMaxEquity = NaN; // the day's maximum equity (intraday-loss % basis)
  private riskDayFills = 0; // orders filled so far today
  private riskConsLossDays = 0; // consecutive losing trading days so far
  private riskBarCloseEquity = NaN; // equity at the last processed bar's close

  // ── realtime rollback (the driver snapshots before speculative intrabar ticks) ─
  // Fields captured/restored around every speculative tick, split by copy strategy so
  // rollback stays correct without deep-cloning the ever-growing history arrays each tick:
  //  DEEP    — arrays whose element objects mutate in place (orders gain `triggered`,
  //            brackets ratchet `trailStop`/`filled`, lots shed `qty`/`fee`): must be
  //            structuredClone'd.
  //  APPEND  — arrays only appended, with entries never mutated after (closed trades,
  //            per-bar equity): a shallow slice suffices (a later push/assign replaces the
  //            array, leaving the snapshot's copy untouched).
  //  SCALARS — primitives: assigned directly.
  private static readonly SNAP_DEEP = ['pending', 'exits', 'entryLots'] as const;
  private static readonly SNAP_APPEND = ['closedTrades', 'equityCurve'] as const;
  private static readonly SNAP_SCALARS = [
    'size',
    'entryId',
    'realized',
    'grossProfit',
    'grossLoss',
    'wins',
    'losses',
    'evens',
    'peakEquity',
    'valleyEquity',
    'lastMark',
    'maxDrawdown',
    'maxDrawdownPercent',
    'maxRunup',
    'maxRunupPercent',
    'maxContractsAll',
    'maxContractsLong',
    'maxContractsShort',
    'barsProcessed',
    'barsInMarket',
    'totalCommission',
    'marginCallCount',
    'orderSeq',
    'riskDirection',
    'riskMaxPositionSize',
    'riskMaxConsLossDays',
    'riskMaxDrawdownCash',
    'riskMaxDrawdownPct',
    'riskMaxIntradayOrders',
    'riskMaxIntradayLossCash',
    'riskMaxIntradayLossPct',
    'riskHalted',
    'riskHaltedDay',
    'riskDay',
    'riskDayStartEquity',
    'riskDayMaxEquity',
    'riskDayFills',
    'riskConsLossDays',
    'riskBarCloseEquity',
  ] as const;
  snapshot(): unknown {
    const s: Record<string, unknown> = {};
    for (const k of StrategyBroker.SNAP_DEEP) s[k] = structuredClone(this[k]);
    for (const k of StrategyBroker.SNAP_APPEND) s[k] = (this[k] as unknown[]).slice();
    for (const k of StrategyBroker.SNAP_SCALARS) s[k] = this[k];
    return s;
  }
  restore(s: unknown): void {
    const snap = s as Record<string, unknown>;
    const self = this as Record<string, unknown>;
    for (const k of StrategyBroker.SNAP_DEEP) self[k] = structuredClone(snap[k]);
    for (const k of StrategyBroker.SNAP_APPEND) self[k] = (snap[k] as unknown[]).slice();
    for (const k of StrategyBroker.SNAP_SCALARS) self[k] = snap[k];
  }

  configure(s: Partial<StrategySettings>): void {
    this.active = true;
    Object.assign(this.settings, s);
    if (this.ownAccount) this.account.initial = this.settings.initialCapital;
    this.peakEquity = this.account.initial;
    this.valleyEquity = this.account.initial;
  }

  // ── live read-backs ───────────────────────────────────────
  get equity(): number {
    return this.account.equity;
  }
  get openProfit(): number {
    return this.size === 0 ? 0 : this.size * (this.host.close - this.avgPrice);
  }
  /** The price the account values this broker at right now: the live close while
   *  this broker's own bar is in progress (bit-identical to pre-account behavior),
   *  its last mark-to-market when read between its bars — the stale-close
   *  cross-sleeve semantics of spec S5. */
  private get valuationPrice(): number {
    const c = this.host.close;
    return Number.isNaN(c) ? this.lastMark : c;
  }
  /** Open PnL for account aggregation (see valuationPrice). */
  get accountOpenProfit(): number {
    return this.size === 0 ? 0 : this.size * (this.valuationPrice - this.avgPrice);
  }
  /** This broker's margin requirement — the share of the pot it has spoken for. */
  get accountRequiredMargin(): number {
    if (this.size === 0) return 0;
    const m = (this.size > 0 ? this.settings.marginLong : this.settings.marginShort) / 100;
    return m <= 0 ? 0 : Math.abs(this.size) * this.valuationPrice * m;
  }
  get netProfit(): number {
    return this.realized;
  }
  /** The price at which the open position gets margin called — where marked equity
   *  meets the required margin (Help Center "How do I simulate trading with
   *  leverage?", PointValue = 1):
   *    P = ((initialCapital + netProfit)/|size| − D·avgPrice) / (m − D)
   *  na while flat, when the position's margin percent is 0 (no margin simulation),
   *  or for a fully-funded long (m = 1 = D → no finite liquidation price). Rounded
   *  DOWN to tick for longs, UP for shorts (Help Center: "rounded down (long
   *  positions) or up (short positions) to the nearest tick value" — P2 settled). */
  get marginLiquidationPrice(): number {
    if (this.size === 0) return NaN;
    const D = sign(this.size);
    const m = (D === DIR_LONG ? this.settings.marginLong : this.settings.marginShort) / 100;
    if (m <= 0 || m === D) return NaN;
    const raw =
      ((this.account.equityExcludingOpen(this) - this.account.requiredMarginExcluding(this)) /
        Math.abs(this.size) -
        D * this.avgPrice) /
      (m - D);
    const mt = this.host.mintick;
    if (!(mt > 0)) return raw;
    // ε guards float noise (25/0.01 = 2500.0000000000005 must not ceil to 25.01)
    return (D === DIR_LONG ? Math.floor(raw / mt + 1e-9) : Math.ceil(raw / mt - 1e-9)) * mt;
  }
  /** Profit factor: gross profit / |gross loss| (Infinity when there are no losing
   *  trades, 0 when flat). Not a Pine `strategy.*` builtin — a convenience metric
   *  computed here so consumers don't recompute it inconsistently. */
  get profitFactor(): number {
    const gl = Math.abs(this.grossLoss);
    return gl > 0 ? this.grossProfit / gl : this.grossProfit > 0 ? Infinity : 0;
  }
  /** Win rate: winning / decided (win+loss) closed trades, 0..1. Convenience metric
   *  (not a Pine builtin), computed here for a single source of truth. */
  get winRate(): number {
    const decided = this.wins + this.losses;
    return decided > 0 ? this.wins / decided : 0;
  }
  /** Weighted average fill price of the OPEN lots (NaN while flat). Derived from the
   *  lots so a partial FIFO close re-prices the remainder, as TradingView does. */
  get avgPrice(): number {
    let q = 0,
      pq = 0;
    for (const lt of this.entryLots) {
      q += lt.qty;
      pq += lt.qty * lt.price;
    }
    return q > 0 ? pq / q : NaN;
  }
  /** Open-trade count: one per open entry lot (TradingView's strategy.opentrades). */
  get openTradeCount(): number {
    return this.entryLots.length;
  }
  /** The entry id that opened the live position (empty while flat). */
  get positionEntryName(): string {
    return this.size === 0 ? '' : this.entryId;
  }

  // ── trade-return statistics (computed from the closed-trade list) ─
  private pct(t: ClosedTrade): number {
    const basis = Math.abs(t.entryPrice * t.qty);
    return basis > 0 ? (t.profit / basis) * 100 : 0;
  }
  private meanPct(filter: (t: ClosedTrade) => boolean, signFactor = 1): number {
    const xs = this.closedTrades.filter(filter);
    if (!xs.length) return 0;
    return (signFactor * xs.reduce((a, t) => a + this.pct(t), 0)) / xs.length;
  }
  avgTradePercent(): number {
    return this.meanPct(() => true);
  }
  avgWinningTradePercent(): number {
    return this.meanPct((t) => t.profit > 0);
  }
  avgLosingTradePercent(): number {
    return this.meanPct((t) => t.profit < 0, -1);
  }

  /** `strategy.closedtrades.first_index` / `strategy.opentrades.capital_held` —
   *  the two bare scalar stats hanging off the trade collections. */
  tradeStat(scope: string, field: string): number {
    if (scope === 'closedtrades' && field === 'first_index')
      return this.closedTrades.length > 0 ? 0 : NaN;
    // capital allocated to the open position (cost basis); 0 while flat.
    if (scope === 'opentrades' && field === 'capital_held')
      return this.size === 0 ? 0 : Math.abs(this.size * this.avgPrice);
    return NaN;
  }

  /** Record peak position exposure (called whenever size grows). */
  private recordExposure(): void {
    const abs = Math.abs(this.size);
    if (abs > this.maxContractsAll) this.maxContractsAll = abs;
    if (this.size > this.maxContractsLong) this.maxContractsLong = this.size;
    if (-this.size > this.maxContractsShort) this.maxContractsShort = -this.size;
  }

  private commission(qty: number, price: number): number {
    const c = this.settings;
    if (c.commissionValue <= 0) return 0;
    if (c.commissionType === 'percent') return (c.commissionValue / 100) * qty * price;
    if (c.commissionType === 'cash_per_contract') return c.commissionValue * qty;
    return c.commissionValue; // cash_per_order
  }

  private qtyFor(order: Order, price: number): number {
    if (order.qty != null && !Number.isNaN(order.qty)) return order.qty;
    return this.defaultQty(price);
  }

  /** The order quantity an entry would use at `price`, per the sizing settings.
   *  Price-derived quantities (cash / percent_of_equity) are TRUNCATED to the
   *  symbol's minimum contract size (settings.minQty), as TradingView does —
   *  verified against a TV trade ledger (equity 10067.60 @ 4740 → 2.123, not
   *  2.12396; dev-docs/margin-parity-findings.md). Explicit and fixed
   *  quantities pass through untouched (the script author's literal value). */
  defaultQty(price: number): number {
    const { qtyType, qtyValue, minQty } = this.settings;
    const trunc = (q: number) => (minQty > 0 ? Math.floor(q / minQty + 1e-9) * minQty : q);
    if (qtyType === 'cash') return trunc(qtyValue / price);
    if (qtyType === 'percent_of_equity') return trunc(((qtyValue / 100) * this.equity) / price);
    return qtyValue; // fixed
  }

  // ── order entry points (called from the script) ──────────
  /** Pine keys orders by id — re-submitting replaces the unfilled pending order in place. */
  private submit(o: Order): void {
    const i = this.pending.findIndex(
      (p) => p.id === o.id && (p.kind === 'entry' || p.kind === 'order'),
    );
    if (i >= 0) this.pending[i] = o;
    else this.pending.push(o);
  }
  entry(id: string, dir: number, qty?: number, limit?: number, stop?: number): void {
    if (!this.active || this.riskHaltActive) return;
    this.submit({
      id,
      dir,
      qty,
      kind: 'entry',
      seq: ++this.orderSeq,
      ...orderTrigger(limit, stop),
    });
  }
  order(id: string, dir: number, qty?: number, limit?: number, stop?: number): void {
    if (!this.active || this.riskHaltActive) return;
    this.submit({
      id,
      dir,
      qty,
      kind: 'order',
      seq: ++this.orderSeq,
      ...orderTrigger(limit, stop),
    });
  }
  close(id: string, qty?: number): void {
    if (!this.active || this.riskHaltActive) return;
    // Per Pine, the command has no effect unless an entry with this id is OPEN at
    // call time — a same-bar queued entry does not count, so `entry(id)` + `close(id)`
    // on one bar must not open-and-instantly-close on the next bar's fill pass.
    if (!this.entryLots.some((lt) => lt.id === id)) return;
    this.pending.push({ id, dir: 0, qty, kind: 'close', otype: 'market' });
  }
  close_all(): void {
    if (!this.active || this.riskHaltActive) return;
    // Per Pine: "if there is no open position, the function call has no effect" —
    // gated at CALL time, so it cannot pair with a same-bar entry into an instant
    // round trip on the next bar (TV's "Order execution demo" behavior).
    if (this.size === 0) return;
    this.pending.push({ id: '', dir: 0, kind: 'closeAll', otype: 'market' });
  }
  exit(
    id: string,
    fromEntry?: string,
    qty?: number,
    profit?: number,
    loss?: number,
    stop?: number,
    limit?: number,
    trailPrice?: number,
    trailPoints?: number,
    trailOffset?: number,
  ): void {
    if (!this.active || this.riskHaltActive) return;
    // Pine keys exit brackets by id — re-submitting the same id updates in place
    // rather than stacking duplicates while the position is held open.
    const bracket: ExitBracket = {
      id,
      fromEntry: fromEntry ?? '',
      qty,
      profit,
      loss,
      stop,
      limit,
      trailPrice,
      trailPoints,
      trailOffset,
      trailStop: NaN,
      maxSeq: this.orderSeq, // covers entries submitted up to THIS call (incl. same-bar earlier ones)
    };
    const i = this.exits.findIndex((e) => e.id === id);
    if (i >= 0) {
      bracket.trailStop = this.exits[i].trailStop;
      this.exits[i] = bracket;
    } else this.exits.push(bracket); // keep the trailing ratchet
  }

  // ── strategy.risk.* (risk-management rules) ───────────────
  /** Most-restrictive merge for a repeated risk-rule call (na/undefined → keep current). */
  private static riskMin(cur: number | undefined, v: number | undefined): number | undefined {
    if (v == null || Number.isNaN(v)) return cur;
    return cur == null ? v : Math.min(cur, v);
  }
  setRiskAllowEntryIn(value: string): void {
    if (!this.active) return;
    if (value === 'all' || value === 'long' || value === 'short') this.riskDirection = value;
  }
  setRiskMaxPositionSize(contracts?: number): void {
    if (!this.active) return;
    this.riskMaxPositionSize = StrategyBroker.riskMin(this.riskMaxPositionSize, contracts);
  }
  setRiskMaxConsLossDays(count?: number): void {
    if (!this.active) return;
    this.riskMaxConsLossDays = StrategyBroker.riskMin(this.riskMaxConsLossDays, count);
  }
  setRiskMaxDrawdown(value?: number, type?: string): void {
    if (!this.active) return;
    if (type === 'percent_of_equity')
      this.riskMaxDrawdownPct = StrategyBroker.riskMin(this.riskMaxDrawdownPct, value);
    else this.riskMaxDrawdownCash = StrategyBroker.riskMin(this.riskMaxDrawdownCash, value);
  }
  setRiskMaxIntradayFilledOrders(count?: number): void {
    if (!this.active) return;
    this.riskMaxIntradayOrders = StrategyBroker.riskMin(this.riskMaxIntradayOrders, count);
  }
  setRiskMaxIntradayLoss(value?: number, type?: string): void {
    if (!this.active) return;
    if (type === 'percent_of_equity')
      this.riskMaxIntradayLossPct = StrategyBroker.riskMin(this.riskMaxIntradayLossPct, value);
    else this.riskMaxIntradayLossCash = StrategyBroker.riskMin(this.riskMaxIntradayLossCash, value);
  }

  /** True while a risk rule has trading halted (for the current trading day, or for good). */
  private get riskHaltActive(): boolean {
    return this.riskHalted || this.riskHaltedDay === this.riskDay;
  }

  /**
   * A risk rule fired: cancel every pending order and exit bracket, submit one
   * emergency market order closing the whole position (it fills on the next tick
   * pass, like any market order), and halt trading — for the rest of the current
   * trading day (the intraday rules) or permanently.
   */
  private riskTrip(untilDayEnd: boolean): void {
    if (untilDayEnd) this.riskHaltedDay = this.riskDay;
    else this.riskHalted = true;
    this.pending = this.size !== 0 ? [{ id: '', dir: 0, kind: 'closeAll', otype: 'market' }] : [];
    this.exits = [];
  }

  /** Trading-day rollover: reset the intraday counters/baselines and score the day
   *  that just closed against max_cons_loss_days (a day is a loss when its closing
   *  equity finished below its opening equity). */
  private riskRollDay(): void {
    const day = this.host.tradingDayKey;
    if (day === this.riskDay) return;
    if (!Number.isNaN(this.riskDay)) {
      if (this.riskBarCloseEquity < this.riskDayStartEquity - 1e-9) this.riskConsLossDays++;
      else this.riskConsLossDays = 0;
      if (this.riskMaxConsLossDays != null && this.riskConsLossDays >= this.riskMaxConsLossDays)
        this.riskTrip(false);
    }
    this.riskDay = day;
    const eq = Number.isFinite(this.riskBarCloseEquity)
      ? this.riskBarCloseEquity
      : this.account.initial;
    this.riskDayStartEquity = eq;
    this.riskDayMaxEquity = eq;
    this.riskDayFills = 0;
  }

  /** The equity-based risk rules, checked along the bar's intrabar equity path:
   *  max_drawdown against the tracked peak-to-trough extremes, max_intraday_loss
   *  against the day's opening equity (the percent form is a share of the day's
   *  maximum equity, per the v6 reference). */
  private riskCheckEquity(pts: number[]): void {
    if (this.riskHalted) return;
    if (
      (this.riskMaxDrawdownCash != null && this.maxDrawdown >= this.riskMaxDrawdownCash - 1e-9) ||
      (this.riskMaxDrawdownPct != null && this.maxDrawdownPercent >= this.riskMaxDrawdownPct - 1e-9)
    ) {
      this.riskTrip(false);
      return;
    }
    const dayHalted = this.riskHaltedDay === this.riskDay;
    for (const v of pts) {
      if (v > this.riskDayMaxEquity) this.riskDayMaxEquity = v;
      if (dayHalted) continue;
      const loss = this.riskDayStartEquity - v;
      if (
        (this.riskMaxIntradayLossCash != null && loss >= this.riskMaxIntradayLossCash - 1e-9) ||
        (this.riskMaxIntradayLossPct != null &&
          loss >= (this.riskMaxIntradayLossPct / 100) * this.riskDayMaxEquity - 1e-9)
      ) {
        this.riskTrip(true);
        return;
      }
    }
  }

  /** Percent-of-cost-basis for a per-trade money amount (the *_percent fields). */
  private static tradePct(amount: number, entryPrice: number, qty: number): number {
    const basis = Math.abs(entryPrice * qty);
    return basis > 0 ? (amount / basis) * 100 : 0;
  }

  /** A closed trade's field, or an open entry lot's (one open trade per lot). */
  tradeField(scope: string, field: string, i: number): number | string {
    const k = Math.trunc(i);
    if (scope === 'closedtrades') {
      const t = this.closedTrades[k];
      if (!t) return NaN;
      switch (field) {
        case 'profit':
          return t.profit;
        case 'profit_percent':
          return StrategyBroker.tradePct(t.profit, t.entryPrice, t.qty);
        case 'entry_price':
          return t.entryPrice;
        case 'exit_price':
          return t.exitPrice;
        case 'entry_bar_index':
          return t.entryBar;
        case 'exit_bar_index':
          return t.exitBar;
        case 'entry_time':
          return t.entryTime;
        case 'exit_time':
          return t.exitTime;
        case 'size':
          return t.dir * t.qty;
        case 'entry_id':
          return t.entryId;
        case 'commission':
          return t.commission;
        case 'max_runup':
          return t.maxRunup;
        case 'max_runup_percent':
          return StrategyBroker.tradePct(t.maxRunup, t.entryPrice, t.qty);
        case 'max_drawdown':
          return t.maxDrawdown;
        case 'max_drawdown_percent':
          return StrategyBroker.tradePct(t.maxDrawdown, t.entryPrice, t.qty);
        case 'cumprofit':
        case 'cumulative_profit':
          return t.cumProfit;
        default:
          return NaN; // entry_comment / exit_comment / exit_id not tracked in v1
      }
    }
    const lot = this.entryLots[k];
    if (!lot) return NaN;
    const dir = sign(this.size);
    switch (field) {
      case 'profit':
        return dir * (this.host.close - lot.price) * lot.qty;
      case 'profit_percent':
        return StrategyBroker.tradePct(
          dir * (this.host.close - lot.price) * lot.qty,
          lot.price,
          lot.qty,
        );
      case 'entry_price':
        return lot.price;
      case 'entry_bar_index':
        return lot.bar;
      case 'entry_time':
        return lot.time;
      case 'size':
        return dir * lot.qty;
      case 'entry_id':
        return lot.id;
      case 'commission':
        return lot.fee; // the (remaining) entry-side commission carried by the open trade
      case 'max_runup':
        return lot.maxFavMove * lot.qty;
      case 'max_runup_percent':
        return StrategyBroker.tradePct(lot.maxFavMove * lot.qty, lot.price, lot.qty);
      case 'max_drawdown':
        return lot.maxAdvMove * lot.qty;
      case 'max_drawdown_percent':
        return StrategyBroker.tradePct(lot.maxAdvMove * lot.qty, lot.price, lot.qty);
      default:
        return NaN;
    }
  }
  /** Market orders can't be canceled (they execute on the next tick regardless);
   *  everything else keyed by the id goes — including exit brackets, per Pine. */
  cancel(id: string): void {
    this.pending = this.pending.filter((o) => o.id !== id || o.otype === 'market');
    this.exits = this.exits.filter((e) => e.id !== id);
  }
  cancel_all(): void {
    this.pending = this.pending.filter((o) => o.otype === 'market');
    this.exits = [];
  }

  // ── per-bar processing (driver hooks) ─────────────────────
  /** Bar open (before the script body): fill against the bar's full range. */
  onBar(): void {
    if (!this.active) return;
    this.riskRollDay();
    const { open, high, low } = this.host;
    this.processTick(open, high, low, open);
    this.barsProcessed++;
    if (this.size !== 0) this.barsInMarket++;
  }

  /**
   * process_orders_on_close — an extra fill pass AFTER the script body runs, on the
   * bar's CLOSE treated as a one-price tick (o=h=l=close). Market orders created this
   * bar fill here at the close; limit/stop orders and exit brackets are checked against
   * the close price ONLY — never the bar's earlier range, which predates the orders.
   */
  onBarClose(): void {
    if (!this.active || !this.settings.processOrdersOnClose) return;
    const { close } = this.host;
    this.processTick(close, close, close, close);
  }

  /** One fill pass over the tick's assumed range [l, h] starting at `o`;
   *  market orders fill at `marketPx`. Re-marks this bar's equity. */
  private processTick(o: number, h: number, l: number, marketPx: number): void {
    const slip = this.settings.slippage * this.host.mintick;

    // 1. pending orders
    const stillPending: Order[] = [];
    for (const or of this.pending) {
      if (or.otype === 'market') {
        this.fill(or, marketPx + sign(or.dir || -sign(this.size)) * slip);
      } else if (or.otype === 'limit') {
        // buy limit: gap through the price fills at the (better) open, else at the price if low <= it
        const p = or.price!;
        if (or.dir === DIR_LONG ? o <= p : o >= p) this.fill(or, o);
        else if (or.dir === DIR_LONG ? l <= p : h >= p) this.fill(or, p);
        else stillPending.push(or);
      } else if (or.otype === 'stop') {
        // buy stop: gap through the price fills at the open; slippage applies (adverse)
        const p = or.price!;
        if (or.dir === DIR_LONG ? o >= p : o <= p) this.fill(or, o + or.dir * slip);
        else if (or.dir === DIR_LONG ? h >= p : l <= p) this.fill(or, p + or.dir * slip);
        else stillPending.push(or);
      } else {
        // stoplimit: the stop arms a resting limit, which then fills at the limit price
        const wasTriggered = or.triggered;
        if (!or.triggered) {
          const stopHit = or.dir === DIR_LONG ? h >= or.price! : l <= or.price!;
          if (stopHit) or.triggered = true; // armed — may still fill this same tick below
        }
        if (or.triggered) {
          const p = or.limit!;
          // a limit resting since a PRIOR tick is open-bounded like any limit order
          if (wasTriggered && (or.dir === DIR_LONG ? o <= p : o >= p)) this.fill(or, o);
          else if (or.dir === DIR_LONG ? l <= p : h >= p) this.fill(or, p);
          else stillPending.push(or); // keep `triggered`
        } else {
          stillPending.push(or);
        }
      }
    }
    this.pending = stillPending;

    // 2. exit brackets against the tick's range
    if (this.size !== 0 && this.exits.length) this.processExits(o, h, l);

    // 2b. strategy.risk.max_intraday_filled_orders — reaching the cap cancels
    // everything, closes the position, and halts until the day ends.
    if (
      this.riskMaxIntradayOrders != null &&
      !this.riskHaltActive &&
      this.riskDayFills >= this.riskMaxIntradayOrders
    )
      this.riskTrip(true);

    // 3. mark-to-market (also runs the equity-based risk rules)
    this.markToMarket(o, h, l);
    this.riskBarCloseEquity = this.equity;
  }

  /** Update the equity curve and drawdown/run-up extremes. TradingView computes the
   *  extremes from INTRABAR equity, so walk the bar's assumed price path
   *  (open → nearer extreme → farther extreme → close), not just the close. */
  private markToMarket(o: number, h: number, l: number): void {
    // Mark FIRST so this.equity (account-derived, mark-based) reads this bar's close.
    this.lastMark = this.host.close;
    const eq = this.equity;
    this.equityCurve[this.host.idx] = eq;
    let pts: number[];
    if (this.size === 0) {
      pts = [eq];
    } else {
      const base = this.account.equityExcludingOpen(this);
      const path = h - o < o - l ? [o, h, l, this.host.close] : [o, l, h, this.host.close];
      pts = path.map((px) => base + this.size * (px - this.avgPrice));
    }
    for (const v of pts) {
      if (v > this.peakEquity) this.peakEquity = v;
      if (v < this.valleyEquity) this.valleyEquity = v;
      const dd = this.peakEquity - v;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
      if (this.peakEquity > 0)
        this.maxDrawdownPercent = Math.max(this.maxDrawdownPercent, (dd / this.peakEquity) * 100);
      const ru = v - this.valleyEquity;
      if (ru > this.maxRunup) this.maxRunup = ru;
      if (this.valleyEquity > 0)
        this.maxRunupPercent = Math.max(this.maxRunupPercent, (ru / this.valleyEquity) * 100);
    }
    // Spec S7: every pot mark is observed by every OTHER attached broker too, so
    // a sleeve's trackers see marks that land between its own bars (disjoint
    // clocks). Trip TESTS still run only at each sleeve's own marks, below.
    // No-op for a private account.
    this.account.broadcastMarks(pts, this);
    // Per-lot trade excursions: the bar's favorable/adverse per-contract price
    // moves relative to each open entry (a lot removed by this pass's fills no
    // longer marks — its life ended at its exit fill, TradingView-style).
    if (this.size !== 0) {
      const dir = sign(this.size);
      for (const lot of this.entryLots) {
        const fav = dir === DIR_LONG ? h - lot.price : lot.price - l;
        const adv = dir === DIR_LONG ? lot.price - l : h - lot.price;
        if (fav > lot.maxFavMove) lot.maxFavMove = fav;
        if (adv > lot.maxAdvMove) lot.maxAdvMove = adv;
      }
    }
    this.recordExposure();
    this.riskCheckEquity(pts);
    this.marginCheck(o, h, l);
  }

  /**
   * Account hook (spec S7): fold another sleeve's mark-to-market equity path into
   * THIS broker's running extremes and intraday-max ratchet, so risk trackers
   * observe the full pot path even between this sleeve's own bars. The exact same
   * per-point math as markToMarket's extremes loop; trip tests do NOT run here —
   * per S7 a sleeve trips at its own next mark (riskCheckEquity on its own bars).
   * Only ever called by a shared Account; a private account has no other brokers.
   */
  foldEquityMarks(pts: number[]): void {
    for (const v of pts) {
      if (v > this.peakEquity) this.peakEquity = v;
      if (v < this.valleyEquity) this.valleyEquity = v;
      const dd = this.peakEquity - v;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
      if (this.peakEquity > 0)
        this.maxDrawdownPercent = Math.max(this.maxDrawdownPercent, (dd / this.peakEquity) * 100);
      const ru = v - this.valleyEquity;
      if (ru > this.maxRunup) this.maxRunup = ru;
      if (this.valleyEquity > 0)
        this.maxRunupPercent = Math.max(this.maxRunupPercent, (ru / this.valleyEquity) * 100);
      // Intraday-loss % basis (S7): the day's max POT equity, marks from any sleeve.
      if (v > this.riskDayMaxEquity) this.riskDayMaxEquity = v;
    }
  }

  /**
   * Margin-call simulation, matched to TradingView's broker emulator: the
   * Help Center "How do I simulate trading with leverage?" 10-step algorithm,
   * empirically verified against a 42-event TV margin-call ledger
   * (dev-docs/margin-parity-findings.md — BINANCE:XAUUSDT.P 15m, every event's
   * fill price AND quantity reproduced exactly). PointValue = 1.
   *
   * ONE evaluation per bar, at the bar's WORST price for the position (low for
   * longs, high for shorts) — TV's observed fill point. At that price p:
   *   deficit   = requiredMargin(p) − equity(p)        (> 0 ⇒ margin call)
   *   moneyLost = deficit / m                          (TV step 8)
   *   q9        = trunc(moneyLost / p → minQty)        (TV step 9: truncate to
   *               the symbol's minimum contract size — settings.minQty)
   *   qLiq      = min(q9 > 0 ? 4·q9 : 1, |size|)       (TV step 10: 4× "so a
   *               Margin Call event isn't constantly triggered"; when the
   *               truncation yields 0 the emulator liquidates ONE whole unit —
   *               observed on 13 events, not documented)
   * A bar still deficient after the call fires again on the NEXT bar (repeat
   * same-bar liquidations were never observed). Unlike a risk-rule trip this
   * is NOT a halt: pending orders and exit brackets survive, now covering a
   * smaller position.
   */
  private marginCheck(_o: number, h: number, l: number): void {
    if (this.size === 0) return;
    const pct = this.size > 0 ? this.settings.marginLong : this.settings.marginShort;
    const m = pct / 100;
    if (m <= 0) return;
    const p = this.size > 0 ? l : h; // the bar's worst price for the position
    const equity = this.account.equityExcludingOpen(this) + this.size * (p - this.avgPrice);
    const required = p * Math.abs(this.size) * m + this.account.requiredMarginExcluding(this);
    const deficit = required - equity;
    if (deficit <= 1e-9) return; // no loss to cover (incl. the exact-boundary case)
    const step = this.settings.minQty;
    const qToCover = deficit / m / p; // steps 8+9 pre-truncation (money lost ÷ price)
    const q9 = step > 0 ? Math.floor(qToCover / step + 1e-9) * step : qToCover;
    const qLiquidate = Math.min(q9 > 0 ? 4 * q9 : 1, Math.abs(this.size));
    this.closePosition(p, qLiquidate);
    this.marginCallCount++;
    // The bar's equity was curve-marked before the check; the liquidation realizes
    // the loss mid-bar, so re-mark the close with the post-call position. (Drawdown
    // extremes keep the pre-call marks — the dip through the extreme genuinely
    // happened.)
    this.equityCurve[this.host.idx] = this.equity;
  }

  private processExits(o: number, h: number, l: number): void {
    const mt = this.host.mintick;
    const slip = this.settings.slippage * mt;
    // intrabar path heuristic: the extreme nearer the open is assumed hit first
    const highFirst = h - o < o - l;
    // Pine: when BOTH an absolute price and a tick-distance resolve the same side
    // (stop+loss, limit+profit), the level expected to trigger FIRST wins — i.e. the
    // one nearer the market (long stop: the higher; long limit: the lower).
    const firstOf = (
      a: number | undefined,
      b: number | undefined,
      wantHigh: boolean,
    ): number | undefined =>
      a == null ? b : b == null ? a : wantHigh ? Math.max(a, b) : Math.min(a, b);
    // A bracket's scope: lots matching its from_entry filter whose originating
    // order existed when the bracket was called (maxSeq) — later same-id entries
    // are NOT covered (Pine's exit-persist rule).
    const eligible = (ex: ExitBracket) => (lt: Lot) =>
      (!ex.fromEntry || lt.id === ex.fromEntry) && lt.orderSeq <= ex.maxSeq;
    // Pine RESERVES exit quantity in call order: each bracket may only fill what
    // earlier brackets left unreserved of its eligible lots — so a later, larger
    // bracket triggering FIRST still takes only its unreserved share (the
    // reversed-exit demo: qty-19 limit + qty-20 stop on 20 shares → the stop
    // covers exactly 1).
    const unreserved = new Map<Lot, number>();
    for (const lt of this.entryLots) unreserved.set(lt, lt.qty);
    const allot = new Map<ExitBracket, number>();
    for (const ex of this.exits) {
      const isElig = eligible(ex);
      let want = ex.qty != null ? Math.max(0, ex.qty - (ex.filled ?? 0)) : Infinity;
      let granted = 0;
      for (const lt of this.entryLots) {
        if (want <= 0) break;
        if (!isElig(lt)) continue;
        const take = Math.min(unreserved.get(lt) ?? 0, want);
        if (take > 0) {
          unreserved.set(lt, (unreserved.get(lt) ?? 0) - take);
          granted += take;
          want -= take;
        }
      }
      allot.set(ex, granted);
    }
    const keep: ExitBracket[] = [];
    for (const ex of this.exits) {
      if (this.size === 0) break;
      const dir = sign(this.size);
      const isElig = eligible(ex);
      let remaining = allot.get(ex) ?? 0;
      const book = (lot: Lot, take: number, px: number, fee?: number) => {
        this.closeLot(lot, take, px, fee);
        ex.filled = (ex.filled ?? 0) + take;
        remaining -= take;
        this.riskDayFills++; // each lot's exit is its own order (risk fill counting)
      };
      // Each eligible entry lot gets its OWN exit order: profit/loss tick levels are
      // measured from that lot's fill price (absolute stop/limit prices are shared).
      for (const lot of this.entryLots.filter(isElig)) {
        if (remaining <= 0 || this.size === 0) break;
        const stopPx = firstOf(
          ex.stop,
          ex.loss != null ? lot.price - dir * ex.loss * mt : undefined,
          dir === DIR_LONG,
        );
        const limitPx = firstOf(
          ex.limit,
          ex.profit != null ? lot.price + dir * ex.profit * mt : undefined,
          dir === DIR_SHORT,
        );
        const take = Math.min(lot.qty, remaining);
        // open-gap fills happen on the tick's first price and pre-empt the intrabar path;
        // a gap through the level fills at the open (stop: worse + slippage, limit: better)
        if (stopPx != null && (dir === DIR_LONG ? o <= stopPx : o >= stopPx)) {
          book(lot, take, o - dir * slip);
          continue;
        }
        if (limitPx != null && (dir === DIR_LONG ? o >= limitPx : o <= limitPx)) {
          book(lot, take, o);
          continue;
        }
        const stopHit = stopPx != null && (dir === DIR_LONG ? l <= stopPx : h >= stopPx);
        const limitHit = limitPx != null && (dir === DIR_LONG ? h >= limitPx : l <= limitPx);
        // for a long the stop sits on the low side, the limit on the high side (short: swapped)
        const stopFirst = dir === DIR_LONG ? !highFirst : highFirst;
        if (stopHit && (stopFirst || !limitHit)) {
          book(lot, take, stopPx! - dir * slip);
          continue;
        }
        if (limitHit) book(lot, take, limitPx!);
      }
      // trailing stop (position-aggregate): arm at trail_price (or entry ± trail_points·tick),
      // ratchet trail_offset ticks behind the favorable extreme, fill where the path crosses it.
      if (
        this.size !== 0 &&
        remaining > 0 &&
        ex.trailOffset != null &&
        (ex.trailPoints != null || ex.trailPrice != null)
      ) {
        const fillPx = this.trailFill(ex, sign(this.size), o, h, l);
        if (fillPx != null) {
          const px = fillPx - sign(this.size) * slip; // a stop order → adverse slippage
          const lots = this.entryLots.filter(isElig);
          const group = Math.min(
            remaining,
            lots.reduce((a, lt) => a + lt.qty, 0),
          );
          for (const lot of lots) {
            // one stop order → one order-level fee, pro-rated
            if (remaining <= 0) break;
            const take = Math.min(lot.qty, remaining);
            book(lot, take, px, this.commission(group, px) * (take / group));
          }
        }
      }
      // A bracket is spent once it has filled its qty cap or exhausted its eligible lots;
      // an unfilled one — or one still holding eligible lots — stays armed. A bracket with
      // no matching lots yet (its from_entry hasn't filled) waits for the entry.
      const anyLeft = this.entryLots.some(isElig);
      const spent =
        (ex.filled ?? 0) > 0 && (!anyLeft || (ex.qty != null && (ex.filled ?? 0) >= ex.qty - 1e-9));
      if (!spent) keep.push(ex);
    }
    this.exits = this.size === 0 ? [] : keep;
  }

  /**
   * Advance a trailing stop across this tick's assumed intrabar path
   * (open → nearer extreme → farther extreme → close): arm when the path reaches the
   * activation level, ratchet `trail_offset` ticks behind each favorable price, and
   * report a hit the moment the path crosses the ratcheted level — so a low that
   * occurs BEFORE arming can no longer trigger, and the ratchet can't use an extreme
   * the path hasn't reached yet. Mutates `ex.trailStop`. Returns the fill price
   * (the stop level, or the open on a gap-through), else undefined.
   */
  private trailFill(
    ex: ExitBracket,
    dir: number,
    o: number,
    h: number,
    l: number,
  ): number | undefined {
    const mt = this.host.mintick;
    const off = ex.trailOffset! * mt;
    const act =
      ex.trailPrice != null ? ex.trailPrice : this.avgPrice + dir * (ex.trailPoints ?? 0) * mt;
    const path = h - o < o - l ? [o, h, l, this.host.close] : [o, l, h, this.host.close];
    let stop = ex.trailStop!; // NaN until armed
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (!Number.isNaN(stop) && (dir === DIR_LONG ? p <= stop : p >= stop)) {
        ex.trailStop = stop;
        return i === 0 ? p : stop; // an opening gap through the stop fills at the open
      }
      const cand = p - dir * off;
      if (Number.isNaN(stop)) {
        if (dir === DIR_LONG ? p >= act : p <= act) stop = cand; // armed
      } else {
        stop = dir === DIR_LONG ? Math.max(stop, cand) : Math.min(stop, cand);
      }
    }
    ex.trailStop = stop;
    return undefined;
  }

  /** Execute an order, counting it toward the intraday filled-orders risk rule when
   *  it actually trades (a blocked or no-op order is not a fill). */
  private fill(o: Order, price: number): void {
    const size = this.size,
      lots = this.entryLots.length,
      closed = this.closedTrades.length;
    this.execute(o, price);
    if (this.size !== size || this.entryLots.length !== lots || this.closedTrades.length !== closed)
      this.riskDayFills++;
  }

  private execute(o: Order, price: number): void {
    if (o.kind === 'closeAll') {
      this.closePosition(price, o.qty);
      return;
    }
    if (o.kind === 'close') {
      // strategy.close(id) closes the quantity opened under THAT entry id (a no-op if the id
      // holds nothing open) — including a pyramided add whose id is not the first entry's.
      this.closePosition(price, o.qty, o.id);
      return;
    }
    const dir = o.dir;
    // strategy.risk.allow_entry_in — an entry against the allowed direction never
    // opens a position: with an open opposite position it closes it (no reversal),
    // while flat it is a no-op.
    if (o.kind === 'entry' && this.riskDirection !== 'all') {
      const allowed = this.riskDirection === 'long' ? DIR_LONG : DIR_SHORT;
      if (dir !== allowed) {
        if (this.size !== 0 && sign(this.size) !== dir) this.closePosition(price);
        return;
      }
    }
    if (this.size !== 0 && sign(this.size) !== dir) {
      if (o.kind === 'entry') {
        this.closePosition(price); // entry REVERSES: flat first, then open the full qty
      } else {
        // strategy.order NETS: reduce the position; a crossing remainder opens the flip
        const qty = this.qtyFor(o, price);
        if (qty <= 0) return;
        const closable = Math.min(qty, Math.abs(this.size));
        this.closePosition(price, closable);
        const rem = qty - closable;
        if (rem > 0) this.openOrAdd(o, dir, rem, price);
        return;
      }
    } else if (this.size !== 0 && o.kind === 'entry') {
      // pyramiding: cap OPEN strategy.entry trades at settings.pyramiding
      // (strategy.order is uncapped, matching TradingView). A closed trade frees
      // capacity — TV: blocked "until at least one of the existing trades closes".
      if (this.openEntryCmdCount >= this.settings.pyramiding) return;
    }
    let qty = this.qtyFor(o, price);
    // strategy.risk.max_position_size — reduce an ENTRY's quantity so the resulting
    // position cannot exceed the cap; an entry with no room left is not placed.
    if (o.kind === 'entry' && this.riskMaxPositionSize != null)
      qty = Math.min(qty, this.riskMaxPositionSize - Math.abs(this.size));
    if (qty <= 0) return;
    this.openOrAdd(o, dir, qty, price);
  }

  /** Open a new position (or add a lot to the same-direction one) and book the entry commission. */
  private openOrAdd(o: Order, dir: number, qty: number, price: number): void {
    const fee = this.commission(qty, price);
    // Margin gate (Pine v6): an exposure-increasing fill whose resulting position
    // would require more equity than is available at the fill price is REJECTED
    // outright — not reduced ("the strategy does not open entries that require more
    // money than is available", v6 migration guide). Only this opening path is
    // gated; closes and the reducing leg of a netting order always execute. The
    // entry fee debits equity at fill, so it counts against affordability (parity
    // question P4). m = 0 restores the v5 no-funds-check behavior.
    const m = (dir === DIR_LONG ? this.settings.marginLong : this.settings.marginShort) / 100;
    if (m > 0) {
      const base = this.account.equityExcludingOpen(this);
      const equityAtFill = this.size === 0 ? base : base + this.size * (price - this.avgPrice);
      // Under a shared account the rest of the basket's margin is spoken for
      // (spec S4 — first-come-first-served); 0 for a private account.
      const required =
        price * (Math.abs(this.size) + qty) * m + this.account.requiredMarginExcluding(this);
      if (equityAtFill - fee < required - 1e-9) return;
    }
    const lot: Lot = {
      id: o.id,
      qty,
      price,
      bar: this.host.idx,
      time: this.host.time,
      orderSeq: o.seq ?? 0,
      entryCmd: o.kind === 'entry',
      fee,
      maxFavMove: 0,
      maxAdvMove: 0,
    };
    if (this.size === 0) {
      this.size = dir * qty;
      this.entryId = o.id;
      this.entryLots = [lot];
    } else {
      this.size += dir * qty;
      this.entryLots.push(lot);
    }
    this.recordExposure();
    this.realized -= fee; // carried per-lot; pro-rated into each trade's profit on close
    this.totalCommission += fee;
  }

  /** Live closed-trade list + equity curve for the engine's strategy report. */
  report(): StrategyReport {
    return {
      // The funding account's capital — identical to settings.initialCapital for a
      // private account (configure() syncs them); the POT under a shared account,
      // matching what strategy.initial_capital reads inside the script (spec S2).
      initialCapital: this.account.initial,
      netProfit: this.netProfit,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      wins: this.wins,
      losses: this.losses,
      evens: this.evens,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPercent: this.maxDrawdownPercent,
      maxRunup: this.maxRunup,
      maxRunupPercent: this.maxRunupPercent,
      totalCommission: this.totalCommission,
      closedTrades: this.closedTrades,
      equityCurve: this.equityCurve,
      barsProcessed: this.barsProcessed,
      barsInMarket: this.barsInMarket,
      marginCalls: this.marginCallCount,
    };
  }

  /**
   * Close some (or all) of the open position at `price`, consuming lots FIFO and
   * booking one closed-trade row per entry lot touched (TradingView's ledger shape).
   * @param qty      max contracts to close (default: the whole eligible quantity).
   * @param entryId  when set, restrict the close to the lots opened under this entry id
   *                 (`strategy.close(id)`), a no-op if that id holds nothing open.
   */
  private closePosition(price: number, qty?: number, entryId?: string): void {
    if (this.size === 0) return;
    const lots = this.entryLots.filter((lt) => entryId == null || lt.id === entryId);
    const eligible = lots.reduce((a, lt) => a + lt.qty, 0);
    if (eligible <= 0) return; // named entry id has no open quantity → no-op
    const closeQty = qty != null && !Number.isNaN(qty) ? Math.min(qty, eligible) : eligible;
    if (closeQty <= 0) return;
    // one market order → one order-level exit fee, pro-rated across the trade rows
    const totalFee = this.commission(closeQty, price);
    let rem = closeQty;
    for (const lot of lots) {
      if (rem <= 0) break;
      const take = Math.min(lot.qty, rem);
      this.closeLot(lot, take, price, totalFee * (take / closeQty));
      rem -= take;
    }
  }

  /**
   * Close `take` contracts of ONE entry lot at `price`, booking its closed-trade row.
   * Trade profit nets both sides' commission: this fill's exit fee (`exitFee`, defaulting
   * to a standalone order's commission — group fills pass a pro-rated share) plus the
   * lot's carried entry fee. The entry side was already charged to `realized` at fill
   * time, so only the exit side moves realized here.
   */
  private closeLot(
    lot: Lot,
    take: number,
    price: number,
    exitFee = this.commission(take, price),
  ): void {
    const dir = sign(this.size);
    const entryFee = lot.fee * (take / lot.qty);
    lot.fee -= entryFee;
    const profit = dir * (price - lot.price) * take - exitFee - entryFee;
    this.realized += profit + entryFee;
    this.totalCommission += exitFee;
    if (profit > 0) {
      this.grossProfit += profit;
      this.wins++;
    } else if (profit < 0) {
      this.grossLoss += -profit;
      this.losses++;
    } else this.evens++;
    this.closedTrades.push({
      entryId: lot.id,
      dir,
      qty: take,
      entryPrice: lot.price,
      exitPrice: price,
      entryBar: lot.bar,
      exitBar: this.host.idx,
      entryTime: lot.time,
      exitTime: this.host.time,
      profit,
      cumProfit: this.realized,
      commission: entryFee + exitFee,
      maxRunup: lot.maxFavMove * take,
      maxDrawdown: lot.maxAdvMove * take,
    });
    lot.qty -= take;
    if (lot.qty <= 1e-9) this.entryLots.splice(this.entryLots.indexOf(lot), 1);
    this.size = dir * (Math.abs(this.size) - take);
    if (Math.abs(this.size) <= 1e-9 || this.entryLots.length === 0) {
      this.size = 0;
      this.entryId = '';
      this.entryLots = [];
      this.exits = [];
    }
  }
}

/**
 * strategy.* namespace facade — order functions (with `when`-gating + arg
 * coercion), live read-back getters, and the direction/qty/commission constants.
 */
export function makeStrategyNs(b: StrategyBroker) {
  const gated = (when: unknown, fn: () => void) => {
    if (when !== false) fn();
  };
  return {
    long: DIR_LONG,
    short: DIR_SHORT,
    fixed: 'fixed' as const,
    cash: 'cash' as const,
    percent_of_equity: 'percent_of_equity' as const,
    commission: {
      percent: 'percent',
      cash_per_contract: 'cash_per_contract',
      cash_per_order: 'cash_per_order',
    },
    oca: { none: 'none', cancel: 'cancel', reduce: 'reduce' },
    direction: { all: 'all', long: 'long', short: 'short' },

    /** strategy.risk.* — risk-management rules (broker halt logic). The
     *  alert_message args are accepted and ignored (no alert feed in piner). */
    risk: {
      allow_entry_in: (value: unknown) => b.setRiskAllowEntryIn(String(value)),
      max_cons_loss_days: (count: unknown, _alertMessage?: unknown) =>
        b.setRiskMaxConsLossDays(opt(count)),
      max_drawdown: (value: unknown, type?: unknown, _alertMessage?: unknown) =>
        b.setRiskMaxDrawdown(opt(value), typeof type === 'string' ? type : undefined),
      max_intraday_filled_orders: (count: unknown, _alertMessage?: unknown) =>
        b.setRiskMaxIntradayFilledOrders(opt(count)),
      max_intraday_loss: (value: unknown, type?: unknown, _alertMessage?: unknown) =>
        b.setRiskMaxIntradayLoss(opt(value), typeof type === 'string' ? type : undefined),
      max_position_size: (contracts: unknown) => b.setRiskMaxPositionSize(opt(contracts)),
    },

    entry: (
      id: unknown,
      dir: unknown,
      qty?: unknown,
      limit?: unknown,
      stop?: unknown,
      when?: unknown,
    ) => gated(when, () => b.entry(String(id), Number(dir), opt(qty), opt(limit), opt(stop))),
    order: (
      id: unknown,
      dir: unknown,
      qty?: unknown,
      limit?: unknown,
      stop?: unknown,
      when?: unknown,
    ) => gated(when, () => b.order(String(id), Number(dir), opt(qty), opt(limit), opt(stop))),
    close: (id: unknown, qty?: unknown, when?: unknown) =>
      gated(when, () => b.close(String(id), opt(qty))),
    close_all: (when?: unknown) => gated(when, () => b.close_all()),
    exit: (
      id: unknown,
      fromEntry?: unknown,
      qty?: unknown,
      profit?: unknown,
      loss?: unknown,
      stop?: unknown,
      limit?: unknown,
      trailPrice?: unknown,
      trailPoints?: unknown,
      trailOffset?: unknown,
      when?: unknown,
    ) =>
      gated(when, () =>
        b.exit(
          String(id),
          fromEntry == null || isNa(fromEntry) ? undefined : String(fromEntry),
          opt(qty),
          opt(profit),
          opt(loss),
          opt(stop),
          opt(limit),
          opt(trailPrice),
          opt(trailPoints),
          opt(trailOffset),
        ),
      ),
    /** strategy.closedtrades.X(i) / strategy.opentrades.X(i) — per-trade introspection. */
    tradeField: (scope: unknown, field: unknown, i: unknown) =>
      b.tradeField(String(scope), String(field), opt(i) ?? 0),
    /** strategy.closedtrades.first_index / strategy.opentrades.capital_held — bare scalar stats. */
    tradeStat: (scope: unknown, field: unknown) => b.tradeStat(String(scope), String(field)),
    default_entry_qty: (price: unknown) => b.defaultQty(opt(price) ?? b.host.close),
    cancel: (id: unknown, when?: unknown) => gated(when, () => b.cancel(String(id))),
    cancel_all: (when?: unknown) => gated(when, () => b.cancel_all()),

    get position_size() {
      return b.size;
    },
    get position_avg_price() {
      return b.size === 0 ? NaN : b.avgPrice;
    },
    get equity() {
      return b.equity;
    },
    get openprofit() {
      return b.openProfit;
    },
    get netprofit() {
      return b.netProfit;
    },
    get grossprofit() {
      return b.grossProfit;
    },
    get grossloss() {
      return b.grossLoss;
    },
    get wintrades() {
      return b.wins;
    },
    get losstrades() {
      return b.losses;
    },
    get eventrades() {
      return b.evens;
    },
    get closedtrades() {
      return b.closedTrades.length;
    },
    get opentrades() {
      return b.openTradeCount;
    },
    // Account-level (portfolio spec S2): under a shared account these read the
    // pot, not the sleeve's header — identical for a private account.
    get initial_capital() {
      return b.account.initial;
    },
    get max_drawdown() {
      return b.maxDrawdown;
    },
    get account_currency() {
      return 'USD';
    },

    // ── performance statistics (percent / averages / extremes) ──
    get netprofit_percent() {
      return b.account.initial ? (b.netProfit / b.account.initial) * 100 : 0;
    },
    get openprofit_percent() {
      return b.account.initial ? (b.openProfit / b.account.initial) * 100 : 0;
    },
    get grossprofit_percent() {
      return b.account.initial ? (b.grossProfit / b.account.initial) * 100 : 0;
    },
    get grossloss_percent() {
      return b.account.initial ? (b.grossLoss / b.account.initial) * 100 : 0;
    },
    get max_drawdown_percent() {
      return b.maxDrawdownPercent;
    },
    get max_runup() {
      return b.maxRunup;
    },
    get max_runup_percent() {
      return b.maxRunupPercent;
    },
    get avg_trade() {
      return b.closedTrades.length ? b.netProfit / b.closedTrades.length : 0;
    },
    get avg_trade_percent() {
      return b.avgTradePercent();
    },
    get avg_winning_trade() {
      return b.wins ? b.grossProfit / b.wins : 0;
    },
    get avg_winning_trade_percent() {
      return b.avgWinningTradePercent();
    },
    get avg_losing_trade() {
      return b.losses ? b.grossLoss / b.losses : 0;
    },
    get avg_losing_trade_percent() {
      return b.avgLosingTradePercent();
    },
    get max_contracts_held_all() {
      return b.maxContractsAll;
    },
    get max_contracts_held_long() {
      return b.maxContractsLong;
    },
    get max_contracts_held_short() {
      return b.maxContractsShort;
    },
    get position_entry_name() {
      return b.positionEntryName;
    },
    /** Margin liquidation price of the open position (na while flat, when the
     *  position side's margin percent is 0, or for a fully-funded long). */
    get margin_liquidation_price() {
      return b.marginLiquidationPrice;
    },
  };
}
