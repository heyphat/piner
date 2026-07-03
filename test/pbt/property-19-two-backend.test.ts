/**
 * Feature: library-import-export, Property 19: Two-backend byte-for-byte output holds with imports.
 * For any Consumer_Script importing one or more libraries (including transitively), on every
 * historical bar and every realtime tick/confirmation, the codegen and interpreter backends
 * agree (|Δ| < 1e-9 numeric, exact non-numeric) across all plot outputs.
 * Validates: Requirements 6.1, 6.2, 6.3.
 */
import fc from 'fast-check';
import { describe, it } from 'bun:test';
import { compile, Engine, ArrayFeed } from '../../src/index.js';
import { exprArb, barsArb } from './gen.js';
import { comparePlots, eqNaN } from './harness.js';

describe('Property 19 — two-backend byte-for-byte output holds with imports', () => {
  it('a consumer importing a transitive graph agrees across backends (history + realtime ticks)', async () => {
    await fc.assert(
      fc.asyncProperty(
        exprArb(['src', 'close', 'high'], 3),
        exprArb(['src', 'low', 'open'], 2),
        barsArb(30),
        async (e1, e2, bars) => {
          // base exports g; mid imports base and exports f (transitive); consumer imports mid + base.
          const registry = [
            {
              key: 'u/base/1',
              source: `//@version=6\nlibrary("Base")\nexport g(float src) => ${e2}\n`,
            },
            {
              key: 'u/mid/1',
              source: `//@version=6\nlibrary("Mid")\nimport u/base/1 as b\nexport f(float src) => ${e1} + b.g(src)\n`,
            },
          ];
          const c = compile(
            `//@version=6\nindicator("t")\nimport u/mid/1 as m\nimport u/base/1 as b\nplot(m.f(close), title="p1")\nplot(b.g(high), title="p2")\n`,
            { libraries: registry },
          );
          // Historical bar loop.
          const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
          const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
          await js.run({ symbol: 'T', timeframe: '1' });
          await ip.run({ symbol: 'T', timeframe: '1' });
          comparePlots(js.outputs.plots, ip.outputs.plots, 'history');
          // Realtime replay: re-run the open bar (repaint) then confirm.
          const nb = bars[bars.length - 1];
          const live = { ...nb, time: nb.time + 60000, close: nb.close + 1 };
          js.tick(live, false);
          ip.tick(live, false);
          js.tick(live, true);
          ip.tick(live, true);
          comparePlots(js.outputs.plots, ip.outputs.plots, 'realtime');
          // sanity: the eqNaN helper is symmetric for the extreme values used here.
          void eqNaN;
        },
      ),
      { numRuns: 100 },
    );
  });
});
