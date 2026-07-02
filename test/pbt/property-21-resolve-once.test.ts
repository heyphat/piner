/**
 * Feature: library-import-export, Property 21: Shared libraries are resolved exactly once.
 * For any diamond graph where multiple paths reach the same identity, that library is
 * resolved once; the resolved graph contains exactly the distinct libraries.
 * Validates: Requirements 8.2.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { LibraryResolver, indexRegistry } from '../../src/sema/library.js';
import { seg } from './gen.js';

describe('Property 21 — shared libraries are resolved exactly once', () => {
  it('a base reached via two intermediaries appears once in the resolved graph', () => {
    fc.assert(
      fc.property(seg, seg, seg, seg, (baseN, leftN, rightN, u) => {
        // Ensure the four lib names are distinct to avoid accidental identity clashes.
        fc.pre(new Set([baseN, leftN, rightN]).size === 3);
        const reg = indexRegistry([
          { key: `${u}/${baseN}/1`, source: `//@version=6\nlibrary("B")\nexport inc(float x) => x + 1.0\n` },
          { key: `${u}/${leftN}/1`, source: `//@version=6\nlibrary("L")\nimport ${u}/${baseN}/1 as b\nexport l(float x) => b.inc(x)\n` },
          { key: `${u}/${rightN}/1`, source: `//@version=6\nlibrary("R")\nimport ${u}/${baseN}/1 as b\nexport r(float x) => b.inc(x)\n` },
        ]);
        const graph = new LibraryResolver(reg).resolve([
          { kind: 'Import', user: u, lib: leftN, version: '1' },
          { kind: 'Import', user: u, lib: rightN, version: '1' },
        ]);
        expect(graph.libraries.size).toBe(3);
        expect(graph.libraries.has(`${u}/${baseN}/1`)).toBe(true);
      }),
      { numRuns: 120 },
    );
  });
});
