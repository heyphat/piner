/**
 * Pine v6 lexer (docs/compiler-design.md §2). Char stream → tokens, emitting
 * NEWLINE / INDENT / DEDENT layout tokens via an indentation engine. The core
 * difficulty is continuation: a non-zero indent that is *not* a multiple of 4
 * (outside brackets) glues onto the previous logical line; a multiple-of-4 indent
 * opens/continues a block; open brackets — and an open multiline string (`"""…"""`
 * / `'''…'''`, Pine v6 Apr-2026) — suspend all indentation logic.
 */
import { TokenKind, KEYWORDS, MULTI_OPS, SINGLE_OPS, PUNCT, type Token } from './token.js';

export class LexError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`Lex error at ${line}:${col}: ${message}`);
    this.name = 'LexError';
  }
}

export interface LexResult {
  tokens: Token[];
  version: number;
}

const HEX = /^[0-9a-fA-F]+$/;

export function tokenize(source: string): LexResult {
  return new Lexer(source).run();
}

class Lexer {
  private tokens: Token[] = [];
  private bracketDepth = 0;
  private indentStack = [0];
  private pendingNewline = false;
  private version = 6;
  private seenCode = false;
  private lines: string[];
  // An open multiline string (`"""…` / `'''…`) whose closing delimiter hasn't been
  // seen yet. While set, physical lines are swallowed as raw string content (joined by
  // newlines) and all layout logic is suspended — like an open bracket. `value` is the
  // RAW content; escapes are decoded once at close.
  private mlString: { value: string; quote: string; startLine: number; startCol: number } | null = null;

  constructor(source: string) {
    // Normalize line endings; keep physical lines.
    this.lines = source.replace(/\r\n?/g, '\n').split('\n');
  }

