/**
 * matrix.* — 2D collection as plain data `{ rows, columns, data }` (no class
 * wrapper, so it survives the structuredClone rollback snapshot). Namespace-call
 * form `matrix.get(m, r, c)`; method form `m.get(r, c)` dispatches here.
 */
import { NA } from '../series.js';

export interface Matrix {
  rows: number;
  columns: number;
  data: number[][];
}

export const MatrixNs = {
  new(rows = 0, columns = 0, initial = NaN): Matrix {
    const data: number[][] = [];
    for (let r = 0; r < rows; r++) data.push(new Array(columns).fill(initial));
    return { rows, columns, data };
  },
  get(m: Matrix, row: number, col: number): unknown {
    return row >= 0 && row < m.rows && col >= 0 && col < m.columns ? m.data[row][col] : NA;
  },
  set(m: Matrix, row: number, col: number, value: number): void {
    if (row >= 0 && row < m.rows && col >= 0 && col < m.columns) m.data[row][col] = value;
  },
  rows(m: Matrix): number { return m.rows; },
  columns(m: Matrix): number { return m.columns; },
  /** Insert a row at `rowIndex` (default = append) from `values` (default na-filled). */
  add_row(m: Matrix, rowIndex?: number, values?: number[]): void {
    const idx = rowIndex == null || Number.isNaN(rowIndex) ? m.rows : Math.trunc(rowIndex);
    m.data.splice(idx, 0, values ? values.slice() : new Array(m.columns).fill(NaN));
    m.rows++;
    if (m.columns === 0 && values) m.columns = values.length;
  },
  /** Element-wise sum: matrix+matrix (same shape) or matrix+scalar → NEW matrix. */
  sum(m: Matrix, other: Matrix | number): Matrix {
    const scalar = typeof other === 'number';
    const data = m.data.map((row, r) => row.map((v, c) => v + (scalar ? other : other.data[r][c])));
    return { rows: m.rows, columns: m.columns, data };
  },
  /** Element-wise difference: matrix-matrix (same shape) or matrix-scalar → NEW matrix. */
  diff(m: Matrix, other: Matrix | number): Matrix {
    const scalar = typeof other === 'number';
    const data = m.data.map((row, r) => row.map((v, c) => v - (scalar ? other : other.data[r][c])));
    return { rows: m.rows, columns: m.columns, data };
  },
  copy(m: Matrix): Matrix {
    return { rows: m.rows, columns: m.columns, data: m.data.map((r) => r.slice()) };
  },
  transpose(m: Matrix): Matrix {
    const data: number[][] = [];
    for (let c = 0; c < m.columns; c++) { data.push([]); for (let r = 0; r < m.rows; r++) data[c].push(m.data[r][c]); }
    return { rows: m.columns, columns: m.rows, data };
  },
  row(m: Matrix, i: number): number[] { return i >= 0 && i < m.rows ? m.data[i].slice() : []; },
  col(m: Matrix, j: number): number[] { return j >= 0 && j < m.columns ? m.data.map((r) => r[j]) : []; },
  /** Insert a column at `colIndex` (default = append) from `values` (default na-filled). */
  add_col(m: Matrix, colIndex?: number, values?: number[]): void {
    const idx = colIndex == null || Number.isNaN(colIndex) ? m.columns : Math.trunc(colIndex);
    if (m.rows === 0 && values) { // empty matrix adopts the vector's shape (mirrors add_row)
      for (const v of values) m.data.push([v]);
      m.rows = values.length;
      m.columns = 1;
      return;
    }
    for (let r = 0; r < m.rows; r++) m.data[r].splice(idx, 0, values ? values[r] ?? NaN : NaN);
    m.columns++;
  },
  /** Average of all non-na elements; na (NaN) when the matrix is empty. */
  avg(m: Matrix): number {
    let s = 0, n = 0;
    for (const row of m.data) for (const v of row) if (!Number.isNaN(v)) { s += v; n++; }
    return n ? s / n : NaN;
  },
  /** Largest non-na element; na when empty. */
  max(m: Matrix): number {
    let best = NaN;
    for (const row of m.data) for (const v of row) if (!Number.isNaN(v) && (Number.isNaN(best) || v > best)) best = v;
    return best;
  },
  /** Smallest non-na element; na when empty. */
  min(m: Matrix): number {
    let best = NaN;
    for (const row of m.data) for (const v of row) if (!Number.isNaN(v) && (Number.isNaN(best) || v < best)) best = v;
    return best;
  },
  /** Median of all non-na elements (mean of the two middle values for an even count). */
  median(m: Matrix): number {
    const v = flatten(m).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  },
  /** Most frequent non-na element; on a tie returns the smallest of the tied values. */
  mode(m: Matrix): number {
    const counts = new Map<number, number>();
    for (const v of flatten(m)) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = NaN, bestN = 0;
    for (const [val, c] of counts) if (c > bestN || (c === bestN && val < best)) { bestN = c; best = val; }
    return best;
  },
  /**
   * Fills the rectangular region [from_row, to_row) x [from_column, to_column)
   * with `value`. Omitted to_row/to_column default to the matrix dimensions.
   */
  fill(m: Matrix, value: number, from_row = 0, to_row = m.rows, from_column = 0, to_column = m.columns): void {
    const r0 = Math.max(0, from_row), r1 = Math.min(m.rows, to_row);
    const c0 = Math.max(0, from_column), c1 = Math.min(m.columns, to_column);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) m.data[r][c] = value;
  },
  /** Appends the rows of m2 to m1 in place (both must have the same column count);
   *  returns m1. A column-count mismatch is a no-op (Pine errors; soft-fail). */
  concat(m1: Matrix, m2: Matrix): Matrix {
    if (m1.columns !== m2.columns) return m1;
    for (const row of m2.data) { m1.data.push(row.slice()); m1.rows++; }
    return m1;
  },
  /** Removes the row at `row` in place and returns its values as an array. */
  remove_row(m: Matrix, row?: number): number[] {
    const r = row === undefined ? m.rows - 1 : row;
    if (r < 0 || r >= m.rows) return [];
    const removed = m.data.splice(r, 1)[0];
    m.rows--;
    return removed.slice();
  },
  /** Removes the column at `column` in place and returns its values as an array. */
  remove_col(m: Matrix, column?: number): number[] {
    const c = column === undefined ? m.columns - 1 : column;
    if (c < 0 || c >= m.columns) return [];
    const removed: number[] = [];
    for (const row of m.data) removed.push(row.splice(c, 1)[0]);
    m.columns--;
    return removed;
  },
  /** Swaps rows `row1` and `row2` in place (no-op if either index is out of range). */
  swap_rows(m: Matrix, row1: number, row2: number): void {
    if (row1 < 0 || row1 >= m.rows || row2 < 0 || row2 >= m.rows) return;
    const tmp = m.data[row1];
    m.data[row1] = m.data[row2];
    m.data[row2] = tmp;
  },
  /** Swaps columns `column1` and `column2` in place (no-op if either index is out of range). */
  swap_columns(m: Matrix, column1: number, column2: number): void {
    if (column1 < 0 || column1 >= m.columns || column2 < 0 || column2 >= m.columns) return;
    for (const row of m.data) {
      const tmp = row[column1];
      row[column1] = row[column2];
      row[column2] = tmp;
    }
  },
  /** Rebuilds the matrix to `rows` x `columns` in place, preserving elements in row-major order.
   *  A mismatched element count is a no-op (Pine errors; soft-fail keeps the matrix intact). */
  reshape(m: Matrix, rows: number, columns: number): void {
    const flat: number[] = [];
    for (const row of m.data) for (const v of row) flat.push(v);
    if (rows * columns !== flat.length) return;
    const data: number[][] = [];
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < columns; c++) row.push(flat[k++]);
      data.push(row);
    }
    m.rows = rows;
    m.columns = columns;
    m.data = data;
  },
  /**
   * Extracts a NEW matrix from the rectangular region [from_row, to_row) x
   * [from_column, to_column) (upper bounds exclusive). Omitted bounds default to the
   * matrix dimensions. Row/column indexing starts at zero.
   */
  submatrix(
    m: Matrix,
    from_row = 0,
    to_row = m.rows,
    from_column = 0,
    to_column = m.columns,
  ): Matrix {
    const r0 = Math.max(0, from_row), r1 = Math.min(m.rows, to_row);
    const c0 = Math.max(0, from_column), c1 = Math.min(m.columns, to_column);
    const data: number[][] = [];
    for (let r = r0; r < r1; r++) data.push(m.data[r].slice(c0, c1));
    return { rows: Math.max(0, r1 - r0), columns: Math.max(0, c1 - c0), data };
  },
  /**
   * Product of m1 with a matrix, a scalar, or an array (vector).
   * matrix*matrix requires m1.columns === m2.rows; matrix*array treats the array as a
   * single-column matrix and returns a plain array of length m1.rows (per Pine).
   * Returns na on a shape mismatch.
   */
  mult(m1: Matrix, other: Matrix | number | number[]): Matrix | number[] | typeof NA {
    if (typeof other === 'number') {
      return { rows: m1.rows, columns: m1.columns, data: m1.data.map((r) => r.map((v) => v * other)) };
    }
    const m2: Matrix = Array.isArray(other)
      ? { rows: other.length, columns: 1, data: other.map((v) => [v]) }
      : other;
    if (m1.columns !== m2.rows) return NA;
    const data: number[][] = [];
    for (let r = 0; r < m1.rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < m2.columns; c++) {
        let s = 0;
        for (let k = 0; k < m1.columns; k++) s += m1.data[r][k] * m2.data[k][c];
        row.push(s);
      }
      data.push(row);
    }
    return Array.isArray(other) ? data.map((r) => r[0]) : { rows: m1.rows, columns: m2.columns, data };
  },
  /** Determinant of a square matrix via Gaussian elimination with partial pivoting; na if not square. */
  det(m: Matrix): number {
    if (m.rows !== m.columns) return NaN;
    return determinant(m.data.map((r) => r.slice()));
  },
  /** Inverse of a square matrix via Gauss-Jordan elimination; na if not square or singular. */
  inv(m: Matrix): Matrix | typeof NA {
    if (m.rows !== m.columns) return NA;
    const inverse = invert(m.data.map((r) => r.slice()));
    return inverse ? { rows: m.rows, columns: m.columns, data: inverse } : NA;
  },
  /** Trace: sum of the main-diagonal elements (na propagates, per Pine arithmetic); na if not square. */
  trace(m: Matrix): number {
    if (m.rows !== m.columns) return NaN;
    let s = 0;
    for (let i = 0; i < m.rows; i++) s += m.data[i][i];
    return s;
  },
  /** Rank computed by Gaussian elimination with partial pivoting. */
  rank(m: Matrix): number {
    const a = m.data.map((r) => r.slice());
    const rows = m.rows, cols = m.columns;
    let rank = 0;
    const eps = 1e-12;
    for (let col = 0; col < cols && rank < rows; col++) {
      let pivot = rank;
      for (let r = rank + 1; r < rows; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      if (Math.abs(a[pivot][col]) < eps) continue;
      [a[rank], a[pivot]] = [a[pivot], a[rank]];
      for (let r = 0; r < rows; r++) {
        if (r === rank) continue;
        const f = a[r][col] / a[rank][col];
        for (let c = col; c < cols; c++) a[r][c] -= f * a[rank][c];
      }
      rank++;
    }
    return rank;
  },
  /** Raises a square matrix to a non-negative integer `power` (power 0 yields the
   *  identity); na for negative/fractional/na powers, which Pine does not support. */
  pow(m: Matrix, power: number): Matrix | typeof NA {
    if (m.rows !== m.columns) return NA;
    const p = Math.trunc(power);
    if (p !== power || p < 0) return NA; // NaN power fails p !== power too
    let result: Matrix = identity(m.rows);
    for (let i = 0; i < p; i++) {
      const next = MatrixNs.mult(result, m);
      if (next === NA) return NA;
      result = next as Matrix;
    }
    return result;
  },
  /** Reverses the order of rows and columns in place (first becomes last). */
  reverse(m: Matrix): void {
    m.data.reverse();
    for (const row of m.data) row.reverse();
  },
  /** Reorders rows in place by the values in `column` (default 0); order 'ascending' (default) or 'descending'. */
  sort(m: Matrix, column = 0, order = 'ascending'): void {
    const sign = order === 'descending' ? -1 : 1;
    m.data.sort((a, b) => {
      const x = a[column], y = b[column];
      if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
      if (Number.isNaN(y)) return -1;
      return (x - y) * sign;
    });
  },
  /**
   * Eigenvalues of a square matrix as an array<float> (na-array if not square).
   * Real eigenvalues only (the documented "Implicit QL Algorithm" path); computed
   * here via the unshifted/Wilkinson-shifted QR algorithm on a Hessenberg reduction,
   * which handles the corpus's symmetric and small non-symmetric matrices. Returned
   * in descending order, matching Pine/PineTS ordering for the 2x2 example
   * [[2,4],[6,8]] -> [10.7446, -0.7446].
   */
  eigenvalues(m: Matrix): number[] {
    if (m.rows !== m.columns) return [];
    const vals = eigenRealValues(m.data.map((r) => r.slice()));
    vals.sort((a, b) => b - a);
    return vals;
  },
  /**
   * Eigenvectors of a square matrix as a NEW matrix in which each COLUMN is an
   * eigenvector corresponding (in order) to the descending-sorted eigenvalues from
   * matrix.eigenvalues. Each eigenvector is L2-normalized to unit length, with sign
   * fixed so the first nonzero component is positive. na-matrix if not square.
   */
  eigenvectors(m: Matrix): Matrix | typeof NA {
    if (m.rows !== m.columns) return NA;
    const n = m.rows;
    const a = m.data.map((r) => r.slice());
    const vals = eigenRealValues(a.map((r) => r.slice()));
    vals.sort((x, y) => y - x);
    const cols: number[][] = vals.map((lambda) => eigenvectorFor(a, lambda));
    const data: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row: number[] = [];
      for (let c = 0; c < n; c++) row.push(cols[c][r]);
      data.push(row);
    }
    return { rows: n, columns: n, data };
  },
  /**
   * Moore-Penrose pseudoinverse. For a non-singular square matrix this equals
   * matrix.inv (LU/Gauss-Jordan). For a full-rank rectangular matrix it uses the
   * normal-equation form — tall (rows>cols): (AᵀA)⁻¹Aᵀ; wide (rows<cols): Aᵀ(AAᵀ)⁻¹.
   * Rank-deficient cases fall back to an SVD-based pseudoinverse. na if empty.
   */
  pinv(m: Matrix): Matrix | typeof NA {
    if (m.rows === 0 || m.columns === 0) return NA;
    const A = m.data.map((r) => r.slice());
    const rows = m.rows, cols = m.columns;
    // Square: try the regular inverse first (matches the manual's stated behavior).
    if (rows === cols) {
      const inverse = invert(A.map((r) => r.slice()));
      if (inverse) return { rows, columns: cols, data: inverse };
    }
    const At = transposeData(A);
    if (rows >= cols) {
      // (AᵀA)⁻¹ Aᵀ
      const AtA = multData(At, A);
      const inv = invert(AtA.map((r) => r.slice()));
      if (inv) return { rows: cols, columns: rows, data: multData(inv, At) };
    } else {
      // Aᵀ (AAᵀ)⁻¹
      const AAt = multData(A, At);
      const inv = invert(AAt.map((r) => r.slice()));
      if (inv) return { rows: cols, columns: rows, data: multData(At, inv) };
    }
    // Rank-deficient / singular normal equations: SVD-based pseudoinverse.
    const data = svdPseudoInverse(A);
    return { rows: cols, columns: rows, data };
  },
  /** Total number of elements (rows*columns); 0 for an empty matrix. */
  elements_count(m: Matrix): number {
    return m.rows === 0 ? 0 : m.rows * m.columns;
  },
  /** True if the matrix is square (rows === columns); false for an empty matrix. */
  is_square(m: Matrix): boolean {
    return m.rows !== 0 && m.rows === m.columns;
  },
  /** True if every element is 0; an empty matrix counts as zero (true). */
  is_zero(m: Matrix): boolean {
    if (m.rows === 0) return true;
    for (const row of m.data) for (const v of row) if (v !== 0) return false;
    return true;
  },
  /** True if the matrix is the identity (square, 1 on the main diagonal, 0 elsewhere); false if not square/empty. */
  is_identity(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.columns; c++) {
        if (r === c) { if (m.data[r][c] !== 1) return false; }
        else if (m.data[r][c] !== 0) return false;
      }
    return true;
  },
  /** True if the matrix is diagonal (square, every off-main-diagonal element 0); false if not square/empty. */
  is_diagonal(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.columns; c++)
        if (r !== c && m.data[r][c] !== 0) return false;
    return true;
  },
  /** True if the matrix is anti-diagonal (square, every element off the anti-diagonal r+c===n-1 is 0); false if not square/empty. */
  is_antidiagonal(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    const last = m.rows - 1;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.columns; c++)
        if (r + c !== last && m.data[r][c] !== 0) return false;
    return true;
  },
  /** True if the matrix is symmetric (square and a[r][c] === a[c][r]); false if not square/empty. */
  is_symmetric(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < r; c++)
        if (m.data[r][c] !== m.data[c][r]) return false;
    return true;
  },
  /** True if the matrix is antisymmetric (square and aᵀ === -a, so a[c][r] === -a[r][c], diagonal 0); false if not square/empty. */
  is_antisymmetric(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.columns; c++)
        if (m.data[c][r] !== -m.data[r][c]) return false;
    return true;
  },
  /** True if every element is 0 or 1; false for an empty matrix. */
  is_binary(m: Matrix): boolean {
    if (m.rows === 0) return false;
    for (const row of m.data) for (const v of row) if (v !== 0 && v !== 1) return false;
    return true;
  },
  /** True if the matrix is triangular (square and zeros below OR above the main diagonal); false if not square/empty. */
  is_triangular(m: Matrix): boolean {
    if (m.rows === 0 || m.rows !== m.columns) return false;
    let lower = true, upper = true; // lower-triangular keeps zeros above; upper-triangular keeps zeros below.
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.columns; c++) {
        if (r > c && m.data[r][c] !== 0) upper = false; // entry below the diagonal
        if (r < c && m.data[r][c] !== 0) lower = false; // entry above the diagonal
      }
    return upper || lower;
  },
  /**
   * True if the matrix is (row-)stochastic: every element >= 0 and each row sums to 1
   * (within 1e-10). False for an empty matrix. Matches PineTS, which does not require
   * the matrix to be square.
   */
  is_stochastic(m: Matrix): boolean {
    if (m.rows === 0) return false;
    for (const row of m.data) {
      let s = 0;
      for (const v of row) { if (v < 0) return false; s += v; }
      if (Math.abs(s - 1) > 1e-10) return false;
    }
    return true;
  },
  /** Kronecker product of m1 and m2. */
  kron(m1: Matrix, m2: Matrix): Matrix {
    const rows = m1.rows * m2.rows, columns = m1.columns * m2.columns;
    const data: number[][] = [];
    for (let r = 0; r < rows; r++) data.push(new Array(columns).fill(NaN));
    for (let r1 = 0; r1 < m1.rows; r1++)
      for (let c1 = 0; c1 < m1.columns; c1++)
        for (let r2 = 0; r2 < m2.rows; r2++)
          for (let c2 = 0; c2 < m2.columns; c2++)
            data[r1 * m2.rows + r2][c1 * m2.columns + c2] = m1.data[r1][c1] * m2.data[r2][c2];
    return { rows, columns, data };
  },
};
export type MatrixNamespace = typeof MatrixNs;

