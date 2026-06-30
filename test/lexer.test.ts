import { describe, it, expect } from 'bun:test';
import { tokenize } from '../src/lexer/lexer.js';
import { TokenKind } from '../src/lexer/token.js';

const kinds = (src: string) => tokenize(src).tokens.map((t) => t.kind);
const vals = (src: string) => tokenize(src).tokens.filter((t) => t.kind !== TokenKind.Eof).map((t) => t.value || `<${t.kind}>`);

describe('lexer', () => {
  it('captures the version directive and skips comments', () => {
    const { version, tokens } = tokenize('//@version=6\n// a comment\nx = 1\n');
    expect(version).toBe(6);
    // version + comment lines produce no code tokens before `x`
    expect(tokens[0].value).toBe('x');
  });

  it('lexes literals with decoded values', () => {
    const t = tokenize('a = 3.14\nb = 42\nc = "hi"\nd = #ff0000\ne = true\nf = na\n').tokens;
    const lit = (name: string) => {
      const idx = t.findIndex((x) => x.value === name);
      return t[idx + 2].literal; // name '=' literal
    };
    expect(lit('a')).toBeCloseTo(3.14, 9);
    expect(lit('b')).toBe(42);
    expect(lit('c')).toBe('hi');
    expect(lit('d')).toBe('#FF0000FF'); // normalized to 8-digit upper
    expect(lit('e')).toBe(true);
  });

  it('does not bake sign into numbers (a-1 is three tokens)', () => {
    expect(vals('y = a-1\n')).toEqual(['y', '=', 'a', '-', '1', '<Newline>']);
  });

  it('uses maximal munch for := and ==', () => {
    expect(vals('x := y == 1\n')).toEqual(['x', ':=', 'y', '==', '1', '<Newline>']);
  });

  it('emits INDENT/DEDENT for blocks', () => {
    const k = kinds('if c\n    x = 1\ny = 2\n');
    // if c NEWLINE INDENT x = 1 NEWLINE DEDENT y = 2 NEWLINE EOF
    expect(k).toEqual([
      TokenKind.Keyword, TokenKind.Ident, TokenKind.Newline,
      TokenKind.Indent, TokenKind.Ident, TokenKind.Op, TokenKind.Int, TokenKind.Newline,
      TokenKind.Dedent, TokenKind.Ident, TokenKind.Op, TokenKind.Int, TokenKind.Newline,
      TokenKind.Eof,
    ]);
  });

  it('treats non-multiple-of-4 indent as line continuation', () => {
    // lines 2 and 3 indented 5 and 10 spaces → one logical statement, no INDENT
    const k = kinds('x = open + high +\n     low +\n          close\n');
    expect(k).not.toContain(TokenKind.Indent);
    // exactly one NEWLINE (end of the single statement) + EOF
    expect(k.filter((x) => x === TokenKind.Newline).length).toBe(1);
  });

  it('suspends indentation logic inside parentheses', () => {
    const k = kinds('plot(sma(close, 14),\n    color)\n');
    expect(k).not.toContain(TokenKind.Indent);
  });

  describe('multiline strings (`"""…"""` / `\'\'\'…\'\'\'`, Pine v6 Apr 2026)', () => {
    const strLits = (src: string) =>
      tokenize(src).tokens.filter((t) => t.kind === TokenKind.String).map((t) => t.literal);

    it('lexes a single-line triple-quoted string', () => {
      expect(strLits('x = """hello"""\n')).toEqual(['hello']);
    });

    it('joins physical lines with a newline and preserves indentation literally', () => {
      expect(strLits('s = """a\n    b"""\n')).toEqual(['a\n    b']);
    });

    it('keeps the rest of the closing line as ordinary tokens (single NEWLINE)', () => {
      const k = kinds('x = """a\nb""" + 1\n');
      // Ident = String Op Int NEWLINE EOF — exactly one logical statement.
      expect(k).toEqual([
        TokenKind.Ident, TokenKind.Op, TokenKind.String, TokenKind.Op, TokenKind.Int,
        TokenKind.Newline, TokenKind.Eof,
      ]);
    });

    it('supports the apostrophe form and treats inner quotes literally', () => {
      expect(strLits("s = '''he said \"hi\"\nbye'''\n")).toEqual(['he said "hi"\nbye']);
    });

    it('includes a leading newline when the opening delimiter ends the line', () => {
      expect(strLits('s = """\nabc"""\n')).toEqual(['\nabc']);
    });

    it('still decodes backslash escapes (consistent with single-line strings)', () => {
      expect(strLits('x = """tab\\tend"""\n')).toEqual(['tab\tend']);
    });

    it('does not treat an empty "" pair as a triple delimiter', () => {
      expect(strLits('x = "" + "y"\n')).toEqual(['', 'y']);
    });

    it('lexes an empty multiline string', () => {
      expect(strLits('x = """"""\n')).toEqual(['']);
    });

    it('works inside call arguments (brackets already suspend layout)', () => {
      expect(strLits('plot(close, title="""multi\nline""")\n')).toEqual(['multi\nline']);
    });

    it('throws on an unterminated multiline string, pointing at the opener', () => {
      expect(() => tokenize('//@version=6\nx = """oops\nstill going\n')).toThrow(
        /unterminated multiline string/,
      );
    });

    // The remaining cases reproduce the verbatim Pine v6 release-notes examples so the
    // lexer is pinned to TradingView's own documented behavior, not just our reading of it.

    it('matches the release-notes escape example (`\\\\n` in source → `\\n` in value)', () => {
      // Source contains the two chars backslash-backslash-n; the documented intent is that
      // the printed string shows a single-backslash `\n`, which requires escape decoding.
      const src = 's = """add the `\\\\n` escape sequence"""\n';
      expect(strLits(src)).toEqual(['add the `\\n` escape sequence']);
    });

    it('matches the release-notes concatenation example (mixes """ and \'\'\', trailing \\n each)', () => {
      const src =
        'string concatenated = """String 1\n""" + """String 2\n""" + \'\'\'String 3\n\'\'\'\n';
      expect(strLits(src)).toEqual(['String 1\n', 'String 2\n', 'String 3\n']);
    });

    it('includes a trailing newline when the closing delimiter sits on its own line', () => {
      // Symmetric to the leading-newline case; the release-notes indentation example relies on it.
      expect(strLits('s = """a\nb\n"""\n')).toEqual(['a\nb\n']);
    });
  });
});
