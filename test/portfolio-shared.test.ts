/**
 * Gate V4 of the portfolio plan: SHARED-mode semantics fixtures, one per spec
 * clause (docs/portfolio-semantics.md, S1–S9). Every scenario is hand-computable
 * and states its arithmetic inline. The degenerate-case identity (no equity
 * coupling, no funds contention) pins shared ≡ isolated.
 */
import { describe, it, expect } from 'bun:test';
import { compile, PortfolioEngine, type Bar } from '../src/index.js';

/** Flat/segment price series: value v from bar a (inclusive) onward. */
const series = (n: number, segments: [number, number][], t0 = 0): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    let px = segments[0][1];
    for (const [a, v] of segments) if (i >= a) px = v;
    return { time: (t0 + i) * 60000, open: px, high: px, low: px, close: px, volume: 1 };
  });

const sleeve = (symbol: string, bars: Bar[]) => ({ symbol, timeframe: '1', bars });

describe('V4 — shared-mode semantics fixtures', () => {
  it('degenerate identity: no equity refs, no contention → shared ≡ isolated (S1)', () => {
    // fixed qty=1, margins off, no risk rules — the only difference between the
    // modes is where the cash sits, so trades and total equity must coincide.
    const src =
      '//@version=6\nstrategy("d", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'if bar_index % 5 == 0\n    strategy.entry("L", strategy.long)\n' +
      'if bar_index % 5 == 3\n    strategy.close("L")\n';
    const script = compile(src);
    const mk = () => [
      sleeve('AAA', series(30, [[0, 100], [10, 120], [20, 90]])),
      sleeve('BBB', series(30, [[0, 50], [15, 65]])),
    ];
    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());

    expect(sh.report.initialCapital).toBe(iso.report.initialCapital);
    expect(sh.report.closedTrades.length).toBe(iso.report.closedTrades.length);
    expect(sh.report.netProfit).toBeCloseTo(iso.report.netProfit, 9);
    for (let k = 0; k < iso.times.length; k++)
      expect(sh.report.equityCurve[k]).toBeCloseTo(iso.report.equityCurve[k], 6);
    // per-sleeve trades identical row-for-row
    for (let i = 0; i < 2; i++)
      expect(sh.sleeves[i].report.closedTrades).toEqual(iso.sleeves[i].report.closedTrades);
  });

  it('percent-of-equity sizes off the POT: one sleeve’s profit inflates the other’s entry (S2/S3)', () => {
    // A: enters bar0 (fills bar1 @101), closes bar4 (fills bar5 @105).
    // B: flat 100s, enters bar6 (fills bar7 @100).
    // Shared P=20000, qty=50% of equity:
    //   qtyA = .5·20000/101, profitA = qtyA·(105−101)
    //   qtyB = .5·(20000+profitA)/100  ← reads the grown pot (S3)
    // Isolated: qtyB = .5·10000/100 = 50.
    const src =
      '//@version=6\nstrategy("p", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, margin_long=0, margin_short=0)\n' +
      'if bar_index == 0 and syminfo.ticker == "AAA"\n    strategy.entry("L", strategy.long)\n' +
      'if bar_index == 4 and syminfo.ticker == "AAA"\n    strategy.close("L")\n' +
      'if bar_index == 6 and syminfo.ticker == "BBB"\n    strategy.entry("L", strategy.long)\n' +
      'if bar_index == 10 and syminfo.ticker == "BBB"\n    strategy.close("L")\n';
    const script = compile(src);
    const mk = () => [
      sleeve('AAA', series(14, [[0, 100], [1, 101], [2, 102], [3, 103], [4, 104], [5, 105]])),
      sleeve('BBB', series(14, [[0, 100]])),
    ];
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());
    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());

    const qtyA = (0.5 * 20000) / 101;
    const profitA = qtyA * (105 - 101);
    const shB = sh.sleeves[1].report.closedTrades[0];
    const isoB = iso.sleeves[1].report.closedTrades[0];
    expect(sh.sleeves[0].report.closedTrades[0].qty).toBeCloseTo(qtyA, 9);
    expect(shB.qty).toBeCloseTo((0.5 * (20000 + profitA)) / 100, 9);
    expect(isoB.qty).toBeCloseTo(50, 9);
    expect(shB.qty).toBeGreaterThan(isoB.qty); // the coupling, in one line
  });

  it('funds are first-come-first-served in basket order; the pot pools (S4)', () => {
    // cash-sized 15000 orders, price 100, margin 100%. Shared P=20000: sleeve A
    // fills (needs 15000 ≤ 20000), sleeve B is REJECTED (own 15000 + A's 15000
    // spoken for > 20000). Isolated 10000+10000: NEITHER fills — pooling is the
    // genuinely new capability, order rejection its price.
    const src =
      '//@version=6\nstrategy("f", initial_capital=10000, default_qty_type=strategy.cash, default_qty_value=15000)\n' +
      'if bar_index == 0\n    strategy.entry("L", strategy.long)\n' +
      'if bar_index == 12\n    strategy.close("L")\n';
    const script = compile(src);
    const mk = () => [sleeve('AAA', series(15, [[0, 100]])), sleeve('BBB', series(15, [[0, 100]]))];

    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());
    expect(sh.sleeves[0].report.closedTrades.length).toBe(1); // A got the pot
    expect(sh.sleeves[1].report.closedTrades.length).toBe(0); // B rejected
    expect(sh.sleeves[0].report.closedTrades[0].qty).toBeCloseTo(150, 9);

    // basket order decides who wins the pot — reverse it and B fills instead
    const rev = new PortfolioEngine(script, { mode: 'shared' }).run(mk().reverse());
    expect(rev.sleeves[0].symbol).toBe('BBB');
    expect(rev.sleeves[0].report.closedTrades.length).toBe(1);
    expect(rev.sleeves[1].report.closedTrades.length).toBe(0);

    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());
    expect(iso.sleeves[0].report.closedTrades.length).toBe(0); // 15000 > 10000
    expect(iso.sleeves[1].report.closedTrades.length).toBe(0);
  });

  it('risk rules read portfolio equity and halt every sleeve (S7)', () => {
    // Both sleeves hold 100 contracts from bar1. A crashes 100→84 at bar6:
    // portfolio loses 1600 of 20000 = 8% > the 5% max_drawdown rule → A's check
    // trips on its own mark, B's on its next mark (one-bar basket lag): BOTH
    // force-close. Isolated: B's own curve never draws down → B never trips.
    const src =
      '//@version=6\nstrategy("r", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'strategy.risk.max_drawdown(5, strategy.percent_of_equity)\n' +
      'if bar_index == 0\n    strategy.entry("L", strategy.long, qty=100)\n';
    const script = compile(src);
    const mk = () => [
      sleeve('AAA', series(14, [[0, 100], [6, 84]])),
      sleeve('BBB', series(14, [[0, 100]])),
    ];
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());
    expect(sh.sleeves[0].report.closedTrades.length).toBe(1); // force-closed by the halt
    expect(sh.sleeves[1].report.closedTrades.length).toBe(1); // halted by A's loss (S7)

    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());
    expect(iso.sleeves[0].report.closedTrades.length).toBe(1); // its own 16% drawdown
    expect(iso.sleeves[1].report.closedTrades.length).toBe(0); // still holding — never tripped
  });

  it('margin: another sleeve’s open profit cushions a call; its requirement is spoken for (S6)', () => {
    // Both sleeves long 600 @100 on 25% margin (cash 60000 orders).
    // A slides to 78, B rallies to 150 first.
    //   isolated (20000 funding): call when 20000+600(p−100) < 150p·0.25·4 ⇔ p < 88.9 → CALLED.
    //   shared (P=40000): A's walk sees 40000 + openB(+30000) + 600(p−100) vs
    //     150p + requiredB(600·150·0.25=22500) → no deficit down to p≈28 → NO call.
    const src =
      '//@version=6\nstrategy("m", initial_capital=20000, default_qty_type=strategy.cash, default_qty_value=60000, margin_long=25, margin_short=25)\n' +
      'if bar_index == 0\n    strategy.entry("L", strategy.long)\n';
    const script = compile(src);
    const mk = () => [
      sleeve('AAA', series(16, [[0, 100], [4, 96], [6, 90], [8, 84], [10, 78]])),
      sleeve('BBB', series(16, [[0, 100], [2, 120], [3, 150]])),
    ];
    const sh = new PortfolioEngine(script, { mode: 'shared', capital: 40000 }).run(mk());
    const iso = new PortfolioEngine(script, { mode: 'isolated', capital: 40000 }).run(mk());
    expect(iso.sleeves[0].report.marginCalls).toBeGreaterThan(0);
    expect(sh.sleeves[0].report.marginCalls).toBe(0);
    expect(sh.report.marginCalls).toBe(0);
    expect(iso.report.marginCalls).toBe(iso.sleeves[0].report.marginCalls);
  });

  it('strategy.initial_capital / strategy.equity read the pot inside every sleeve (S2)', () => {
    const src =
      '//@version=6\nstrategy("c", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'plot(strategy.initial_capital)\nplot(strategy.equity)\n';
    const script = compile(src);
    // no trades: equity must equal the pot on every bar of every sleeve
    const mk = () => [sleeve('AAA', series(6, [[0, 100]])), sleeve('BBB', series(6, [[0, 50]]))];
    const sh = new PortfolioEngine(script, { mode: 'shared', capital: 32000 }).run(mk());
    expect(sh.report.initialCapital).toBe(32000);
    expect(sh.report.equityCurve.every((v) => v === 32000)).toBe(true);

    const iso = new PortfolioEngine(script, { mode: 'isolated', capital: 32000 }).run(mk());
    expect(iso.report.equityCurve.every((v) => v === 32000)).toBe(true);
    expect(iso.sleeves[0].report.initialCapital).toBe(16000); // wᵢ·P per sleeve
  });

  it('sleeves execute only on their own bars; ragged basket stays consistent (S8)', () => {
    const src =
      '//@version=6\nstrategy("g", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=10)\n' +
      'if bar_index == 8\n    strategy.close("L")\n';
    const script = compile(src);
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run([
      sleeve('AAA', series(12, [[0, 100], [5, 110]])),
      sleeve('BBB', series(10, [[0, 40], [4, 44]], 6)), // starts 6 min late
    ]);
    expect(sh.times.length).toBe(16); // union: 0..11 ∪ 6..15
    expect(sh.report.equityCurve.length).toBe(16);
    expect(sh.report.equityCurve.every((v) => Number.isFinite(v))).toBe(true);
    expect(sh.sleeves[0].report.closedTrades.length).toBe(1);
    expect(sh.sleeves[1].report.closedTrades.length).toBe(1);
    // both trades landed at each sleeve's own bar_index 2/8 → distinct times
    const [ta, tb] = [sh.sleeves[0].report.closedTrades[0], sh.sleeves[1].report.closedTrades[0]];
    expect(tb.entryTime - ta.entryTime).toBe(6 * 60000);
  });
});
