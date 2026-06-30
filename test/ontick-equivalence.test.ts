import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

/**
 * onTick incremental vs full-recompute equivalence — the contract that decides
 * whether a host (e.g. fractal) may replace "re-run the whole script from bar 0
 * on every data update" with "step only the newest bar via Driver.onTick".
 *
 * Two paths over the SAME N bars:
 *   - FULL:        runHistorical([b0..b_{N-1}])         (what fractal does today)
 *   - INCREMENTAL: runHistorical([b0..b_{N-2}]) then    (step only the last bar)
 *                  onTick(b_{N-1}, isClose=true)
 *
 * The committed plot VALUES are byte-identical for any script whose output is a
 * pure function of price/ta/series history — so onTick is a safe optimization
 * THERE. They DIVERGE for repaint-aware scripts (barstate.*), because the prior
 * bar was the "last" bar when it committed in the N-1 batch and is never
 * recomputed, and the stepped bar is `isrealtime` rather than `ishistory`.
 * That divergence is exactly why onTick is not a transparent swap.
 */

const mkBars = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 60_000,
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: 100 + 5 * Math.sin(i / 2),
    volume: 1000,
  }));

/** Run a source two ways over the same N bars; close the final bar in the incremental path. */
async function fullVsIncremental(src: string, n: number) {
  const all = mkBars(n);
  const full = new Engine(compile(src), new ArrayFeed(all), { backend: 'js' });
  await full.run({ symbol: 'T', timeframe: '1' });

  const incr = new Engine(compile(src), new ArrayFeed(all.slice(0, -1)), { backend: 'js' });
  await incr.run({ symbol: 'T', timeframe: '1' });
  incr.tick(all[all.length - 1], true); // commit the final bar via a closing tick

  return { full, incr, n };
}

describe('onTick equivalence — pure ta/price scripts (safe to incrementalize)', () => {
  it('sma + close-close[1]: committed values are bar-for-bar identical', async () => {
    const { full, incr, n } = await fullVsIncremental(
      '//@version=6\nindicator("x")\nplot(ta.sma(close, 3))\nplot(close - close[1])',
      10,
    );
    expect(incr.ctx.series.committedBars).toBe(n); // both end with N committed bars
    for (let p = 0; p < 2; p++) {
      expect(incr.outputs.plots.get(p)!.data).toEqual(full.outputs.plots.get(p)!.data);
    }
  });

  it('stateful var counter: identical (rollback restores var exactly once per closed bar)', async () => {
    const { full, incr } = await fullVsIncremental(
      '//@version=6\nindicator("x")\nvar int c = 0\nc += 1\nplot(c)',
      8,
    );
    expect(incr.outputs.plots.get(0)!.data).toEqual(full.outputs.plots.get(0)!.data);
    // and the count is exactly the bar count — no double-count from the closing tick
    expect(incr.outputs.plots.get(0)!.data.at(-1)).toBe(8);
  });
});

describe('onTick divergence — repaint-aware scripts (why onTick is NOT transparent)', () => {
  it('barstate.islast diverges at the prior bar (it was "last" when it committed)', async () => {
    const { full, incr } = await fullVsIncremental('//@version=6\nindicator("x")\nplot(barstate.islast ? 1 : 0)', 6);
    // FULL: only the true rightmost bar is last.
    expect(full.outputs.plots.get(0)!.data).toEqual([0, 0, 0, 0, 0, 1]);
    // INCREMENTAL: bar 4 was the last of the N-1 batch when it committed, and stays committed.
    expect(incr.outputs.plots.get(0)!.data).toEqual([0, 0, 0, 0, 1, 1]);
    expect(incr.outputs.plots.get(0)!.data).not.toEqual(full.outputs.plots.get(0)!.data);
  });

  it('barstate.isrealtime diverges on the stepped bar even when it closes', async () => {
    const { full, incr } = await fullVsIncremental('//@version=6\nindicator("x")\nplot(barstate.isrealtime ? 1 : 0)', 6);
    // FULL treats every bar as history → never realtime.
    expect(full.outputs.plots.get(0)!.data).toEqual([0, 0, 0, 0, 0, 0]);
    // INCREMENTAL: the stepped bar ran under realtimeBarState → realtime on the last bar.
    expect(incr.outputs.plots.get(0)!.data).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it('barstate.isconfirmed agrees here (closing tick confirms, matching full historical)', async () => {
    // Documents the one repaint flag that does NOT diverge when the tick closes the bar:
    // both paths treat every committed bar as confirmed. (It WOULD diverge on a non-closing tick.)
    const { full, incr } = await fullVsIncremental('//@version=6\nindicator("x")\nplot(barstate.isconfirmed ? 1 : 0)', 6);
    expect(incr.outputs.plots.get(0)!.data).toEqual(full.outputs.plots.get(0)!.data);
    expect(full.outputs.plots.get(0)!.data).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
