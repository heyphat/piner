/** Two-backend execution harness for property tests. Feature: library-import-export. */
import { Engine, ArrayFeed, type Bar, type CompiledScript, type PlotSeries } from '../../src/index.js';

/** Byte-for-byte equality (NaN-aware). The two backends must agree EXACTLY — the same
 *  strict comparator the pre-existing cross-check/real-scripts suites use — not within a
 *  tolerance, so any floating-point divergence introduced by the merge is caught. */
export const eqNaN = (a: number, b: number) =>
  (Number.isNaN(a) && Number.isNaN(b)) || a === b;

export async function runPlots(c: CompiledScript, bars: Bar[], backend: 'js' | 'interp'): Promise<Map<number, PlotSeries>> {
  const e = new Engine(c, new ArrayFeed(bars), { backend });
  await e.run({ symbol: 'T', timeframe: '1' });
  return e.outputs.plots;
}

/** Assert two plot maps agree per bar, byte-for-byte (NaN-aware). Throws on divergence. */
export function comparePlots(a: Map<number, PlotSeries>, b: Map<number, PlotSeries>, label: string): void {
  const ak = [...a.keys()].sort((x, y) => x - y);
  const bk = [...b.keys()].sort((x, y) => x - y);
  if (ak.length !== bk.length) throw new Error(`${label}: plot count ${ak.length} vs ${bk.length}`);
  for (const id of ak) {
    const pa = a.get(id)!;
    const pb = b.get(id)!;
    if (pa.data.length !== pb.data.length) throw new Error(`${label}: plot ${id} length mismatch`);
    for (let i = 0; i < pa.data.length; i++) {
      if (!eqNaN(pa.data[i], pb.data[i])) {
        throw new Error(`${label}: plot ${id} bar ${i}: ${pa.data[i]} vs ${pb.data[i]}`);
      }
    }
  }
}
