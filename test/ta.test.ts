import { describe, it, expect } from 'bun:test';
import { Ta } from '../src/runtime/builtins/ta.js';

/** Drive a single-arg stateful ta fn over a sequence at one call site. */
function run(fn: (v: number) => number, seq: number[]): number[] {
  return seq.map(fn);
}

describe('ta.sma', () => {
  it('is na until the window fills, then the mean', () => {
    const ta = new Ta();
    const out = run((v) => ta.sma(v, 3, 0), [2, 4, 6, 8]);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(4); // (2+4+6)/3
    expect(out[3]).toBe(6); // (4+6+8)/3
  });
  it('of a constant series equals the constant', () => {
    const ta = new Ta();
    [5, 5, 5, 5, 5].forEach((v) => ta.sma(v, 3, 0));
    expect(ta.sma(5, 3, 0)).toBe(5);
  });
});

describe('ta.ema', () => {
  it('seeds with the first value and applies alpha thereafter', () => {
    const ta = new Ta();
    const a = 2 / (3 + 1);
    expect(ta.ema(10, 3, 0)).toBe(10); // seed
    expect(ta.ema(20, 3, 0)).toBeCloseTo(a * 20 + (1 - a) * 10, 9);
  });
});

describe('ta.rma', () => {
  it('averages the first len values, then applies Wilder smoothing', () => {
    const ta = new Ta();
    expect(ta.rma(3, 2, 0)).toBeNaN();
    expect(ta.rma(5, 2, 0)).toBe(4); // (3+5)/2
    expect(ta.rma(7, 2, 0)).toBe((4 * 1 + 7) / 2); // (prev*(n-1)+x)/n
  });
});

describe('ta.wma', () => {
  it('weights recent values more', () => {
    const ta = new Ta();
    ta.wma(1, 3, 0);
    ta.wma(2, 3, 0);
    const w = ta.wma(3, 3, 0); // (1*1 + 2*2 + 3*3)/(1+2+3) = 14/6
    expect(w).toBeCloseTo(14 / 6, 9);
  });
});

describe('ta.rsi', () => {
  it('is 100 for a monotonically rising series and 0 for falling', () => {
    const up = new Ta();
    let r = NaN;
    for (let i = 1; i <= 20; i++) r = up.rsi(i, 14, 0);
    expect(r).toBe(100);
    const down = new Ta();
    for (let i = 20; i >= 1; i--) r = down.rsi(i, 14, 0);
    expect(r).toBe(0);
  });
  it('stays within [0, 100]', () => {
    const ta = new Ta();
    const seq = [10, 12, 11, 13, 9, 14, 8, 15, 10, 16, 12, 18, 11, 19, 13, 20];
    let r = NaN;
    seq.forEach((v) => (r = ta.rsi(v, 14, 0)));
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });
});

describe('ta.tr / ta.atr (read host OHLC)', () => {
  it('tr is high-low on the first bar then includes prev close', () => {
    const ta = new Ta();
    const host = { open: 0, high: 0, low: 0, close: 0, volume: 0, time: 0 };
    ta.host = host;
    host.high = 10; host.low = 8; host.close = 9;
    expect(ta.tr(0)).toBe(2); // first bar: high-low
    host.high = 12; host.low = 9; host.close = 11;
    // max(12-9, |12-9|, |9-9|) = 3
    expect(ta.tr(0)).toBe(3);
  });
  it('atr is the rma of true range and non-negative', () => {
    const ta = new Ta();
    const host = { open: 0, high: 0, low: 0, close: 0, volume: 0, time: 0 };
    ta.host = host;
    let atr = NaN;
    for (let i = 0; i < 10; i++) {
      host.high = 10 + i; host.low = 8 + i; host.close = 9 + i;
      atr = ta.atr(3, 0);
    }
    expect(atr).toBeGreaterThanOrEqual(0);
  });
});

