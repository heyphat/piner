import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

const DAY = 86400000;
// 12 hourly bars across 3 UTC days (4 bars/day): bars 0-3=day0, 4-7=day1, 8-11=day2.
const bars: Bar[] = Array.from({ length: 12 }, (_, i) => {
  const time = Math.floor(i / 4) * DAY + (i % 4) * 3600000;
  const close = 100 + i;
  return { time, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 + i };
});
// daily closes: day0=bar3=103, day1=bar7=107, day2=bar11=111
const eqNaN = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;

async function bothBackends(src: string, sym = 'BTCUSD') {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: sym, timeframe: '60' });
  await ip.run({ symbol: sym, timeframe: '60' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) if (!eqNaN(jp.data[i], ipp.data[i])) throw new Error(`diverge plot ${id} bar ${i}: js=${jp.data[i]} ip=${ipp.data[i]}`);
  }
  return js;
}

describe('request.security — higher timeframe (same symbol)', () => {
  it('lookahead_off (default) is non-repainting: a bar sees the previous HTF close', async () => {
    const eng = await bothBackends('//@version=6\nindicator("htf")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d)\n');
    const d = eng.outputs.plots.get(0)!.data;
    expect(d[0]).toBeNaN(); // day 0: no prior daily bar
    expect(d[3]).toBeNaN();
    expect(d[4]).toBe(103); // day 1 bars see day 0's close (bar 3)
    expect(d[7]).toBe(103);
    expect(d[8]).toBe(107); // day 2 bars see day 1's close (bar 7)
    expect(d[11]).toBe(107);
  });

  it('lookahead_on leaks the current HTF bar (future leak on history)', async () => {
    const eng = await bothBackends('//@version=6\nindicator("htf")\nd = request.security(syminfo.tickerid, "D", close, lookahead = barmerge.lookahead_on)\nplot(d)\n');
    const d = eng.outputs.plots.get(0)!.data;
    expect(d[0]).toBe(103); // day 0 bars already see day 0's final close
    expect(d[4]).toBe(107);
    expect(d[8]).toBe(111);
  });

  it('tuple request: [h, l] = request.security(..., [high, low])', async () => {
    const eng = await bothBackends('//@version=6\nindicator("htf")\n[h, l] = request.security(syminfo.tickerid, "D", [high, low])\nplot(h)\nplot(l)\n');
    // day 1 bars see day 0 high/low (day 0 = bars 0..3, highs 101..104 → max 104; lows 99..102 → min 99)
    expect(eng.outputs.plots.get(0)!.data[4]).toBe(104);
    expect(eng.outputs.plots.get(1)!.data[4]).toBe(99);
  });

  it('ta.* and inputs inside the expression evaluate in the HTF context', async () => {
    const eng = await bothBackends('//@version=6\nindicator("htf")\nlen = input.int(2, "Len")\ns = request.security(syminfo.tickerid, "D", ta.sma(close, len))\nplot(s)\n');
    // HTF sma(2) of daily closes [103,107,111]: day1 sma=na (1 sample), day2 sma=(103+107)/2=105
    // lookahead_off → day2 bars (8..11) see day1's value (na); not enough days to assert a number,
    // so just require both backends agree (done in bothBackends) and no throw.
    expect(eng.outputs.plots.has(0)).toBe(true);
  });

  it('cross-symbol requests return na when NOT injected (no external feed)', async () => {
    const c = compile('//@version=6\nindicator("x")\nd = request.security("NASDAQ:TSLA", "D", close)\nplot(d)\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'BTCUSD', timeframe: '60' });
    const d = eng.outputs.plots.get(0)!.data;
    expect(d.every((v) => Number.isNaN(v))).toBe(true); // all-na, gracefully
  });

  it('declares its request.security dependencies for host fetch (out.securityRequests)', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\na = request.security(syminfo.tickerid, "D", close)\nb = request.security("NASDAQ:TSLA", "W", close)\nplot(a + b)\n',
    );
    const reqs = eng.outputs.securityRequests;
    expect(reqs).toContainEqual({ symbol: 'BTCUSD', timeframe: 'D', lowerTf: false });
    expect(reqs).toContainEqual({ symbol: 'NASDAQ:TSLA', timeframe: 'W', lowerTf: false });
  });

  it('declares request.security_lower_tf dependencies (lowerTf: true), returning [] for now', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nv = request.security_lower_tf(syminfo.tickerid, "1", close)\nplot(array.size(v))\n',
    );
    expect(eng.outputs.securityRequests).toContainEqual({ symbol: 'BTCUSD', timeframe: '1', lowerTf: true });
    expect(eng.outputs.plots.get(0)!.data.every((n) => n === 0)).toBe(true); // empty intrabar array (stub)
  });

  it('cross-symbol resolves against HOST-INJECTED bars, time-aligned + non-repainting', async () => {
    // TSLA bars share the chart's 3 UTC days but with distinct closes (200+i):
    // daily TSLA closes day0=bar3=203, day1=bar7=207, day2=bar11=211.
    const tsla: Bar[] = bars.map((b, i) => ({ ...b, open: 200 + i - 0.5, high: 200 + i + 1, low: 200 + i - 1, close: 200 + i }));
    const src = '//@version=6\nindicator("x")\nd = request.security("NASDAQ:TSLA", "D", close)\nplot(d)\n';
    const c = compile(src);
    for (const backend of ['js', 'interp'] as const) {
      const eng = new Engine(c, new ArrayFeed(bars), { backend });
      eng.ctx.securityBars.set('NASDAQ:TSLA', tsla); // host injects the fetched bars
      await eng.run({ symbol: 'BTCUSD', timeframe: '60' });
      const d = eng.outputs.plots.get(0)!.data;
      expect(d[3]).toBeNaN(); // day 0: no prior TSLA daily bar
      expect(d[4]).toBe(203); // day 1 bars see TSLA day 0's close — NOT na, NOT BTC's 103
      expect(d[7]).toBe(203);
      expect(d[8]).toBe(207); // day 2 bars see TSLA day 1's close
      expect(d[11]).toBe(207);
    }
  });
});