  run(): LexResult {
    for (let i = 0; i < this.lines.length; i++) {
      this.processLine(this.lines[i], i + 1);
    }
    if (this.mlString) {
      throw new LexError('unterminated multiline string literal', this.mlString.startLine, this.mlString.startCol);
    }
    if (this.pendingNewline) this.emit(TokenKind.Newline, '', this.lines.length + 1, 1);
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.emit(TokenKind.Dedent, '', this.lines.length + 1, 1);
    }
    this.emit(TokenKind.Eof, '', this.lines.length + 1, 1);
    return { tokens: this.tokens, version: this.version };
  }

  private processLine(line: string, lineNo: number): void {
    // (0) Continuation of a multiline string opened on an earlier physical line.
    // Swallow whole lines (newline-joined) until the closing delimiter; layout logic
    // (indent/dedent/newline) stays suspended, so `pendingNewline` — already true from
    // the statement's first line — is left untouched.
    if (this.mlString) {
      const close = this.findTripleClose(line, 0, this.mlString.quote);
      if (close < 0) {
        this.mlString.value += '\n' + line; // entire line is literal content
        return;
      }
      this.mlString.value += '\n' + line.slice(0, close);
      this.closeMlString();
      this.scanTokens(line, lineNo, close + 3); // rest of the line resumes as normal tokens
      return;
    }

    let spaces = 0;
    let tabs = 0;
    let i = 0;
    for (; i < line.length; i++) {
      if (line[i] === ' ') spaces++;
      else if (line[i] === '\t') tabs++;
      else break;
    }
    const content = line.slice(i);

    // (a) blank or comment-only lines are layout-irrelevant.
    if (content === '' || content.startsWith('//')) {
      // The version directive is only honored on the first, unindented line,
      // before any code (a late or indented //@version is ignored).
      if (!this.seenCode && spaces === 0 && tabs === 0) {
        const m = /^\/\/@version=(\d+)/.exec(content);
        if (m) this.version = Number(m[1]);
      }
      return;
    }

    // (b) open brackets suspend indentation logic → continuation.
    if (this.bracketDepth > 0) {
      this.scanTokens(line, lineNo);
      return;
    }

    if (spaces > 0 && tabs > 0) {
      throw new LexError('mixed tabs and spaces in indentation', lineNo, 1);
    }

    // (c) classify indentation.
    let level: number;
    let isContinuation = false;
    if (spaces === 0 && tabs === 0) {
      level = 0;
    } else if (tabs > 0) {
      level = tabs; // one tab = one block level
    } else if (spaces % 4 === 0) {
      level = spaces / 4;
    } else {
      isContinuation = true;
      level = -1;
    }

    if (isContinuation) {
      // A continuation must extend a real preceding statement; a misindented
      // first line has nothing to continue.
      if (!this.pendingNewline) throw new LexError('unexpected indentation', lineNo, spaces + 1);
      this.scanTokens(line, lineNo); // glue onto previous logical line
      return;
    }

    // New logical statement: terminate the previous one, then adjust block level.
    if (this.pendingNewline) {
      this.emit(TokenKind.Newline, '', lineNo, 1);
      this.pendingNewline = false;
    }
    const top = this.indentStack[this.indentStack.length - 1];
    if (level > top) {
      this.indentStack.push(level);
      this.emit(TokenKind.Indent, '', lineNo, 1);
    } else if (level < top) {
      while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > level) {
        this.indentStack.pop();
        this.emit(TokenKind.Dedent, '', lineNo, 1);
      }
      // A dedent must land exactly on an enclosing level.
      if (this.indentStack[this.indentStack.length - 1] !== level) {
        throw new LexError('dedent does not match any enclosing indentation level', lineNo, 1);
      }
    }
    this.scanTokens(line, lineNo);
    this.pendingNewline = true;
  }

  /** Scan the code tokens of one physical line (no layout tokens). `start` lets a
   * caller resume mid-line after a multiline string's closing delimiter. */
  private scanTokens(line: string, lineNo: number, start = 0): void {
    let i = start;
    const n = line.length;
    while (i < n) {
      const c = line[i];
      // whitespace
      if (c === ' ' || c === '\t') {
        i++;
        continue;
      }
      // comment to end of line
      if (c === '/' && line[i + 1] === '/') break;
      const col = i + 1;

      // string
      if (c === '"' || c === "'") {
        // Triple delimiter (`"""` / `'''`) ⇒ multiline string (Pine v6, Apr 2026).
        if (line[i + 1] === c && line[i + 2] === c) {
          const close = this.findTripleClose(line, i + 3, c);
          if (close < 0) {
            // Opens here; the rest of the line (and following lines) is content.
            this.mlString = { value: line.slice(i + 3), quote: c, startLine: lineNo, startCol: col };
            return;
          }
          const value = this.unescape(line.slice(i + 3, close));
          this.push(TokenKind.String, line.slice(i, close + 3), lineNo, col, value);
          i = close + 3;
          continue;
        }
        const { value, end } = this.scanString(line, i, lineNo);
        this.push(TokenKind.String, line.slice(i, end), lineNo, col, value);
        i = end;
        continue;
      }
      // color literal
      if (c === '#') {
        let j = i + 1;
        while (j < n && /[0-9a-fA-F]/.test(line[j])) j++;
        const hex = line.slice(i + 1, j);
        if ((hex.length !== 6 && hex.length !== 8) || !HEX.test(hex)) {
          throw new LexError('invalid color literal (expected #RRGGBB or #RRGGBBAA)', lineNo, col);
        }
        const norm = '#' + (hex.length === 6 ? hex + 'FF' : hex).toUpperCase();
        this.push(TokenKind.Color, line.slice(i, j), lineNo, col, norm);
        i = j;
        continue;
      }
      // number (digit, or .digit)
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
        const { end, isInt } = this.scanNumber(line, i);
        const text = line.slice(i, end);
        this.push(isInt ? TokenKind.Int : TokenKind.Float, text, lineNo, col, Number(text));
        i = end;
        continue;
      }
      // identifier / keyword
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (word === 'true' || word === 'false') {
          this.push(TokenKind.Bool, word, lineNo, col, word === 'true');
        } else if (word === 'na') {
          this.push(TokenKind.Na, word, lineNo, col);
        } else if (KEYWORDS.has(word)) {
          this.push(TokenKind.Keyword, word, lineNo, col);
        } else {
          this.push(TokenKind.Ident, word, lineNo, col);
        }
        i = j;
        continue;
      }
      // multi-char operators (maximal munch)
      const two = line.slice(i, i + 2);
      if (MULTI_OPS.includes(two)) {
        this.push(TokenKind.Op, two, lineNo, col);
        i += 2;
        continue;
      }
      // punctuation (track bracket depth)
      if (PUNCT.has(c)) {
        if (c === '(' || c === '[') this.bracketDepth++;
        else if (c === ')' || c === ']') this.bracketDepth = Math.max(0, this.bracketDepth - 1);
        this.push(TokenKind.Punct, c, lineNo, col);
        i++;
        continue;
      }
      // single-char operators
      if (SINGLE_OPS.has(c)) {
        this.push(TokenKind.Op, c, lineNo, col);
        i++;
        continue;
      }
      throw new LexError(`unexpected character ${JSON.stringify(c)}`, lineNo, col);
    }
  }

  private scanString(line: string, start: number, lineNo: number): { value: string; end: number } {
    const quote = line[start];
    let i = start + 1;
    let out = '';
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\') {
        const next = line[i + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) return { value: out, end: i + 1 };
      out += ch;
      i++;
    }
    throw new LexError('unterminated string literal', lineNo, start + 1);
  }

  /** Index of the next `q q q` triple delimiter at/after `from` in `s`, or -1.
   * Delimiter detection is purely textual (escapes don't shield it), matching
   * "all code between the delimiters is literal text". */
  private findTripleClose(s: string, from: number, q: string): number {
    for (let i = from; i + 2 < s.length; i++) {
      if (s[i] === q && s[i + 1] === q && s[i + 2] === q) return i;
    }
    return -1;
  }

  /** Decode backslash escapes in multiline-string content — mirrors single-line
   * `scanString` (a multiline string is still a string literal). Escapes ARE processed:
   * the v6 release-notes example writes `\\n` inside a `"""…"""` and expects the printed
   * value to show `\n` (one backslash), which only holds if `\\` decodes to `\`. */
  private unescape(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') {
        const next = s[i + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
        i++;
        continue;
      }
      out += s[i];
    }
    return out;
  }

  /** Emit the accumulated multiline string as one String token, decoding escapes. */
  private closeMlString(): void {
    const s = this.mlString!;
    const raw = s.quote.repeat(3) + s.value + s.quote.repeat(3);
    this.push(TokenKind.String, raw, s.startLine, s.startCol, this.unescape(s.value));
    this.mlString = null;
  }

  private scanNumber(line: string, start: number): { end: number; isInt: boolean } {
    let i = start;
    let isInt = true;
    while (i < line.length && /[0-9]/.test(line[i])) i++;
    if (line[i] === '.') {
      isInt = false;
      i++;
      while (i < line.length && /[0-9]/.test(line[i])) i++;
    }
    if (line[i] === 'e' || line[i] === 'E') {
      // Only consume the exponent if at least one digit follows the (optional)
      // sign; otherwise leave `e` to start a separate identifier (e.g. `1e` is
      // not a valid float — it lexes as Int 1 then Ident e).
      let j = i + 1;
      if (line[j] === '+' || line[j] === '-') j++;
      if (/[0-9]/.test(line[j] ?? '')) {
        isInt = false;
        i = j + 1;
        while (i < line.length && /[0-9]/.test(line[i])) i++;
      }
    }
    return { end: i, isInt };
  }

  private push(kind: TokenKind, value: string, line: number, col: number, literal?: number | string | boolean): void {
    this.seenCode = true;
    this.tokens.push({ kind, value, line, col, literal });
  }
  private emit(kind: TokenKind, value: string, line: number, col: number): void {
    this.tokens.push({ kind, value, line, col });
  }
}
