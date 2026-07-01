/**
 * Feature: library-import-export, Property 3: Backward compatibility for import-free scripts.
 * For any Consumer_Script with no import, compile(src), compile(src,{}) and
 * compile(src,{libraries:[]}) produce identical generated JS and metadata.
 * Validates: Requirements 2.4.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { compile } from '../../src/index.js';
import { exprArb } from './gen.js';

describe('Property 3 — backward compatibility for import-free scripts', () => {
  it('the optional options argument does not change output for import-free scripts', () => {
    fc.assert(
      fc.property(exprArb(['close', 'high', 'low', 'open'], 3), (e) => {
        const src = `//@version=6\nindicator("t")\nplot(${e}, title="p")\n`;
        const base = compile(src);
        const withEmptyOpts = compile(src, {});
        const withEmptyReg = compile(src, { libraries: [] });
        expect(withEmptyOpts.source).toBe(base.source);
        expect(withEmptyReg.source).toBe(base.source);
        expect(JSON.stringify(withEmptyOpts.metadata)).toBe(JSON.stringify(base.metadata));
        expect(JSON.stringify(withEmptyReg.metadata)).toBe(JSON.stringify(base.metadata));
      }),
      { numRuns: 150 },
    );
  });
});