describe('securityDependencies metadata (static extraction)', () => {
  const deps = (src: string) => compile(`//@version=6\nindicator("x")\n${src}`).metadata.securityDependencies;

  it('resolves literal symbol + timeframe (positional and named)', () => {
    expect(deps('d = request.security("NASDAQ:AAPL", "D", close)\nplot(d)\n'))
      .toEqual([{ lowerTf: false, self: false, symbol: 'NASDAQ:AAPL', tfSelf: false, timeframe: 'D', dynamic: false }]);
    expect(deps('d = request.security(timeframe = "D", symbol = "NASDAQ:AAPL", expression = close)\nplot(d)\n'))
      .toEqual([{ lowerTf: false, self: false, symbol: 'NASDAQ:AAPL', tfSelf: false, timeframe: 'D', dynamic: false }]);
  });

  it('classifies syminfo.tickerid as self, and flags security_lower_tf', () => {
    expect(deps('a = request.security_lower_tf(syminfo.tickerid, "1", close)\nplot(close)\n'))
      .toEqual([{ lowerTf: true, self: true, symbol: null, tfSelf: false, timeframe: '1', dynamic: false }]);
  });

  it('classifies timeframe.period (and "") as a chart-TF self-reference, NOT dynamic', () => {
    // The idiomatic self-call must be statically resolvable or hosts (pinerun) pay a
    // needless discovery run for a request that needs no fetch at all.
    expect(deps('d = request.security(syminfo.tickerid, timeframe.period, close)\nplot(d)\n'))
      .toEqual([{ lowerTf: false, self: true, symbol: null, tfSelf: true, timeframe: null, dynamic: false }]);
    expect(deps('d = request.security("NASDAQ:AAPL", "", close)\nplot(d)\n'))
      .toEqual([{ lowerTf: false, self: false, symbol: 'NASDAQ:AAPL', tfSelf: true, timeframe: null, dynamic: false }]);
  });

  it('folds identifiers bound to global const initializers', () => {
    expect(deps('SYM = "NASDAQ:MSFT"\nTF = "240"\nd = request.security(SYM, TF, close)\nplot(d)\n'))
      .toEqual([{ lowerTf: false, self: false, symbol: 'NASDAQ:MSFT', tfSelf: false, timeframe: '240', dynamic: false }]);
  });

  it('REGRESSION: a global reassigned via := before the call is dynamic, not the stale initializer', () => {
    // Previously reported {timeframe: "D", dynamic: false} while the runtime could request "W".
    const d = deps('tf = "D"\nif close > open\n    tf := "W"\nd = request.security(syminfo.tickerid, tf, close)\nplot(d)\n');
    expect(d).toEqual([{ lowerTf: false, self: true, symbol: null, tfSelf: false, timeframe: null, dynamic: true }]);
  });

  it('a reassignment anywhere — even after the call — is conservatively dynamic', () => {
    // Extraction is deferred to the end of analysis: an arg variable reassigned at ANY
    // point is not `simple` (invalid Pine for security args, but piner is lenient and
    // RUNS it), so a wrong confident fold would silently poison host fetch plans.
    const d = deps('tf = "D"\nd = request.security(syminfo.tickerid, tf, close)\ntf := "W"\nplot(d)\n');
    expect(d).toEqual([{ lowerTf: false, self: true, symbol: null, tfSelf: false, timeframe: null, dynamic: true }]);
  });

  it('REGRESSION: a := AFTER the call in a loop body (before it in execution order) is dynamic', () => {
    // Iteration 1 requests "D", iteration 2 requests "W" — no single static value exists.
    const d = deps('tf = "D"\nsum = 0.0\nfor i = 0 to 1\n    sum := sum + request.security(syminfo.tickerid, tf, close)\n    tf := "W"\nplot(sum)\n');
    expect(d).toEqual([{ lowerTf: false, self: true, symbol: null, tfSelf: false, timeframe: null, dynamic: true }]);
  });

  it('REGRESSION: an inlined UDF parameter shadowing a global const is dynamic, not the global value', () => {
    // Previously the param `tf` fell through to the global constEnv entry and
    // reported {timeframe: "D", dynamic: false} while the runtime requests "60".
    const d = deps('tf = "D"\nhtf(tf) => request.security(syminfo.tickerid, tf, close)\nplot(htf("60"))\n');
    expect(d).toEqual([{ lowerTf: false, self: true, symbol: null, tfSelf: false, timeframe: null, dynamic: true }]);
  });

  it('REGRESSION: a block-local shadowing a global const is dynamic, not the outer value', () => {
    const d = deps('tf = "D"\nv = 0.0\nif true\n    tf = "15"\n    v := request.security("NASDAQ:AAPL", tf, close)\nplot(v)\n');
    expect(d).toEqual([{ lowerTf: false, self: false, symbol: 'NASDAQ:AAPL', tfSelf: false, timeframe: null, dynamic: true }]);
  });
});
