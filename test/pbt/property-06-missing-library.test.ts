/**
 * Feature: library-import-export, Property 6: Missing imported libraries are rejected.
 * For any import whose identity is absent from the registry, compile raises a
 * CompileError naming the missing identity.
 * Validates: Requirements 2.8, 3.4.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { compile, CompileError } from '../../src/index.js';
import { seg, versionInt } from './gen.js';

describe('Property 6 — missing imported libraries are rejected', () => {
  it('an import absent from the (empty) registry throws naming the identity', () => {
    fc.assert(
      fc.property(seg, seg, versionInt, (p, l, v) => {
        const src = `//@version=6\nindicator("c")\nimport ${p}/${l}/${v} as lib\nplot(lib.f(close))\n`;
        let err: unknown;
        try { compile(src, { libraries: [] }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(CompileError);
        expect((err as CompileError).message).toContain(`${p}/${l}/${v}`);
      }),
      { numRuns: 150 },
    );
  });
});
