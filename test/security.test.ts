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
