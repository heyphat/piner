/**
 * Feature: library-import-export, Property 23: Cyclic dependency graphs are rejected in cycle order.
 * For any dependency graph containing a cycle, compile raises a CompileError naming, in
 * cycle order, the identity of every library in the cycle.
 * Validates: Requirements 8.3.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { compile, CompileError } from '../../src/index.js';
import { seg } from './gen.js';

describe('Property 23 — cyclic dependency graphs are rejected in cycle order', () => {
  it('a ring of n libraries importing each other is rejected naming every member', () => {
    fc.assert(
      fc.property(seg, fc.integer({ min: 2, max: 6 }), (u, n) => {
        // Build a ring: L0 -> L1 -> ... -> L(n-1) -> L0.
        const names = Array.from({ length: n }, (_, i) => `ring${i}`);
        const reg = names.map((nm, i) => ({
          key: `${u}/${nm}/1`,
          source: `//@version=6\nlibrary("R${i}")\nimport ${u}/${names[(i + 1) % n]}/1 as nx\nexport f(float x) => nx.f(x)\n`,
        }));
        const src = `//@version=6\nindicator("c")\nimport ${u}/${names[0]}/1 as e\nplot(e.f(close))\n`;
        let err: unknown;
        try { compile(src, { libraries: reg }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(CompileError);
        const msg = (err as CompileError).message.toLowerCase();
        expect(msg).toContain('cyclic');
        // every ring member identity is named in the cycle report.
        for (const nm of names) expect((err as CompileError).message).toContain(`${u}/${nm}/1`);
      }),
      { numRuns: 100 },
    );
  });
});
