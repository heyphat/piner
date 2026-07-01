/**
 * Feature: library-import-export, Property 5: Malformed registry keys are rejected.
 * For any malformed key — a string that is not exactly three non-empty '/'-segments,
 * or an object missing a non-empty user/lib/version — compile raises a CompileError.
 * Validates: Requirements 2.7.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'bun:test';
import { compile, CompileError, type LibraryRegistryKey } from '../../src/index.js';
import { seg } from './gen.js';

describe('Property 5 — malformed registry keys are rejected', () => {
  const src = `//@version=6\nindicator("c")\nplot(close)\n`;

  it('malformed string keys throw a CompileError', () => {
    // Wrong segment counts (1, 2, or 4) and empty segments.
    const badString = fc.oneof(
      seg, // one segment
      fc.tuple(seg, seg).map(([a, b]) => `${a}/${b}`), // two
      fc.tuple(seg, seg, seg, seg).map((s) => s.join('/')), // four
      fc.tuple(seg, seg).map(([a, b]) => `${a}//${b}`), // empty middle
      fc.constant('//'), fc.constant(''),
    );
    fc.assert(
      fc.property(badString, (key) => {
        expect(() => compile(src, { libraries: [{ key: key as LibraryRegistryKey, source: 'x' }] })).toThrow(CompileError);
      }),
      { numRuns: 150 },
    );
  });

  it('object keys with an empty part throw a CompileError', () => {
    const badObject = fc.oneof(
      seg.map((s) => ({ user: '', lib: s, version: '1' })),
      seg.map((s) => ({ user: s, lib: '', version: '1' })),
      seg.map((s) => ({ user: s, lib: s, version: '' })),
    );
    fc.assert(
      fc.property(badObject, (key) => {
        expect(() => compile(src, { libraries: [{ key, source: 'x' }] })).toThrow(CompileError);
      }),
      { numRuns: 100 },
    );
  });
});