/** Flattens a matrix to its non-na (non-NaN) elements. */
function flatten(m: Matrix): number[] {
  const out: number[] = [];
  for (const row of m.data) for (const v of row) if (!Number.isNaN(v)) out.push(v);
  return out;
}

/** n x n identity matrix. */
function identity(n: number): Matrix {
  const data: number[][] = [];
  for (let r = 0; r < n; r++) { const row = new Array(n).fill(0); row[r] = 1; data.push(row); }
  return { rows: n, columns: n, data };
}

/** Determinant via Gaussian elimination with partial pivoting (mutates `a`). */
function determinant(a: number[][]): number {
  const n = a.length;
  let det = 1;
  const eps = 1e-12;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < eps) return 0;
    if (pivot !== col) { [a[col], a[pivot]] = [a[pivot], a[col]]; det = -det; }
    det *= a[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return det;
}

/** Transpose of a raw 2D array. */
function transposeData(a: number[][]): number[][] {
  const rows = a.length, cols = rows ? a[0].length : 0;
  const out: number[][] = [];
  for (let c = 0; c < cols; c++) { const row: number[] = []; for (let r = 0; r < rows; r++) row.push(a[r][c]); out.push(row); }
  return out;
}

/** Matrix product of two raw 2D arrays (a: p×q, b: q×s → p×s). */
function multData(a: number[][], b: number[][]): number[][] {
  const p = a.length, q = a.length ? a[0].length : 0, s = b.length ? b[0].length : 0;
  const out: number[][] = [];
  for (let i = 0; i < p; i++) {
    const row = new Array(s).fill(0);
    for (let k = 0; k < q; k++) { const aik = a[i][k]; if (aik !== 0) for (let j = 0; j < s; j++) row[j] += aik * b[k][j]; }
    out.push(row);
  }
  return out;
}

