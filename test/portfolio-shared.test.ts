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
      sleeve(
        'AAA',
        series(30, [
          [0, 100],
          [10, 120],
          [20, 90],
        ]),
      ),
      sleeve(
        'BBB',
        series(30, [
          [0, 50],
          [15, 65],
        ]),
      ),
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
      sleeve(
        'AAA',
        series(14, [
          [0, 100],
          [1, 101],
          [2, 102],
          [3, 103],
          [4, 104],
          [5, 105],
        ]),
      ),
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
      sleeve(
        'AAA',
        series(14, [
          [0, 100],
          [6, 84],
        ]),
      ),
      sleeve('BBB', series(14, [[0, 100]])),
    ];
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());
    expect(sh.sleeves[0].report.closedTrades.length).toBe(1); // force-closed by the halt
    expect(sh.sleeves[1].report.closedTrades.length).toBe(1); // halted by A's loss (S7)

    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());
    expect(iso.sleeves[0].report.closedTrades.length).toBe(1); // its own 16% drawdown
    expect(iso.sleeves[1].report.closedTrades.length).toBe(0); // still holding — never tripped
  });

  it('risk halt survives DISJOINT clocks: a sleeve that misses the pot’s peak bar still trips (S7)', () => {
    // The 2026-07-09 audit’s High finding, pinned. Pot P=20000, max_drawdown 8%.
    // A (full clock t0..t9): long 1000 @100 (fills t1). Its close spikes to 110
    // at t2 → pot peak 30000 — then erodes to 106 → pot 26000: a TRUE portfolio
    // drawdown of 4000/30000 = 13.33% ≥ 8%.
    // B’s clock SKIPS t2 (the peak bar — the holiday / listing-gap case). Its own
    // marks alone would peak at 26000 (t3) → measured dd 0% → B would never halt
    // and would happily open at its bar4 (t5) AFTER the breach. The Account mark
    // broadcast folds A’s t2/t3 marks into B’s trackers, so B trips at its own
    // t3 mark and opens NOTHING.
    const src =
      '//@version=6\nstrategy("s7d", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'strategy.risk.max_drawdown(8, strategy.percent_of_equity)\n' +
      'if bar_index == 0 and syminfo.ticker == "AAA"\n    strategy.entry("L", strategy.long, qty=1000)\n' +
      'if bar_index == 4 and syminfo.ticker == "BBB"\n    strategy.entry("L", strategy.long, qty=100)\n' +
      'if bar_index == 7 and syminfo.ticker == "BBB"\n    strategy.close("L")\n';
    const script = compile(src);
    const mk = () => [
      sleeve(
        'AAA',
        series(10, [
          [0, 100],
          [2, 110],
          [3, 106],
        ]),
      ),
      // B: constant 50, bar at every master time EXCEPT t2
      sleeve(
        'BBB',
        series(10, [[0, 50]]).filter((b) => b.time !== 2 * 60000),
      ),
    ];
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run(mk());
    expect(sh.sleeves[0].report.closedTrades.length).toBe(1); // A: tripped at t3, force-closed t4
    expect(sh.sleeves[0].report.closedTrades[0].profit).toBeCloseTo(6000, 9); // 1000·(106−100)
    expect(sh.sleeves[1].report.closedTrades.length).toBe(0); // B: halted BEFORE its t5 entry
    // the portfolio curve records the true close-to-close drawdown
    expect(sh.report.maxDrawdownPercent).toBeCloseTo((4000 / 30000) * 100, 6);

    // Discriminator: isolated mode (B’s own flat curve never trips) proves B’s
    // entry+close WOULD have round-tripped absent the shared halt.
    const iso = new PortfolioEngine(script, { mode: 'isolated' }).run(mk());
    expect(iso.sleeves[1].report.closedTrades.length).toBe(1);
  });

  it('a non-stepping sleeve is valued at its LAST mark-to-market close — pinned (S5)', () => {
    // B holds 1 contract from its t1 bar (open 100 → close 120) and its data ENDS
    // at t1. A (flat, no trades) keeps marking t2/t3: the pot must value B’s open
    // position at B’s last close 120 — exactly +20 over the 20000 pot:
    //   t0: 20000 (B queued only)      t1: 20000 + 1·(120−100) = 20020
    //   t2: 20020 (A’s mark; B stale)  t3: 20020
    // A regression valuing B at entry (100 → 20000), at its high (125 → 20025),
    // or as NaN would each break a pinned point.
    const src =
      '//@version=6\nstrategy("s5", initial_capital=10000, margin_long=0, margin_short=0)\n' +
      'if bar_index == 0 and syminfo.ticker == "BBB"\n    strategy.entry("L", strategy.long, qty=1)\n';
    const script = compile(src);
    const sh = new PortfolioEngine(script, { mode: 'shared' }).run([
      sleeve('AAA', series(4, [[0, 200]])),
      sleeve('BBB', [
        { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { time: 60000, open: 100, high: 125, low: 95, close: 120, volume: 1 },
      ]),
    ]);
    const expected = [20000, 20020, 20020, 20020];
    expect(sh.report.equityCurve.length).toBe(4);
    for (let k = 0; k < expected.length; k++)
      expect(sh.report.equityCurve[k]).toBeCloseTo(expected[k], 9);
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
      sleeve(
        'AAA',
        series(16, [
          [0, 100],
          [4, 96],
          [6, 90],
          [8, 84],
          [10, 78],
        ]),
      ),
      sleeve(
        'BBB',
        series(16, [
          [0, 100],
          [2, 120],
          [3, 150],
        ]),
      ),
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
    // per-sleeve reports state the ACCOUNT's capital — the pot, matching what
    // strategy.initial_capital reads inside the script (S2), not the header value
    expect(sh.sleeves[0].report.initialCapital).toBe(32000);
    expect(sh.sleeves[1].report.initialCapital).toBe(32000);

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
      sleeve(
        'AAA',
        series(12, [
          [0, 100],
          [5, 110],
        ]),
      ),
      sleeve(
        'BBB',
        series(
          10,
          [
            [0, 40],
            [4, 44],
          ],
          6,
        ),
      ), // starts 6 min late
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