describe('ta.highest / ta.lowest', () => {
  it('track the window extremes after warmup', () => {
    const hi = new Ta();
    const lo = new Ta();
    const seq = [3, 1, 4, 1, 5, 9, 2];
    seq.forEach((v) => { hi.highest(v, 3, 0); lo.lowest(v, 3, 1); });
    expect(hi.highest(6, 3, 0)).toBe(9); // window [9,2,6]
    expect(lo.lowest(6, 3, 1)).toBe(2);
  });

  it('warms up by bars elapsed, not valid-value count, with a leading-na source', () => {
    // Mirrors `ta.highest(high[1], 3)`: high[1] is na on bar 0. TradingView emits the
    // first value at bar index len-1 (=2) — the leading na occupies a window slot (so it
    // counts toward warmup) but is skipped when taking the extreme.
    const hi = new Ta();
    const lo = new Ta();
    const out = [NaN, 4, 7].map((v) => [hi.highest(v, 3, 0), lo.lowest(v, 3, 1)] as const);
    expect(out[0][0]).toBeNaN();            // bar 0: window not full
    expect(out[1][0]).toBeNaN();            // bar 1: window not full
    expect(out[2][0]).toBe(7);              // bar 2: max(4,7) — na skipped, not delayed
    expect(out[2][1]).toBe(4);              // min(4,7)
  });
});

describe('ta.stdev / ta.dev', () => {
  it('stdev of a constant window is 0', () => {
    const ta = new Ta();
    [7, 7, 7].forEach((v) => ta.stdev(v, 3, 0));
    expect(ta.stdev(7, 3, 0)).toBeCloseTo(0, 12);
  });
  it('stdev matches population formula', () => {
    const ta = new Ta();
    ta.stdev(2, 3, 0); ta.stdev(4, 3, 0);
    const s = ta.stdev(6, 3, 0); // mean 4, var = ((4+0+4))/3 = 8/3
    expect(s).toBeCloseTo(Math.sqrt(8 / 3), 9);
  });
});

describe('ta.change', () => {
  it('is src - src[len]', () => {
    const ta = new Ta();
    expect(ta.change(10, 1, 0)).toBeNaN();
    expect(ta.change(13, 1, 0)).toBe(3);
    expect(ta.change(20, 1, 0)).toBe(7);
  });
});

describe('ta.crossover / crossunder / cross', () => {
  it('crossover fires when a goes from <=b to >b', () => {
    const ta = new Ta();
    expect(ta.crossover(1, 2, 0)).toBe(false); // first bar: no prior
    expect(ta.crossover(3, 2, 0)).toBe(true); // 1<=2 then 3>2
    expect(ta.crossover(4, 2, 0)).toBe(false); // already above
  });
  it('crossunder fires when a goes from >=b to <b', () => {
    const ta = new Ta();
    ta.crossunder(3, 2, 0);
    expect(ta.crossunder(1, 2, 0)).toBe(true);
  });
  it('cross fires in either direction', () => {
    const ta = new Ta();
    ta.cross(1, 2, 0);
    expect(ta.cross(3, 2, 0)).toBe(true);
  });
});

describe('ta.cum / barssince / valuewhen', () => {
  it('cum is a running sum', () => {
    const ta = new Ta();
    expect(ta.cum(2, 0)).toBe(2);
    expect(ta.cum(3, 0)).toBe(5);
  });
  it('barssince counts bars since the last true', () => {
    const ta = new Ta();
    expect(ta.barssince(false, 0)).toBeNaN(); // never true yet
    expect(ta.barssince(true, 0)).toBe(0);
    expect(ta.barssince(false, 0)).toBe(1);
    expect(ta.barssince(false, 0)).toBe(2);
    expect(ta.barssince(true, 0)).toBe(0);
  });
  it('valuewhen captures src at the last true condition', () => {
    const ta = new Ta();
    expect(ta.valuewhen(false, 10, 0, 0)).toBeNaN();
    expect(ta.valuewhen(true, 11, 0, 0)).toBe(11);
    expect(ta.valuewhen(false, 12, 0, 0)).toBe(11);
    expect(ta.valuewhen(true, 13, 0, 0)).toBe(13);
  });
});

describe('ta call-site independence & snapshot/restore', () => {
  it('distinct sites keep independent state', () => {
    const ta = new Ta();
    ta.sma(10, 2, 0);
    ta.sma(100, 2, 1);
    expect(ta.sma(20, 2, 0)).toBe(15); // site 0: (10+20)/2
    expect(ta.sma(200, 2, 1)).toBe(150); // site 1: (100+200)/2
  });
  it('snapshot/restore reproduces state exactly (rollback)', () => {
    const ta = new Ta();
    ta.sma(1, 3, 0); ta.sma(2, 3, 0); ta.sma(3, 3, 0);
    const snap = ta.snapshot();
    const a = ta.sma(4, 3, 0);
    ta.restore(snap);
    const b = ta.sma(4, 3, 0); // same input from same restored state
    expect(b).toBe(a);
  });
});