/**
 * Real eigenvalues of a square matrix via the QR algorithm with Wilkinson shifts
 * on an upper-Hessenberg reduction, deflating 1×1 and 2×2 trailing blocks. Returns
 * only the real parts of real eigenvalues (a 2×2 block with a negative discriminant
 * — a complex-conjugate pair — contributes its two real parts, but the corpus's
 * symmetric/simple matrices yield real eigenvalues).
 */
function eigenRealValues(a: number[][]): number[] {
  const n = a.length;
  if (n === 0) return [];
  if (n === 1) return [a[0][0]];
  if (n === 2) return eig2x2(a[0][0], a[0][1], a[1][0], a[1][1]);
  hessenberg(a);
  const eps = 1e-12;
  const out: number[] = [];
  let hi = n - 1;
  let iter = 0;
  const maxIter = 1000 * n;
  while (hi >= 0) {
    if (hi === 0) { out.push(a[0][0]); hi = -1; break; }
    // Find a small sub-diagonal element to deflate at.
    let lo = hi;
    while (lo > 0) {
      const s = Math.abs(a[lo - 1][lo - 1]) + Math.abs(a[lo][lo]);
      if (Math.abs(a[lo][lo - 1]) <= eps * (s === 0 ? 1 : s)) { a[lo][lo - 1] = 0; break; }
      lo--;
    }
    if (lo === hi) {
      // 1×1 block converged.
      out.push(a[hi][hi]);
      hi--;
      iter = 0;
      continue;
    }
    if (lo === hi - 1) {
      // 2×2 trailing block: solve directly.
      const pair = eig2x2(a[lo][lo], a[lo][hi], a[hi][lo], a[hi][hi]);
      out.push(pair[0], pair[1]);
      hi -= 2;
      iter = 0;
      continue;
    }
    if (++iter > maxIter) {
      // Fallback: emit remaining diagonal as best-effort.
      for (let i = lo; i <= hi; i++) out.push(a[i][i]);
      hi = lo - 1;
      iter = 0;
      continue;
    }
    // Wilkinson shift from the trailing 2×2 block [lo..hi].
    const p = hi - 1;
    const dd = (a[p][p] - a[hi][hi]) / 2;
    const bc = a[hi][p] * a[p][hi];
    let mu = a[hi][hi];
    const denom = dd + Math.sign(dd || 1) * Math.sqrt(Math.max(0, dd * dd + bc));
    if (denom !== 0) mu = a[hi][hi] - bc / denom;
    // Shifted QR step on the active sub-block [lo..hi] via Givens rotations.
    qrStep(a, lo, hi, mu);
  }
  return out;
}

