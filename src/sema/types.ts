/**
 * Pine v6 type & qualifier system (docs/architecture.md §3).
 *
 * Every Pine value has a (qualifier, type) pair. The qualifier is what tells the
 * compiler whether a value can carry history: only `series` values get history
 * slots. Qualifiers form a lattice weakest→strongest; an expression takes the
 * strongest qualifier among its operands.
 */

export enum Qualifier {
  Const = 0,
  Input = 1,
  Simple = 2,
  Series = 3,
}

export type PineType =
  | { kind: 'int' }
  | { kind: 'float' }
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'color' }
  | { kind: 'line' }
  | { kind: 'label' }
  | { kind: 'box' }
  | { kind: 'table' }
  | { kind: 'polyline' }
  | { kind: 'linefill' }
  | { kind: 'array'; of: PineType }
  | { kind: 'matrix'; of: PineType }
  | { kind: 'map'; key: PineType; value: PineType }
  | { kind: 'udt'; name: string }
  | { kind: 'tuple'; items: PineType[] }
  | { kind: 'void' }
  | { kind: 'na' };

export interface QualifiedType {
  qualifier: Qualifier;
  type: PineType;
}

/** Combine qualifiers: the result is the strongest (max) of the inputs. */
export function joinQualifier(a: Qualifier, b: Qualifier): Qualifier {
  return Math.max(a, b);
}

export const qtype = (qualifier: Qualifier, type: PineType): QualifiedType => ({
  qualifier,
  type,
});
