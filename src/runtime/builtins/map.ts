/**
 * map.* — key/value collection, backed by a native JS Map so it survives the
 * structuredClone rollback snapshot (no class wrapper). Namespace-call form
 * `map.put(m, k, v)`; the method-call form `m.put(k, v)` dispatches to the same
 * functions via ExecutionContext.method().
 */
import { NA, isNa } from '../series.js';

export const MapNs = {
  new(): Map<unknown, unknown> {
    return new Map();
  },
  // Returns the value previously associated with `key` (na if none), per Pine.
  put(m: Map<unknown, unknown>, key: unknown, value: unknown): unknown {
    const prev = m.has(key) ? m.get(key) : NA;
    m.set(key, value);
    return prev;
  },
  get(m: Map<unknown, unknown>, key: unknown): unknown {
    return m.has(key) ? m.get(key) : NA;
  },
  contains(m: Map<unknown, unknown>, key: unknown): boolean {
    return m.has(key);
  },
  remove(m: Map<unknown, unknown>, key: unknown): unknown {
    const v = m.has(key) ? m.get(key) : NA;
    m.delete(key);
    return v;
  },
  keys(m: Map<unknown, unknown>): unknown[] {
    return [...m.keys()];
  },
  values(m: Map<unknown, unknown>): unknown[] {
    return [...m.values()];
  },
  size(m: Map<unknown, unknown>): number {
    return m.size;
  },
  clear(m: Map<unknown, unknown>): void {
    m.clear();
  },
  copy(m: Map<unknown, unknown>): Map<unknown, unknown> {
    return new Map(m);
  },
  put_all(dest: Map<unknown, unknown>, src: Map<unknown, unknown>): void {
    for (const [k, v] of src) dest.set(k, v);
  },
};
export type MapNamespace = typeof MapNs;
export { isNa };