/** Real-part eigenvalues of a 2×2 block [[a,b],[c,d]]. */
function eig2x2(a: number, b: number, c: number, d: number): number[] {
  const tr = a + d;
  const det = a * d - b * c;
  const disc = tr * tr - 4 * det;
  if (disc < 0) { const re = tr / 2; return [re, re]; }
  const s = Math.sqrt(disc);
  return [(tr + s) / 2, (tr - s) / 2];
}

/** In-place reduction of a square matrix to upper-Hessenberg form via Householder. */
function hessenberg(a: number[][]): void {
  const n = a.length;
  for (let k = 0; k < n - 2; k++) {
    let scale = 0;
    for (let i = k + 1; i < n; i++) scale += Math.abs(a[i][k]);
    if (scale === 0) continue;
    let h = 0;
    const v = new Array(n).fill(0);
    for (let i = k + 1; i < n; i++) { v[i] = a[i][k] / scale; h += v[i] * v[i]; }
    let g = Math.sqrt(h);
    if (v[k + 1] > 0) g = -g;
    h -= v[k + 1] * g;
    v[k + 1] -= g;
    // Apply similarity transform A := (I - vvᵀ/h) A (I - vvᵀ/h).
    // Left: A := A - v (vᵀA)/h
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = k + 1; i < n; i++) sum += v[i] * a[i][j];
      sum /= h;
      for (let i = k + 1; i < n; i++) a[i][j] -= v[i] * sum;
    }
    // Right: A := A - (Av) vᵀ/h
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = k + 1; j < n; j++) sum += a[i][j] * v[j];
      sum /= h;
      for (let j = k + 1; j < n; j++) a[i][j] -= sum * v[j];
    }
    a[k + 1][k] = scale * g;
    for (let i = k + 2; i < n; i++) a[i][k] = 0;
  }
}

