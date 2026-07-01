/**
 * Feature: library-import-export, Property 2: Identity normalization is faithful.
 * For any three non-empty segments (p,l,v) with no '/', both the string key "p/l/v"
 * and the object {user:p,lib:l,version:v} normalize to the same LibraryIdentity.
 * Validates: Requirements 2.2, 2.3.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { normalizeIdentity } from '../../src/sema/library.js';
import { seg } from './gen.js';

describe('Property 2 — identity normalization is faithful', () => {
  it('string and object keys produce the same canonical identity', () => {
    fc.assert(
      fc.property(seg, seg, seg, (p, l, v) => {
        const fromString = normalizeIdentity(`${p}/${l}/${v}`);
        const fromObject = normalizeIdentity({ user: p, lib: l, version: v });
        expect(fromString.publisher).toBe(p);
        expect(fromString.lib).toBe(l);
        expect(fromString.version).toBe(v);
        expect(fromString.canonical).toBe(`${p}/${l}/${v}`);
        expect(fromObject.canonical).toBe(fromString.canonical);
      }),
      { numRuns: 200 },
    );
  });
});
