import { describe, it, expect } from 'bun:test';
import { ExecutionContext, BuiltinSlot, NA } from '../src/runtime/context.js';
import { SeriesStore } from '../src/runtime/series.js';
import { MathNs } from '../src/runtime/builtins/math.js';
import { StrNs } from '../src/runtime/builtins/str.js';
import { ColorNs } from '../src/runtime/builtins/color.js';
import { InputNs } from '../src/runtime/builtins/input.js';

const NaN_ = NaN;

describe('arithmetic propagates na (NaN)', () => {
  const $ = new ExecutionContext();
  it('any na operand poisons +,-,*,/,%,neg', () => {
    expect($.add(NaN_, 1)).toBeNaN();
    expect($.sub(1, NaN_)).toBeNaN();
    expect($.mul(NaN_, 2)).toBeNaN();
    expect($.div(NaN_, 2)).toBeNaN();
    expect($.mod(NaN_, 2)).toBeNaN();
    expect($.neg(NaN_)).toBeNaN();
  });
  it('computes normally otherwise; division is float (v6)', () => {
    expect($.add(2, 3)).toBe(5);
    expect($.div(1, 2)).toBe(0.5);
    expect($.mod(5, 2)).toBe(1);
    expect($.neg(3)).toBe(-3);
  });
});

describe('comparisons with na yield false (v6 §4.5)', () => {
  const $ = new ExecutionContext();
  it('any na operand → false for < <= > >= == !=', () => {
    for (const op of ['lt', 'le', 'gt', 'ge', 'eq', 'ne'] as const) {
      expect($[op](NaN_, 1)).toBe(false);
      expect($[op](1, NaN_)).toBe(false);
    }
  });
  it('behaves normally for defined operands', () => {
    expect($.lt(1, 2)).toBe(true);
    expect($.le(2, 2)).toBe(true);
    expect($.gt(3, 2)).toBe(true);
    expect($.ge(2, 3)).toBe(false);
    expect($.eq(2, 2)).toBe(true);
    expect($.ne(2, 3)).toBe(true);
    expect($.not(false)).toBe(true);
  });
});

describe('na helpers and casts', () => {
  const $ = new ExecutionContext();
  it('na / nz', () => {
    expect($.na(NaN_)).toBe(true);
    expect($.na(NA)).toBe(true);
    expect($.na(5)).toBe(false);
    expect($.nz(NaN_)).toBe(0);
    expect($.nz(NaN_, 7)).toBe(7);
    expect($.nz(3)).toBe(3);
  });
  it('fixnan forward-fills the last non-na value', () => {
    expect($.fixnan(NaN_, 0)).toBeNaN(); // nothing seen yet
    expect($.fixnan(5, 0)).toBe(5);
    expect($.fixnan(NaN_, 0)).toBe(5); // forward-filled
  });
  it('toInt truncates toward zero; toBool/​toFloat', () => {
    expect($.toInt(2.9)).toBe(2);
    expect($.toInt(-2.9)).toBe(-2);
    expect($.toInt(NaN_)).toBeNaN();
    expect($.toFloat(3)).toBe(3);
    expect($.toBool(0)).toBe(false);
    expect($.toBool(1)).toBe(true);
    expect($.toBool(NaN_)).toBe(false);
  });
  it('concat coerces to string', () => {
    expect($.concat('a', 1)).toBe('a1');
  });
});

describe('builtin series leaves & barstate', () => {
  it('derives hl2/hlc3/ohlc4 from stored OHLC', () => {
    const $ = new ExecutionContext();
    $.set(BuiltinSlot.Open, 10);
    $.set(BuiltinSlot.High, 20);
    $.set(BuiltinSlot.Low, 10);
    $.set(BuiltinSlot.Close, 16);
    expect($.close).toBe(16);
    expect($.hl2).toBe(15);
    expect($.hlc3).toBeCloseTo((20 + 10 + 16) / 3, 9);
    expect($.ohlc4).toBeCloseTo((10 + 20 + 10 + 16) / 4, 9);
  });
});