/** One shifted QR sweep on the active Hessenberg sub-block [lo..hi] via Givens rotations. */
function qrStep(a: number[][], lo: number, hi: number, mu: number): void {
  const n = a.length;
  for (let i = lo; i <= hi; i++) a[i][i] -= mu;
  const cs: number[] = [];
  const sn: number[] = [];
  // QR via Givens to annihilate sub-diagonal entries.
  for (let i = lo; i < hi; i++) {
    const x = a[i][i], y = a[i + 1][i];
    const r = Math.hypot(x, y);
    const c = r === 0 ? 1 : x / r;
    const s = r === 0 ? 0 : y / r;
    cs[i] = c; sn[i] = s;
    for (let j = i; j < n; j++) {
      const t1 = a[i][j], t2 = a[i + 1][j];
      a[i][j] = c * t1 + s * t2;
      a[i + 1][j] = -s * t1 + c * t2;
    }
  }
  // Form RQ by applying the rotations from the right.
  for (let i = lo; i < hi; i++) {
    const c = cs[i], s = sn[i];
    for (let j = 0; j <= Math.min(i + 2, hi); j++) {
      const t1 = a[j][i], t2 = a[j][i + 1];
      a[j][i] = c * t1 + s * t2;
      a[j][i + 1] = -s * t1 + c * t2;
    }
  }
  for (let i = lo; i <= hi; i++) a[i][i] += mu;
}

