/** Token kinds for the Pine v6 lexer (docs/compiler-design.md §2.1). */
export enum TokenKind {
  // literals
  Int = 'Int',
  Float = 'Float',
  String = 'String',
  Color = 'Color',
  Bool = 'Bool',
  Na = 'Na',
  // identifiers & keywords
  Ident = 'Ident',
  Keyword = 'Keyword',
  // operators / punctuation
  Op = 'Op',
  Punct = 'Punct',
  // layout
  Newline = 'Newline',
  Indent = 'Indent',
  Dedent = 'Dedent',
  Eof = 'Eof',
}

export interface Token {
  kind: TokenKind;
  /** Canonical text (operator symbol, identifier, keyword, or raw literal text). */
  value: string;
  /** Decoded value for literals (number / string contents / bool / normalized color). */
  literal?: number | string | boolean;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  'if',
  'else',
  'switch',
  'for',
  'to',
  'by',
  'in',
  'while',
  'break',
  'continue',
  'var',
  'varip',
  'and',
  'or',
  'not',
  'true',
  'false',
  'na',
  'import',
  'as',
  'export',
  'method',
  'type',
  'enum',
  'int',
  'float',
  'bool',
  'color',
  'string',
  'const',
  'simple',
  'series',
]);

/** Multi-character operators, longest first (maximal munch). */
export const MULTI_OPS = [':=', '==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%='];

export const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '?', ':']);

export const PUNCT = new Set(['(', ')', '[', ']', ',', '.']);
