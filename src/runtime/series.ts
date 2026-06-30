/**
 * SeriesStore — flat columnar history for `series`-qualified values.
 *
 * Design (see docs/architecture.md §4.1): every value the analyzer determines is
 * history-referenced (`x[n]`) or feeds a stateful built-in gets a numeric "slot".
 * History lives in a growable Float64Array column per slot, indexed by a single
 * global bar counter. The current (in-progress) bar is written at index `len`;
 * `commitBar()` advances `len`. Reads use a reverse offset: 0 = current bar.
 *
 * This is allocation-free per bar (no per-series object) and cache-friendly for
 * rolling windows. `na` is represented as JS NaN for numeric slots.
 */

/**
 * The non-numeric `na` sentinel. A plain (cloneable) object rather than a Symbol,
 * so it survives `structuredClone` in the realtime-rollback snapshot — a Symbol
 * threw DataCloneError when stored in a reference-typed `var x = na`. Identity is
 * not relied upon: `isNa` matches structurally, so a cloned copy is still na.
 */
export const NA: { readonly __na: true } = Object.freeze({ __na: true } as const);
export type Na = typeof NA;

/** na-aware predicate: true for NaN, null/undefined, and the NA sentinel (or a clone). */
export function isNa(v: unknown): boolean {
  return (
    v == null ||
    (typeof v === 'number' && Number.isNaN(v)) ||
    (typeof v === 'object' && (v as { __na?: unknown }).__na === true)
  );
}

const INITIAL_CAPACITY = 1024;

export class SeriesStore {
  /** Numeric history columns, one per slot (NaN = na / "an object lives here", see objCols). */
  private numCols: Float64Array[] = [];
  /**
   * Sparse object OVERLAY, indexed by the SAME slot id as numCols: `objCols[slot][bar]` holds a
   * non-numeric history value (string, color, array, map, matrix, UDT instance) for that bar.
   * History slots are polymorphic — most hold numbers (numCols), but any slot whose value is a
   * reference type on a given bar records it here so `x[n]` reads it back faithfully instead of
   * the NaN that a Float64Array would coerce it to. Created lazily per slot (numeric slots never
   * allocate one, so the numeric hot path is untouched).
   */
  private objCols: (unknown[] | undefined)[] = [];
  /** Number of committed bars. The in-progress bar writes at index `len`. */
  private len = 0;
  /** Allocated capacity of numeric columns (objCols grow via index assignment). */
  private capacity = INITIAL_CAPACITY;

  /** Allocate a numeric history slot; returns its slot id. */
  declareNumericSlot(): number {
    this.numCols.push(new Float64Array(this.capacity).fill(NaN));
    return this.numCols.length - 1;
  }

  /** Ensure at least `total` numeric slots exist (for compiler-assigned slots). */
  ensureNumericSlots(total: number): void {
    while (this.numCols.length < total) this.declareNumericSlot();
  }

  get committedBars(): number {
    return this.len;
  }

  /**
   * Write the current bar's value for a slot. Numbers go to the numeric column (fast path);
   * a non-numeric value (string/color/array/map/matrix/UDT) is recorded in the object overlay
   * so its history survives `x[n]`. Writing a number clears any prior overlay entry at this bar
   * (a slot can flip numeric↔object across a realtime-bar recompute).
   */
  set(slot: number, value: unknown): void {
    if (typeof value === 'number') {
      this.numCols[slot][this.len] = value;
      const o = this.objCols[slot];
      if (o !== undefined) o[this.len] = undefined;
    } else {
      (this.objCols[slot] ??= [])[this.len] = value;
      this.numCols[slot][this.len] = NaN;
    }
  }

  /**
   * Read NUMERIC history: offset 0 = current bar, 1 = one bar back, etc. Out-of-range (before
   * the first bar, or negative offset) returns NaN (= na). Used by the built-in OHLCV/time
   * leaves and numeric internals — never consults the object overlay (numeric hot path).
   */
  get(slot: number, offset: number): number {
    const i = this.len - offset;
    if (offset < 0 || i < 0) return NaN;
    return this.numCols[slot][i];
  }

  /**
   * Read polymorphic history for an `x[n]` reference: the object overlay if this slot/bar holds
   * a reference value, else the numeric column. Out-of-range → NaN (na), matching Pine.
   */
  getHist(slot: number, offset: number): unknown {
    const i = this.len - offset;
    if (offset < 0 || i < 0) return NaN;
    const o = this.objCols[slot];
    if (o !== undefined) {
      const v = o[i];
      if (v !== undefined) return v;
    }
    return this.numCols[slot][i];
  }

  /** Ensure room for the current bar before the script writes into it. */
  beginBar(): void {
    if (this.len >= this.capacity - 1) this.grow();
  }

  /** Confirm the current bar; subsequent writes target a new index. */
  commitBar(): void {
    this.len++;
  }

  /**
   * Rollback primitive (docs/architecture.md §6): reset the bar counter to a prior
   * committed length so the realtime bar is recomputed from scratch each tick.
   */
  truncateTo(committed: number): void {
    this.len = committed;
  }

  private grow(): void {
    const next = this.capacity * 2;
    for (let s = 0; s < this.numCols.length; s++) {
      const bigger = new Float64Array(next).fill(NaN);
      bigger.set(this.numCols[s]);
      this.numCols[s] = bigger;
    }
    this.capacity = next;
  }
}