/**
 * Unit eigenvector for eigenvalue `lambda` of square matrix `a`, via inverse
 * iteration on (A - (lambda+δ)I) with a small shift to avoid exact singularity,
 * falling back to a null-space solve from Gaussian elimination. Sign fixed so the
 * first significant component is positive.
 */
function eigenvectorFor(a: number[][], lambda: number): number[] {
  const n = a.length;
  const scale = matrixNorm(a) || 1;
  const shift = lambda + 1e-8 * scale * (lambda >= 0 ? 1 : -1);
  // (A - shift I)
  const M = a.map((r, i) => r.map((v, j) => (i === j ? v - shift : v)));
  const inv = invert(M.map((r) => r.slice()));
  let v: number[];
  if (inv) {
    // Inverse iteration: start from a fixed vector, iterate v := normalize(inv·v).
    v = new Array(n).fill(0).map((_, i) => 1 + i * 0.0001);
    for (let it = 0; it < 50; it++) {
      const w = new Array(n).fill(0);
      for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += inv[i][j] * v[j]; w[i] = s; }
      const nrm = Math.hypot(...w);
      if (nrm === 0) break;
      for (let i = 0; i < n; i++) w[i] /= nrm;
      // Converged when direction stabilizes.
      let dot = 0; for (let i = 0; i < n; i++) dot += w[i] * v[i];
      v = w;
      if (Math.abs(Math.abs(dot) - 1) < 1e-14) break;
    }
  } else {
    v = nullSpaceVector(a.map((r, i) => r.map((val, j) => (i === j ? val - lambda : val))));
  }
  const nrm = Math.hypot(...v) || 1;
  for (let i = 0; i < n; i++) v[i] /= nrm;
  // Fix sign: first component with |x|>tol positive.
  for (let i = 0; i < n; i++) {
    if (Math.abs(v[i]) > 1e-9) { if (v[i] < 0) for (let k = 0; k < n; k++) v[k] = -v[k]; break; }
  }
  return v;
}

