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
const opt = (x: unknown): number | undefined => (x === undefined || isNa(x) ? undefined : Number(x));

export interface StrategyHost {
  open: number; high: number; low: number; close: number; time: number; idx: number;
  mintick: number;
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
}

interface ExitBracket {
  id: string;
  fromEntry: string; // '' → applies to every open entry (and future ones, per Pine)
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
}

/** One open entry: `strategy.entry`/`order` fills append these; closes consume them FIFO. */
interface Lot {
  id: string;
  qty: number; // unsigned contracts remaining
  price: number; // this entry's fill price
  bar: number; // bar index of the fill
  fee: number; // entry-side commission still carried (pro-rated out as the lot closes)
}

export interface ClosedTrade {
  entryId: string;
  dir: number;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  profit: number;
  cumProfit: number;
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
  };

  // position (aggregate size; per-entry detail lives in entryLots)
  size = 0; // signed
  /** The entry id that INITIALLY opened the live position (survives partial closes). */
  private entryId = '';
  // Per-entry open lots making up the current position, in fill order (FIFO).
  // Each lot carries its own fill price/bar/commission so `strategy.close(id)`,
  // `strategy.exit(from_entry=…)`, per-entry profit/loss tick levels, and the
  // one-trade-row-per-entry ledger all resolve against the right entry.
  private entryLots: Lot[] = [];
  // Number of same-direction entry adds making up the current position. Drives the
  // pyramiding cap (TradingView allows `pyramiding` same-side entries); reset to 0
  // when the position is fully closed.
  private entryCount = 0;

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
  maxDrawdown = 0;
  maxDrawdownPercent = 0;
  maxRunup = 0;
  maxRunupPercent = 0;
  maxContractsAll = 0;
  maxContractsLong = 0;
  maxContractsShort = 0;

  private pending: Order[] = [];
  private exits: ExitBracket[] = [];

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
    'size', 'entryId', 'entryCount',
    'realized', 'grossProfit', 'grossLoss', 'wins', 'losses', 'evens',
    'peakEquity', 'valleyEquity', 'maxDrawdown', 'maxDrawdownPercent', 'maxRunup', 'maxRunupPercent',
    'maxContractsAll', 'maxContractsLong', 'maxContractsShort',
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
    this.peakEquity = this.settings.initialCapital;
    this.valleyEquity = this.settings.initialCapital;
  }

  // ── live read-backs ───────────────────────────────────────
  get equity(): number { return this.settings.initialCapital + this.realized + this.openProfit; }
  get openProfit(): number { return this.size === 0 ? 0 : this.size * (this.host.close - this.avgPrice); }
  get netProfit(): number { return this.realized; }
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
    let q = 0, pq = 0;
    for (const lt of this.entryLots) { q += lt.qty; pq += lt.qty * lt.price; }
    return q > 0 ? pq / q : NaN;
  }
  /** Open-trade count: one per open entry lot (TradingView's strategy.opentrades). */
  get openTradeCount(): number { return this.entryLots.length; }
  /** The entry id that opened the live position (empty while flat). */
  get positionEntryName(): string { return this.size === 0 ? '' : this.entryId; }

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
  avgTradePercent(): number { return this.meanPct(() => true); }
  avgWinningTradePercent(): number { return this.meanPct((t) => t.profit > 0); }
  avgLosingTradePercent(): number { return this.meanPct((t) => t.profit < 0, -1); }

  /** `strategy.closedtrades.first_index` / `strategy.opentrades.capital_held` —
   *  the two bare scalar stats hanging off the trade collections. */
  tradeStat(scope: string, field: string): number {
    if (scope === 'closedtrades' && field === 'first_index') return this.closedTrades.length > 0 ? 0 : NaN;
    // capital allocated to the open position (cost basis); 0 while flat.
    if (scope === 'opentrades' && field === 'capital_held') return this.size === 0 ? 0 : Math.abs(this.size * this.avgPrice);
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

  /** The order quantity an entry would use at `price`, per the sizing settings. */
  defaultQty(price: number): number {
    const { qtyType, qtyValue } = this.settings;
    if (qtyType === 'cash') return qtyValue / price;
    if (qtyType === 'percent_of_equity') return ((qtyValue / 100) * this.equity) / price;
    return qtyValue; // fixed
  }

  // ── order entry points (called from the script) ──────────
  /** Pine keys orders by id — re-submitting replaces the unfilled pending order in place. */
  private submit(o: Order): void {
    const i = this.pending.findIndex((p) => p.id === o.id && (p.kind === 'entry' || p.kind === 'order'));
    if (i >= 0) this.pending[i] = o; else this.pending.push(o);
  }
  entry(id: string, dir: number, qty?: number, limit?: number, stop?: number): void {
    if (!this.active) return;
    this.submit({ id, dir, qty, kind: 'entry', ...orderTrigger(limit, stop) });
  }
  order(id: string, dir: number, qty?: number, limit?: number, stop?: number): void {
    if (!this.active) return;
    this.submit({ id, dir, qty, kind: 'order', ...orderTrigger(limit, stop) });
  }
  close(id: string, qty?: number): void {
    if (!this.active) return;
    this.pending.push({ id, dir: 0, qty, kind: 'close', otype: 'market' });
  }
  close_all(): void {
    if (!this.active) return;
    this.pending.push({ id: '', dir: 0, kind: 'closeAll', otype: 'market' });
  }
  exit(id: string, fromEntry?: string, qty?: number, profit?: number, loss?: number, stop?: number, limit?: number,
    trailPrice?: number, trailPoints?: number, trailOffset?: number): void {
    if (!this.active) return;
    // Pine keys exit brackets by id — re-submitting the same id updates in place
    // rather than stacking duplicates while the position is held open.
    const bracket: ExitBracket = { id, fromEntry: fromEntry ?? '', qty, profit, loss, stop, limit, trailPrice, trailPoints, trailOffset, trailStop: NaN };
    const i = this.exits.findIndex((e) => e.id === id);
    if (i >= 0) { bracket.trailStop = this.exits[i].trailStop; this.exits[i] = bracket; } else this.exits.push(bracket); // keep the trailing ratchet
  }

  /** A closed trade's field, or an open entry lot's (one open trade per lot). */
  tradeField(scope: string, field: string, i: number): number | string {
    const k = Math.trunc(i);
    if (scope === 'closedtrades') {
      const t = this.closedTrades[k];
      if (!t) return NaN;
      switch (field) {
        case 'profit': return t.profit;
        case 'entry_price': return t.entryPrice;
        case 'exit_price': return t.exitPrice;
        case 'entry_bar_index': return t.entryBar;
        case 'exit_bar_index': return t.exitBar;
        case 'size': return t.dir * t.qty;
        case 'entry_id': return t.entryId;
        case 'cumprofit': case 'cumulative_profit': return t.cumProfit;
        default: return NaN; // commission / max_runup / *_comment etc. not tracked in v1
      }
    }
    const lot = this.entryLots[k];
    if (!lot) return NaN;
    const dir = sign(this.size);
    switch (field) {
      case 'profit': return dir * (this.host.close - lot.price) * lot.qty;
      case 'entry_price': return lot.price;
      case 'entry_bar_index': return lot.bar;
      case 'size': return dir * lot.qty;
      case 'entry_id': return lot.id;
      default: return NaN;
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
    const { open, high, low } = this.host;
    this.processTick(open, high, low, open);
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
      } else { // stoplimit: the stop arms a resting limit, which then fills at the limit price
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

    // 3. mark-to-market
    this.markToMarket(o, h, l);
  }

  /** Update the equity curve and drawdown/run-up extremes. TradingView computes the
   *  extremes from INTRABAR equity, so walk the bar's assumed price path
   *  (open → nearer extreme → farther extreme → close), not just the close. */
  private markToMarket(o: number, h: number, l: number): void {
    const eq = this.equity;
    this.equityCurve[this.host.idx] = eq;
    let pts: number[];
    if (this.size === 0) {
      pts = [eq];
    } else {
      const base = this.settings.initialCapital + this.realized;
      const path = h - o < o - l ? [o, h, l, this.host.close] : [o, l, h, this.host.close];
      pts = path.map((px) => base + this.size * (px - this.avgPrice));
    }
    for (const v of pts) {
      if (v > this.peakEquity) this.peakEquity = v;
      if (v < this.valleyEquity) this.valleyEquity = v;
      const dd = this.peakEquity - v;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
      if (this.peakEquity > 0) this.maxDrawdownPercent = Math.max(this.maxDrawdownPercent, (dd / this.peakEquity) * 100);
      const ru = v - this.valleyEquity;
      if (ru > this.maxRunup) this.maxRunup = ru;
      if (this.valleyEquity > 0) this.maxRunupPercent = Math.max(this.maxRunupPercent, (ru / this.valleyEquity) * 100);
    }
    this.recordExposure();
  }

  private processExits(o: number, h: number, l: number): void {
    const mt = this.host.mintick;
    const slip = this.settings.slippage * mt;
    // intrabar path heuristic: the extreme nearer the open is assumed hit first
    const highFirst = h - o < o - l;
    // Pine: when BOTH an absolute price and a tick-distance resolve the same side
    // (stop+loss, limit+profit), the level expected to trigger FIRST wins — i.e. the
    // one nearer the market (long stop: the higher; long limit: the lower).
    const firstOf = (a: number | undefined, b: number | undefined, wantHigh: boolean): number | undefined =>
      a == null ? b : b == null ? a : wantHigh ? Math.max(a, b) : Math.min(a, b);
    const keep: ExitBracket[] = [];
    for (const ex of this.exits) {
      if (this.size === 0) break;
      const dir = sign(this.size);
      let remaining = ex.qty != null ? ex.qty - (ex.filled ?? 0) : Infinity;
      const book = (lot: Lot, take: number, px: number, fee?: number) => {
        this.closeLot(lot, take, px, fee);
        ex.filled = (ex.filled ?? 0) + take;
        remaining -= take;
      };
      // Each eligible entry lot gets its OWN exit order: profit/loss tick levels are
      // measured from that lot's fill price (absolute stop/limit prices are shared).
      for (const lot of this.entryLots.filter((lt) => !ex.fromEntry || lt.id === ex.fromEntry)) {
        if (remaining <= 0 || this.size === 0) break;
        const stopPx = firstOf(ex.stop, ex.loss != null ? lot.price - dir * ex.loss * mt : undefined, dir === DIR_LONG);
        const limitPx = firstOf(ex.limit, ex.profit != null ? lot.price + dir * ex.profit * mt : undefined, dir === DIR_SHORT);
        const take = Math.min(lot.qty, remaining);
        // open-gap fills happen on the tick's first price and pre-empt the intrabar path;
        // a gap through the level fills at the open (stop: worse + slippage, limit: better)
        if (stopPx != null && (dir === DIR_LONG ? o <= stopPx : o >= stopPx)) { book(lot, take, o - dir * slip); continue; }
        if (limitPx != null && (dir === DIR_LONG ? o >= limitPx : o <= limitPx)) { book(lot, take, o); continue; }
        const stopHit = stopPx != null && (dir === DIR_LONG ? l <= stopPx : h >= stopPx);
        const limitHit = limitPx != null && (dir === DIR_LONG ? h >= limitPx : l <= limitPx);
        // for a long the stop sits on the low side, the limit on the high side (short: swapped)
        const stopFirst = dir === DIR_LONG ? !highFirst : highFirst;
        if (stopHit && (stopFirst || !limitHit)) { book(lot, take, stopPx! - dir * slip); continue; }
        if (limitHit) book(lot, take, limitPx!);
      }
      // trailing stop (position-aggregate): arm at trail_price (or entry ± trail_points·tick),
      // ratchet trail_offset ticks behind the favorable extreme, fill where the path crosses it.
      if (this.size !== 0 && remaining > 0 && ex.trailOffset != null && (ex.trailPoints != null || ex.trailPrice != null)) {
        const fillPx = this.trailFill(ex, sign(this.size), o, h, l);
        if (fillPx != null) {
          const px = fillPx - sign(this.size) * slip; // a stop order → adverse slippage
          const lots = this.entryLots.filter((lt) => !ex.fromEntry || lt.id === ex.fromEntry);
          const group = Math.min(remaining, lots.reduce((a, lt) => a + lt.qty, 0));
          for (const lot of lots) { // one stop order → one order-level fee, pro-rated
            if (remaining <= 0) break;
            const take = Math.min(lot.qty, remaining);
            book(lot, take, px, this.commission(group, px) * (take / group));
          }
        }
      }
      // A bracket is spent once it has filled its qty cap or exhausted its eligible lots;
      // an unfilled one — or one still holding eligible lots — stays armed. A bracket with
      // no matching lots yet (its from_entry hasn't filled) waits for the entry.
      const anyLeft = this.entryLots.some((lt) => !ex.fromEntry || lt.id === ex.fromEntry);
      const spent = (ex.filled ?? 0) > 0 && (!anyLeft || (ex.qty != null && (ex.filled ?? 0) >= ex.qty - 1e-9));
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
  private trailFill(ex: ExitBracket, dir: number, o: number, h: number, l: number): number | undefined {
    const mt = this.host.mintick;
    const off = ex.trailOffset! * mt;
    const act = ex.trailPrice != null ? ex.trailPrice : this.avgPrice + dir * (ex.trailPoints ?? 0) * mt;
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

  private fill(o: Order, price: number): void {
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
      // pyramiding: cap same-direction ENTRIES at settings.pyramiding (strategy.order is
      // uncapped, matching TradingView). The count is real, so pyramiding ≥ 2 admits
      // exactly N adds rather than an unbounded number.
      if (this.entryCount >= this.settings.pyramiding) return;
    }
    const qty = this.qtyFor(o, price);
    if (qty <= 0) return;
    this.openOrAdd(o, dir, qty, price);
  }

  /** Open a new position (or add a lot to the same-direction one) and book the entry commission. */
  private openOrAdd(o: Order, dir: number, qty: number, price: number): void {
    const fee = this.commission(qty, price);
    if (this.size === 0) {
      this.size = dir * qty;
      this.entryId = o.id;
      this.entryCount = 1;
      this.entryLots = [{ id: o.id, qty, price, bar: this.host.idx, fee }];
    } else {
      this.size += dir * qty;
      this.entryCount += 1;
      this.entryLots.push({ id: o.id, qty, price, bar: this.host.idx, fee });
    }
    this.recordExposure();
    this.realized -= fee; // carried per-lot; pro-rated into each trade's profit on close
  }

  /** Live closed-trade list + equity curve for the engine's strategy report. */
  report() {
    const c = this.settings;
    return {
      initialCapital: c.initialCapital,
      netProfit: this.netProfit,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      wins: this.wins,
      losses: this.losses,
      maxDrawdown: this.maxDrawdown,
      closedTrades: this.closedTrades,
      equityCurve: this.equityCurve,
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
  private closeLot(lot: Lot, take: number, price: number, exitFee = this.commission(take, price)): void {
    const dir = sign(this.size);
    const entryFee = lot.fee * (take / lot.qty);
    lot.fee -= entryFee;
    const profit = dir * (price - lot.price) * take - exitFee - entryFee;
    this.realized += profit + entryFee;
    if (profit > 0) { this.grossProfit += profit; this.wins++; }
    else if (profit < 0) { this.grossLoss += -profit; this.losses++; }
    else this.evens++;
    this.closedTrades.push({
      entryId: lot.id, dir, qty: take, entryPrice: lot.price, exitPrice: price,
      entryBar: lot.bar, exitBar: this.host.idx, profit, cumProfit: this.realized,
    });
    lot.qty -= take;
    if (lot.qty <= 1e-9) this.entryLots.splice(this.entryLots.indexOf(lot), 1);
    this.size = dir * (Math.abs(this.size) - take);
    if (Math.abs(this.size) <= 1e-9 || this.entryLots.length === 0) {
      this.size = 0; this.entryId = ''; this.entryCount = 0; this.entryLots = []; this.exits = [];
    }
  }
}

/**
 * strategy.* namespace facade — order functions (with `when`-gating + arg
 * coercion), live read-back getters, and the direction/qty/commission constants.
 */
export function makeStrategyNs(b: StrategyBroker) {
  const gated = (when: unknown, fn: () => void) => { if (when !== false) fn(); };
  return {
    long: DIR_LONG,
    short: DIR_SHORT,
    fixed: 'fixed' as const,
    cash: 'cash' as const,
    percent_of_equity: 'percent_of_equity' as const,
    commission: { percent: 'percent', cash_per_contract: 'cash_per_contract', cash_per_order: 'cash_per_order' },
    oca: { none: 'none', cancel: 'cancel', reduce: 'reduce' },
    direction: { all: 'all', long: 'long', short: 'short' },

    entry: (id: unknown, dir: unknown, qty?: unknown, limit?: unknown, stop?: unknown, when?: unknown) =>
      gated(when, () => b.entry(String(id), Number(dir), opt(qty), opt(limit), opt(stop))),
    order: (id: unknown, dir: unknown, qty?: unknown, limit?: unknown, stop?: unknown, when?: unknown) =>
      gated(when, () => b.order(String(id), Number(dir), opt(qty), opt(limit), opt(stop))),
    close: (id: unknown, qty?: unknown, when?: unknown) =>
      gated(when, () => b.close(String(id), opt(qty))),
    close_all: (when?: unknown) => gated(when, () => b.close_all()),
    exit: (id: unknown, fromEntry?: unknown, qty?: unknown, profit?: unknown, loss?: unknown, stop?: unknown, limit?: unknown,
      trailPrice?: unknown, trailPoints?: unknown, trailOffset?: unknown, when?: unknown) =>
      gated(when, () => b.exit(String(id), fromEntry == null || isNa(fromEntry) ? undefined : String(fromEntry),
        opt(qty), opt(profit), opt(loss), opt(stop), opt(limit), opt(trailPrice), opt(trailPoints), opt(trailOffset))),
    /** strategy.closedtrades.X(i) / strategy.opentrades.X(i) — per-trade introspection. */
    tradeField: (scope: unknown, field: unknown, i: unknown) => b.tradeField(String(scope), String(field), opt(i) ?? 0),
    /** strategy.closedtrades.first_index / strategy.opentrades.capital_held — bare scalar stats. */
    tradeStat: (scope: unknown, field: unknown) => b.tradeStat(String(scope), String(field)),
    default_entry_qty: (price: unknown) => b.defaultQty(opt(price) ?? b.host.close),
    cancel: (id: unknown, when?: unknown) => gated(when, () => b.cancel(String(id))),
    cancel_all: (when?: unknown) => gated(when, () => b.cancel_all()),

    get position_size() { return b.size; },
    get position_avg_price() { return b.size === 0 ? NaN : b.avgPrice; },
    get equity() { return b.equity; },
    get openprofit() { return b.openProfit; },
    get netprofit() { return b.netProfit; },
    get grossprofit() { return b.grossProfit; },
    get grossloss() { return b.grossLoss; },
    get wintrades() { return b.wins; },
    get losstrades() { return b.losses; },
    get eventrades() { return b.evens; },
    get closedtrades() { return b.closedTrades.length; },
    get opentrades() { return b.openTradeCount; },
    get initial_capital() { return b.settings.initialCapital; },
    get max_drawdown() { return b.maxDrawdown; },
    get account_currency() { return 'USD'; },

    // ── performance statistics (percent / averages / extremes) ──
    get netprofit_percent() { return b.settings.initialCapital ? (b.netProfit / b.settings.initialCapital) * 100 : 0; },
    get openprofit_percent() { return b.settings.initialCapital ? (b.openProfit / b.settings.initialCapital) * 100 : 0; },
    get grossprofit_percent() { return b.settings.initialCapital ? (b.grossProfit / b.settings.initialCapital) * 100 : 0; },
    get grossloss_percent() { return b.settings.initialCapital ? (b.grossLoss / b.settings.initialCapital) * 100 : 0; },
    get max_drawdown_percent() { return b.maxDrawdownPercent; },
    get max_runup() { return b.maxRunup; },
    get max_runup_percent() { return b.maxRunupPercent; },
    get avg_trade() { return b.closedTrades.length ? b.netProfit / b.closedTrades.length : 0; },
    get avg_trade_percent() { return b.avgTradePercent(); },
    get avg_winning_trade() { return b.wins ? b.grossProfit / b.wins : 0; },
    get avg_winning_trade_percent() { return b.avgWinningTradePercent(); },
    get avg_losing_trade() { return b.losses ? b.grossLoss / b.losses : 0; },
    get avg_losing_trade_percent() { return b.avgLosingTradePercent(); },
    get max_contracts_held_all() { return b.maxContractsAll; },
    get max_contracts_held_long() { return b.maxContractsLong; },
    get max_contracts_held_short() { return b.maxContractsShort; },
    get position_entry_name() { return b.positionEntryName; },
    /** Margin liquidation price — piner does not model margin, so na (matches Pine
     *  when the strategy declares no margin_long/short). */
    get margin_liquidation_price() { return NaN; },
  };
}
