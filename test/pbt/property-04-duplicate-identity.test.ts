/**
 * Feature: library-import-export, Property 4: Duplicate identities are rejected.
 * For any identity and any two registry entries (any key-form combination) that both
 * normalize to it, compile raises a CompileError naming the duplicate identity.
 * Validates: Requirements 2.6.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { compile, CompileError, type LibraryRegistryKey } from '../../src/index.js';
import { seg } from './gen.js';

const libSrc = (t: string) => `//@version=6\nlibrary("${t}")\nexport f(float x) => x\n`;

describe('Property 4 — duplicate identities are rejected', () => {
  it('two entries normalizing to the same identity throw a duplicate CompileError', () => {
    fc.assert(
      fc.property(seg, seg, seg, fc.boolean(), fc.boolean(), (p, l, v, firstObj, secondObj) => {
        const canonical = `${p}/${l}/${v}`;
        const key = (obj: boolean): LibraryRegistryKey =>
          obj ? { user: p, lib: l, version: v } : `${p}/${l}/${v}`;
        const src = `//@version=6\nindicator("c")\nplot(close)\n`;
        let err: unknown;
        try {
          compile(src, {
            libraries: [
              { key: key(firstObj), source: libSrc('A') },
              { key: key(secondObj), source: libSrc('B') },
            ],
          });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect((err as CompileError).message).toContain(canonical);
      }),
      { numRuns: 150 },
    );
  });
});