/** Frobenius-ish norm (max abs entry) for shift scaling. */
function matrixNorm(a: number[][]): number {
  let m = 0;
  for (const row of a) for (const v of row) m = Math.max(m, Math.abs(v));
  return m;
}

/** A unit null-space vector of `m` (n×n) via Gaussian elimination with free-variable back-substitution. */
function nullSpaceVector(m: number[][]): number[] {
  const n = m.length;
  const A = m.map((r) => r.slice());
  const eps = 1e-9;
  const pivotCol: number[] = [];
  let row = 0;
  const where = new Array(n).fill(-1);
  for (let col = 0; col < n && row < n; col++) {
    let sel = row;
    for (let r = row + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[sel][col])) sel = r;
    if (Math.abs(A[sel][col]) < eps) continue;
    [A[row], A[sel]] = [A[sel], A[row]];
    const d = A[row][col];
    for (let c = 0; c < n; c++) A[row][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === row) continue;
      const f = A[r][col];
      if (f !== 0) for (let c = 0; c < n; c++) A[r][c] -= f * A[row][c];
    }
    where[col] = row;
    pivotCol.push(col);
    row++;
  }
  // Pick a free column for the null vector.
  let free = -1;
  for (let col = 0; col < n; col++) if (where[col] === -1) { free = col; break; }
  const v = new Array(n).fill(0);
  if (free === -1) { v[n - 1] = 1; return v; }
  v[free] = 1;
  for (let col = 0; col < n; col++) {
    const r = where[col];
    if (r !== -1) v[col] = -A[r][free];
  }
  return v;
}

