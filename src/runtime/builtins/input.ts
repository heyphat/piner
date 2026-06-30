/**
 * input.* — in a headless run with no settings panel, each input returns its
 * default value. (Hoisting/UI binding is a later concern; returning the default
 * per call is semantically correct for a fixed-input execution.)
 *
 * `input.source(defval)` returns the passed series value each bar, so it is NOT
 * treated as a one-time read — codegen passes e.g. `$.close` as the default.
 */
export const InputNs = {
  int(defval: number, ..._rest: unknown[]): number {
    return defval;
  },
  float(defval: number, ..._rest: unknown[]): number {
    return defval;
  },
  bool(defval: boolean, ..._rest: unknown[]): boolean {
    return defval;
  },
  string(defval: string, ..._rest: unknown[]): string {
    return defval;
  },
  source(defval: number, ..._rest: unknown[]): number {
    return defval;
  },
  color(defval: string, ..._rest: unknown[]): string {
    return defval;
  },
};
export type InputNamespace = typeof InputNs;