describe('SeriesStore', () => {
  it('reverse-indexes (0=current) and returns NaN out of range', () => {
    const s = new SeriesStore();
    const slot = s.declareNumericSlot();
    s.set(slot, 10); s.commitBar();
    s.set(slot, 20); s.commitBar();
    s.set(slot, 30); // current (uncommitted)
    expect(s.get(slot, 0)).toBe(30);
    expect(s.get(slot, 1)).toBe(20);
    expect(s.get(slot, 2)).toBe(10);
    expect(s.get(slot, 3)).toBeNaN(); // before first bar
    expect(s.get(slot, -1)).toBeNaN(); // negative offset
  });
  it('grows capacity beyond the initial 1024 bars', () => {
    const s = new SeriesStore();
    const slot = s.declareNumericSlot();
    for (let i = 0; i < 3000; i++) { s.beginBar(); s.set(slot, i); s.commitBar(); }
    // after committing 3000 bars, the last written value is at offset 1
    // (offset 0 is the next, not-yet-written bar).
    expect(s.get(slot, 1)).toBe(2999);
    expect(s.get(slot, 3000)).toBe(0);
    expect(s.get(slot, 0)).toBeNaN();
  });
  it('truncateTo rolls back the bar counter', () => {
    const s = new SeriesStore();
    const slot = s.declareNumericSlot();
    s.set(slot, 1); s.commitBar();
    s.set(slot, 2); s.commitBar();
    expect(s.committedBars).toBe(2);
    s.truncateTo(1);
    expect(s.committedBars).toBe(1);
    s.set(slot, 99); // overwrite bar index 1
    expect(s.get(slot, 0)).toBe(99);
    expect(s.get(slot, 1)).toBe(1);
  });
  it('history slots are polymorphic: non-numeric values read back via getHist', () => {
    const s = new SeriesStore();
    const slot = s.declareNumericSlot();
    s.set(slot, { a: 1 }); s.commitBar(); // bar 0: an object
    s.set(slot, 42); s.commitBar();        // bar 1: a number (clears the overlay at this bar)
    s.set(slot, "txt");                    // bar 2 (in progress): a string
    expect(s.getHist(slot, 0)).toBe("txt");        // current bar → string
    expect(s.getHist(slot, 1)).toBe(42);           // 1 back → number (not the stale object)
    expect(s.getHist(slot, 2)).toEqual({ a: 1 });  // 2 back → object
    expect(Number.isNaN(s.getHist(slot, 9) as number)).toBe(true); // out of range → NaN
    // the numeric fast-path read (get) still returns NaN where an object lives
    expect(s.get(slot, 2)).toBeNaN();
  });
});

describe('var / varip persistence and rollback', () => {
  it('initVar runs once; setVar updates; rollback restores var but not varip', () => {
    const $ = new ExecutionContext();
    expect($.initVar(0, () => 5)).toBe(5);
    expect($.initVar(0, () => 999)).toBe(5); // init only once
    $.setVar(0, 9);
    $.initVarip(0, () => 1);
    const snap = $.snapshotMutable();
    $.setVar(0, 100);
    $.setVarip(0, 50);
    $.restoreMutable(snap);
    expect($.readVar<number>(0)).toBe(9); // var rolled back
    expect($.readVarip<number>(0)).toBe(50); // varip escapes rollback
  });
});

describe('math namespace', () => {
  it('propagates na and computes', () => {
    expect(MathNs.max(1, 5, 3)).toBe(5);
    expect(MathNs.min(1, 5, 3)).toBe(1);
    expect(MathNs.max(1, NaN)).toBeNaN();
    expect(MathNs.abs(-4)).toBe(4);
    expect(MathNs.round(3.14159, 2)).toBeCloseTo(3.14, 9);
    expect(MathNs.pow(2, 10)).toBe(1024);
    expect(MathNs.sqrt(9)).toBe(3);
    expect(MathNs.sign(-2)).toBe(-1);
    expect(MathNs.avg(2, 4, 6)).toBe(4);
    expect(MathNs.floor(2.9)).toBe(2);
    expect(MathNs.ceil(2.1)).toBe(3);
  });
});

describe('str namespace', () => {
  it('tostring / length / contains / format', () => {
    expect(StrNs.tostring(42)).toBe('42');
    expect(StrNs.tostring(NaN)).toBe('NaN');
    expect(StrNs.length('hello')).toBe(5);
    expect(StrNs.contains('hello', 'ell')).toBe(true);
    expect(StrNs.format('{0}+{1}={2}', 1, 2, 3)).toBe('1+2=3');
  });

  it('tostring with format.volume abbreviates K/M/B (TradingView volume axis)', () => {
    expect(StrNs.tostring(873.93622, 'volume')).toBe('874'); // < 1000 → rounded integer
    expect(StrNs.tostring(464.90737, 'volume')).toBe('465');
    expect(StrNs.tostring(3983.6725, 'volume')).toBe('3.984K'); // 3 trimmed decimals
    expect(StrNs.tostring(16218.77517, 'volume')).toBe('16.219K');
    expect(StrNs.tostring(8.41e6, 'volume')).toBe('8.41M');
    expect(StrNs.tostring(1234567, 'volume')).toBe('1.235M');
    expect(StrNs.tostring(1500, 'volume')).toBe('1.5K'); // trailing zeros trimmed
    expect(StrNs.tostring(NaN, 'volume')).toBe('NaN');
  });
});

describe('color namespace', () => {
  it('new applies transparency to alpha; rgb builds hex; constants exist', () => {
    expect(ColorNs.new('#FF0000FF', 0)).toBe('#FF0000FF'); // opaque
    expect(ColorNs.new('#FF0000FF', 100)).toBe('#FF000000'); // fully transparent
    expect(ColorNs.rgb(255, 0, 0)).toBe('#FF0000FF');
    expect(ColorNs.red).toMatch(/^#[0-9A-F]{8}$/);
  });
});

describe('input namespace returns defaults (headless)', () => {
  it('passes through the default value', () => {
    expect(InputNs.int(14)).toBe(14);
    expect(InputNs.float(2.5)).toBe(2.5);
    expect(InputNs.bool(true)).toBe(true);
    expect(InputNs.source(42)).toBe(42);
    expect(InputNs.string('x')).toBe('x');
  });
});
