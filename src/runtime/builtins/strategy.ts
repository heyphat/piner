/**
 * strategy.* — a deterministic broker simulator (Phase 8).
 *
 * Execution model (Pine default): the script runs on each bar's close and queues
 * orders; the broker fills market orders at the NEXT bar's open, and checks
 * stop/limit/exit brackets against each bar's range. Position, realized/open PnL,
 * an equity curve, and a closed-trade list are tracked. v1 covers the common
 * surface (market entry/order/close/exit with reverse + pyramiding, stop/limit
 * entries, exit stop/limit/profit/loss); trailing stops and per-trade
 * introspection (`strategy.closedtrades.profit(i)`) are follow-ups.
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
  /** When true, market orders fill at the CLOSE of the bar they were created on (Pine's
   *  process_orders_on_close) instead of the next bar's open. Default false. */
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
  fromEntry: string;
  qty?: number;
  profit?: number; // ticks
  loss?: number; // ticks
  stop?: number; // price
  limit?: number; // price
  trailPrice?: number; // activation price
  trailPoints?: number; // activation distance from entry (ticks)
  trailOffset?: number; // trail distance behind the extreme (ticks)
  trailStop?: number; // current ratcheting trailing-stop level (price), NaN until armed
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

  // position (aggregate)
  size = 0; // signed
  avgPrice = NaN;
  private entryId = '';
  private entryBar = 0;
  // Number of same-direction entry/order adds making up the current position. Drives the
  // pyramiding cap (TradingView allows `pyramiding` same-side entries); reset to 0 when the
  // position is fully closed. v1 used a 0/1 stub which let pyramiding ≥ 2 add without bound.
  private entryCount = 0;
  // entry-side commission carried on the open position (pro-rated into trade profit on close)
  private entryCommission = 0;

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
  private static readonly SNAP_KEYS = [
    'pending', 'exits', 'size', 'avgPrice', 'entryId', 'entryBar', 'entryCount', 'entryCommission',
    'realized', 'grossProfit', 'grossLoss', 'wins', 'losses', 'evens', 'closedTrades', 'equityCurve',
    'peakEquity', 'valleyEquity', 'maxDrawdown', 'maxDrawdownPercent', 'maxRunup', 'maxRunupPercent',
    'maxContractsAll', 'maxContractsLong', 'maxContractsShort',
  ] as const;
  snapshot(): unknown {
    const s: Record<string, unknown> = {};
    for (const k of StrategyBroker.SNAP_KEYS) s[k] = structuredClone(this[k]);
    return s;
  }
  restore(s: unknown): void {
    const snap = s as Record<string, unknown>;
    for (const k of StrategyBroker.SNAP_KEYS) (this as Record<string, unknown>)[k] = structuredClone(snap[k]);
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
  /** The entry id of the live position (empty while flat). */
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

  /** A closed trade's field (or the open position as trade 0 for `opentrades`). */
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
    if (this.size === 0 || k !== 0) return NaN; // opentrades: single aggregate position
    switch (field) {
      case 'profit': return this.openProfit;
      case 'entry_price': return this.avgPrice;
      case 'entry_bar_index': return this.entryBar;
      case 'size': return this.size;
      case 'entry_id': return this.entryId;
      default: return NaN;
    }
  }
  cancel(id: string): void { this.pending = this.pending.filter((o) => o.id !== id || o.otype === 'market'); }
  cancel_all(): void { this.pending = this.pending.filter((o) => o.otype === 'market'); }

  // ── per-bar processing (called by the driver at bar open) ─
  onBar(): void {
    if (!this.active) return;
    const { open, high, low } = this.host;
    const slip = this.settings.slippage * this.host.mintick;

    // 1. market orders fill at the open
    const stillPending: Order[] = [];
    for (const o of this.pending) {
      if (o.otype === 'market') {
        this.fill(o, open + sign(o.dir || -sign(this.size)) * slip);
      } else if (o.otype === 'limit') {
        // buy limit: gap through the price fills at the (better) open, else at the price if low <= it
        const p = o.price!;
        if (o.dir === DIR_LONG ? open <= p : open >= p) this.fill(o, open);
        else if (o.dir === DIR_LONG ? low <= p : high >= p) this.fill(o, p);
        else stillPending.push(o);
      } else if (o.otype === 'stop') {
        // buy stop: gap through the price fills at the open; slippage applies (adverse)
        const p = o.price!;
        if (o.dir === DIR_LONG ? open >= p : open <= p) this.fill(o, open + o.dir * slip);
        else if (o.dir === DIR_LONG ? high >= p : low <= p) this.fill(o, p + o.dir * slip);
        else stillPending.push(o);
      } else { // stoplimit: the stop arms a resting limit, which then fills at the limit price
        const wasTriggered = o.triggered;
        if (!o.triggered) {
          const stopHit = o.dir === DIR_LONG ? high >= o.price! : low <= o.price!;
          if (stopHit) o.triggered = true; // armed — may still fill this same bar below
        }
        if (o.triggered) {
          const p = o.limit!;
          // a limit resting since a PRIOR bar is open-bounded like any limit order
          if (wasTriggered && (o.dir === DIR_LONG ? open <= p : open >= p)) this.fill(o, open);
          else if (o.dir === DIR_LONG ? low <= p : high >= p) this.fill(o, p);
          else stillPending.push(o); // keep `triggered`
        } else {
          stillPending.push(o);
        }
      }
    }
    this.pending = stillPending;

    // 2. exit brackets against the bar range
    if (this.size !== 0 && this.exits.length) this.processExits();

    // 3. mark-to-market at close
    this.markToMarket();
  }

  /**
   * Fill orders created on THIS bar at the bar's CLOSE — Pine's process_orders_on_close.
   * Called by the driver AFTER the script body runs. Only MARKET orders fill here (the
   * next-bar-open path in onBar() therefore finds nothing left for them); resting
   * limit/stop orders still trigger intrabar on later bars. Re-marks this bar's equity.
   */
  onBarClose(): void {
    if (!this.active || !this.settings.processOrdersOnClose) return;
    const { close } = this.host;
    const slip = this.settings.slippage * this.host.mintick;
    const stillPending: Order[] = [];
    for (const o of this.pending) {
      if (o.otype === 'market') this.fill(o, close + sign(o.dir || -sign(this.size)) * slip);
      else stillPending.push(o);
    }
    this.pending = stillPending;
    if (this.size !== 0 && this.exits.length) this.processExits();
    this.markToMarket();
  }

  private markToMarket(): void {
    const eq = this.equity;
    this.equityCurve[this.host.idx] = eq;
    if (eq > this.peakEquity) this.peakEquity = eq;
    if (eq < this.valleyEquity) this.valleyEquity = eq;
    const dd = this.peakEquity - eq;
    this.maxDrawdown = Math.max(this.maxDrawdown, dd);
    if (this.peakEquity > 0) this.maxDrawdownPercent = Math.max(this.maxDrawdownPercent, (dd / this.peakEquity) * 100);
    const ru = eq - this.valleyEquity;
    this.maxRunup = Math.max(this.maxRunup, ru);
    if (this.valleyEquity > 0) this.maxRunupPercent = Math.max(this.maxRunupPercent, (ru / this.valleyEquity) * 100);
    this.recordExposure();
  }

  private processExits(): void {
    const { open, high, low } = this.host;
    const dir = sign(this.size);
    const slip = this.settings.slippage * this.host.mintick;
    // intrabar path heuristic: the extreme nearer the open is assumed hit first
    const highFirst = high - open < open - low;
    const keep: ExitBracket[] = [];
    for (const ex of this.exits) {
      if (this.size === 0) break;
      // resolve stop/loss and limit/profit to prices
      let stopPx = ex.stop;
      let limitPx = ex.limit;
      if (ex.loss != null) stopPx = this.avgPrice - dir * ex.loss * this.host.mintick;
      if (ex.profit != null) limitPx = this.avgPrice + dir * ex.profit * this.host.mintick;
      // the exit order's direction is -dir: stops take adverse slippage, limits don't
      const fillStop = (px: number) => this.closePosition(px - dir * slip, ex.qty);
      const fillLimit = (px: number) => this.closePosition(px, ex.qty);
      // open-gap fills happen on the bar's first tick and pre-empt the intrabar path;
      // a gap through the level fills at the open (stop: worse, limit: better)
      if (stopPx != null && (dir === DIR_LONG ? open <= stopPx : open >= stopPx)) { fillStop(open); continue; }
      if (limitPx != null && (dir === DIR_LONG ? open >= limitPx : open <= limitPx)) { fillLimit(open); continue; }
      const stopHit = stopPx != null && (dir === DIR_LONG ? low <= stopPx : high >= stopPx);
      const limitHit = limitPx != null && (dir === DIR_LONG ? high >= limitPx : low <= limitPx);
      // for a long the stop sits on the low side, the limit on the high side (short: swapped)
      const stopFirst = dir === DIR_LONG ? !highFirst : highFirst;
      if (stopHit && (stopFirst || !limitHit)) { fillStop(stopPx!); continue; }
      if (limitHit) { fillLimit(limitPx!); continue; }
      // trailing stop: arm at trail_price (or entry ± trail_points·tick), then
      // ratchet a stop trail_offset ticks behind the favorable extreme.
      if (ex.trailOffset != null && (ex.trailPoints != null || ex.trailPrice != null)) {
        const mt = this.host.mintick;
        const activation = ex.trailPrice != null ? ex.trailPrice : this.avgPrice + dir * (ex.trailPoints ?? 0) * mt;
        const armed = !Number.isNaN(ex.trailStop!) || (dir === DIR_LONG ? high >= activation : low <= activation);
        if (armed) {
          const candidate = dir === DIR_LONG ? high - ex.trailOffset * mt : low + ex.trailOffset * mt;
          ex.trailStop = Number.isNaN(ex.trailStop!) ? candidate
            : dir === DIR_LONG ? Math.max(ex.trailStop!, candidate) : Math.min(ex.trailStop!, candidate);
          const hit = dir === DIR_LONG ? low <= ex.trailStop! : high >= ex.trailStop!;
          if (hit) { fillStop(ex.trailStop!); continue; }
        }
      }
      keep.push(ex); // unfilled — a bracket is spent once it fills
    }
    this.exits = this.size === 0 ? [] : keep;
  }

  private fill(o: Order, price: number): void {
    if (o.kind === 'closeAll' || o.kind === 'close') {
      // strategy.close only acts on the position opened under the SAME entry id
      if (o.kind === 'close' && o.id !== this.entryId) return;
      this.closePosition(price, o.qty);
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

  /** Open a new position (or add to the same-direction one) and book the entry commission. */
  private openOrAdd(o: Order, dir: number, qty: number, price: number): void {
    if (this.size === 0) {
      this.size = dir * qty;
      this.avgPrice = price;
      this.entryId = o.id;
      this.entryBar = this.host.idx;
      this.entryCount = 1;
      this.entryCommission = 0;
    } else {
      const newSize = this.size + dir * qty;
      this.avgPrice = (this.avgPrice * Math.abs(this.size) + price * qty) / Math.abs(newSize);
      this.size = newSize;
      this.entryCount += 1;
    }
    const fee = this.commission(qty, price);
    this.entryCommission += fee; // carried on the open position; pro-rated into trade profit
    this.recordExposure();
    this.realized -= fee;
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

  private closePosition(price: number, qty?: number): void {
    if (this.size === 0) return;
    const dir = sign(this.size);
    const closeQty = qty != null && !Number.isNaN(qty) ? Math.min(qty, Math.abs(this.size)) : Math.abs(this.size);
    // trade profit nets BOTH sides' commission; the entry side was already charged to
    // `realized` at fill time, so only the exit side moves realized here.
    const entryFee = this.entryCommission * (closeQty / Math.abs(this.size));
    const profit = dir * (price - this.avgPrice) * closeQty - this.commission(closeQty, price) - entryFee;
    this.entryCommission -= entryFee;
    this.realized += profit + entryFee;
    if (profit > 0) { this.grossProfit += profit; this.wins++; }
    else if (profit < 0) { this.grossLoss += -profit; this.losses++; }
    else this.evens++;
    this.closedTrades.push({
      entryId: this.entryId, dir, qty: closeQty, entryPrice: this.avgPrice, exitPrice: price,
      entryBar: this.entryBar, exitBar: this.host.idx, profit, cumProfit: this.realized,
    });
    this.size = dir * (Math.abs(this.size) - closeQty);
    if (this.size === 0) { this.avgPrice = NaN; this.exits = []; this.entryCount = 0; this.entryCommission = 0; }
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
    get opentrades() { return b.size === 0 ? 0 : 1; },
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

