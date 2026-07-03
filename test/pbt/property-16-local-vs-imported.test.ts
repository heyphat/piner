/**
 * Feature: library-import-export, Property 16: Imported functions behave identically to
 * equivalent local functions. For any function body and any bar series, a Consumer_Script
 * that imports and calls it produces, on every bar, output equal to an otherwise-identical
 * script that declares and calls the same function locally; each backend also agrees.
 * Validates: Requirements 5.1, 5.2, 5.4.
 */
import fc from 'fast-check';
import { describe, it } from 'bun:test';
import { compile } from '../../src/index.js';
import { exprArb, barsArb } from './gen.js';
import { runPlots, comparePlots } from './harness.js';

describe('Property 16 — imported functions behave identically to local functions', () => {
  it('imported f(close) == local f(close), per bar, on both backends', async () => {
    await fc.assert(
      fc.asyncProperty(
        exprArb(['src', 'close', 'high', 'low'], 3),
        barsArb(30),
        async (e, bars) => {
          const local = compile(
            `//@version=6\nindicator("t")\nf(float src) => ${e}\nplot(f(close), title="p")\n`,
          );
          const imported = compile(
            `//@version=6\nindicator("t")\nimport u/genlib/1 as g\nplot(g.f(close), title="p")\n`,
            {
              libraries: [
                {
                  key: 'u/genlib/1',
                  source: `//@version=6\nlibrary("G")\nexport f(float src) => ${e}\n`,
                },
              ],
            },
          );
          // Each variant's two backends agree...
          comparePlots(
            await runPlots(local, bars, 'js'),
            await runPlots(local, bars, 'interp'),
            'local js/interp',
          );
          comparePlots(
            await runPlots(imported, bars, 'js'),
            await runPlots(imported, bars, 'interp'),
            'imported js/interp',
          );
          // ...and imported ≡ local.
          comparePlots(
            await runPlots(imported, bars, 'js'),
            await runPlots(local, bars, 'js'),
            'imported vs local',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