/**
 * SVD-based Moore-Penrose pseudoinverse for general/rank-deficient matrices.
 * Computes the SVD via one-sided Jacobi rotations on Aᵀ (so right singular vectors
 * are obtained directly), then forms A⁺ = V Σ⁺ Uᵀ. Returns a cols×rows raw array.
 */
function svdPseudoInverse(A: number[][]): number[][] {
  const m = A.length, n = A[0].length;
  // Work on whichever orientation keeps the Jacobi matrix small (n columns).
  // One-sided Jacobi: orthogonalize columns of U = A; accumulate V.
  const U = A.map((r) => r.slice()); // m×n
  const V: number[][] = [];
  for (let i = 0; i < n; i++) { const row = new Array(n).fill(0); row[i] = 1; V.push(row); }
  const eps = 1e-15;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let i = 0; i < m; i++) { alpha += U[i][p] * U[i][p]; beta += U[i][q] * U[i][q]; gamma += U[i][p] * U[i][q]; }
        off += gamma * gamma;
        if (Math.abs(gamma) < eps) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < m; i++) { const up = U[i][p], uq = U[i][q]; U[i][p] = c * up - s * uq; U[i][q] = s * up + c * uq; }
        for (let i = 0; i < n; i++) { const vp = V[i][p], vq = V[i][q]; V[i][p] = c * vp - s * vq; V[i][q] = s * vp + c * vq; }
      }
    }
    if (off < 1e-30) break;
  }
  // Singular values = column norms of U; normalize columns to get left vectors.
  const sigma = new Array(n).fill(0);
  for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += U[i][j] * U[i][j]; sigma[j] = Math.sqrt(s); }
  let maxSig = 0; for (const s of sigma) maxSig = Math.max(maxSig, s);
  const tol = maxSig * Math.max(m, n) * 1e-15;
  // A⁺ = V Σ⁺ Uᵀ_normalized.  Uhat[:,j] = U[:,j]/sigma[j].
  const out: number[][] = [];
  for (let i = 0; i < n; i++) out.push(new Array(m).fill(0));
  for (let j = 0; j < n; j++) {
    if (sigma[j] <= tol) continue;
    const invS = 1 / sigma[j];
    for (let a = 0; a < n; a++) {
      const vaj = V[a][j];
      if (vaj === 0) continue;
      for (let b = 0; b < m; b++) out[a][b] += vaj * (U[b][j] * invS) * invS;
    }
  }
  return out;
}

/** Inverse via Gauss-Jordan elimination (mutates `a`); null if singular. */
function invert(a: number[][]): number[][] | null {
  const n = a.length;
  const inv: number[][] = identity(n).data;
  const eps = 1e-12;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < eps) return null;
    if (pivot !== col) { [a[col], a[pivot]] = [a[pivot], a[col]]; [inv[col], inv[pivot]] = [inv[pivot], inv[col]]; }
    const d = a[col][col];
    for (let c = 0; c < n; c++) { a[col][c] /= d; inv[col][c] /= d; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let c = 0; c < n; c++) { a[r][c] -= f * a[col][c]; inv[r][c] -= f * inv[col][c]; }
    }
  }
  return inv;
}
