import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 110,
  low: 90,
  close: 100 + i,
  volume: 1000,
}));

describe('input metadata extraction', () => {
  it('captures kind / title / default / min / max / options for each input.*', () => {
    const c = compile(`//@version=6
indicator("x")
len = input.int(14, "Length", minval = 1, maxval = 200)
mult = input.float(2.0, "Mult", step = 0.5)
useEma = input.bool(true, "Use EMA")
mode = input.string("fast", "Mode", options = ["fast", "slow"])
src = input.source(close, "Source")
plot(ta.sma(src, len) * mult)
`);
    const byTitle = Object.fromEntries(c.metadata.inputs.map((d) => [d.title, d]));
    expect(byTitle['Length']).toMatchObject({ kind: 'int', default: 14, minval: 1, maxval: 200 });
    expect(byTitle['Mult']).toMatchObject({ kind: 'float', default: 2, step: 0.5 });
    expect(byTitle['Use EMA']).toMatchObject({ kind: 'bool', default: true });
    expect(byTitle['Mode']).toMatchObject({
      kind: 'string',
      default: 'fast',
      options: ['fast', 'slow'],
    });
    expect(byTitle['Source']).toMatchObject({ kind: 'source' });
    expect(c.metadata.inputs.length).toBe(5);
  });

  it('captures POSITIONAL options (input.timeframe("1W", "TF", ["60","1D","1W"]))', () => {
    // Regression (LuxAlgo "HTF Candle Footprint"): options passed positionally — not as
    // `options = [...]` — were dropped, leaving the settings panel with no dropdown list.
    const c = compile(`//@version=6
indicator("x")
tf  = input.timeframe("1W", "TF", ["60", "240", "1D", "1W", "1M"])
sym = input.symbol("AAPL", "Sym")
n   = input.int(5, "N", 1, 100, 1, [5, 10, 20])
plot(close)
`);
    const byTitle = Object.fromEntries(c.metadata.inputs.map((d) => [d.title, d]));
    expect(byTitle['TF']).toMatchObject({
      kind: 'timeframe',
      default: '1W',
      options: ['60', '240', '1D', '1W', '1M'],
    });
    expect(byTitle['Sym']).toMatchObject({ kind: 'symbol', default: 'AAPL' });
    expect(byTitle['N']).toMatchObject({
      kind: 'int',
      default: 5,
      minval: 1,
      maxval: 100,
      options: [5, 10, 20],
    });
  });

  it('resolves input.color defaults — literal, color.new(...), color.rgb(...), color.<const>', () => {
    const c = compile(`//@version=6
indicator("x")
c1 = input.color(#2962FF, "Lit")
c2 = input.color(color.new(#2962FF, 85), "New")
c3 = input.color(color.rgb(255, 152, 0), "Rgb")
c4 = input.color(color.red, "Const")
plot(close, color = c1 == c2 or c3 == c4 ? color.white : color.black)
`);
    const byTitle = Object.fromEntries(c.metadata.inputs.map((d) => [d.title, d]));
    // Was the bug: only the literal resolved; color.new/rgb/const all came back null, so
    // fractal's settings panel showed #000000 and fed an empty override back to piner.
    expect(byTitle['Lit'].default).toBe('#2962FFFF');
    expect(byTitle['New'].default).toBe('#2962FF26'); // 85% transparency → alpha 0x26
    expect(byTitle['Rgb'].default).toBe('#FF9800FF');
    expect(byTitle['Const'].default).toBe('#F23645FF'); // color.red
  });

  it('resolves named-constant defaults, options, group & tooltip (not just inline literals)', () => {
    // Was the bug: inputs whose default/options referenced a named constant (the LuxAlgo SMC
    // idiom `input.string(HISTORICAL, options = [HISTORICAL, PRESENT])`, `input(GREEN, …)`)
    // came back default: null / options: [], so the settings panel showed empty dropdowns and
    // #000000 swatches. Defaults, options, group and tooltip must chase const references —
    // including `size.*` / `text.*` namespace tags.
    const c = compile(`//@version=6
indicator("x")
HISTORICAL = 'Historical'
PRESENT    = 'Present'
GREEN      = #089981
TINY       = size.tiny
SMALL      = size.small
GRP        = 'My Group'
TIP        = 'My Tooltip'
mode  = input.string(HISTORICAL, 'Mode', options = [HISTORICAL, PRESENT], group = GRP, tooltip = TIP)
col   = input(GREEN, 'Color')
pcol  = input.color(GREEN, 'PColor')
sz    = input.string(TINY, 'Size', options = [TINY, SMALL])
plot(close, color = col == pcol ? color.white : color.black)
`);
    const byTitle = Object.fromEntries(c.metadata.inputs.map((d) => [d.title, d]));
    expect(byTitle['Mode']).toMatchObject({
      default: 'Historical',
      options: ['Historical', 'Present'],
      group: 'My Group',
      tooltip: 'My Tooltip',
    });
    expect(byTitle['Color'].default).toBe('#089981FF');
    expect(byTitle['PColor'].default).toBe('#089981FF');
    expect(byTitle['Size']).toMatchObject({ default: 'tiny', options: ['tiny', 'small'] });
  });

  it('gives duplicate input titles UNIQUE override keys, resolved independently', async () => {
    // Was the bug: three `input.color(.., "Session color")` across groups all keyed to
    // "Session color", so fractal could only set one value → every session the same color.
    const src = `//@version=6
indicator("x")
a = input.int(1, "N")
b = input.int(2, "N")
c = input.int(3, "N")
plot(a, "a")
plot(b, "b")
plot(c, "c")
`;
    const compiled = compile(src);
    expect(compiled.metadata.inputs.map((d) => d.key)).toEqual(['N', 'N (2)', 'N (3)']);
    expect(compiled.metadata.inputs.every((d) => d.title === 'N')).toBe(true); // display label unchanged
    for (const backend of ['js', 'interp'] as const) {
      const eng = new Engine(compiled, new ArrayFeed(bars), {
        backend,
        inputs: { N: 10, 'N (2)': 20, 'N (3)': 30 },
      });
      await eng.run({ symbol: 'T', timeframe: '1' });
      expect(eng.outputs.plots.get(0)!.data[5]).toBe(10);
      expect(eng.outputs.plots.get(1)!.data[5]).toBe(20);
      expect(eng.outputs.plots.get(2)!.data[5]).toBe(30); // each "N" resolved independently
    }
  });

  it('inputs without a title get a stable auto key', () => {
    const c = compile('//@version=6\nindicator("x")\nplot(ta.sma(close, input.int(10)))\n');
    expect(c.metadata.inputs[0].key).toMatch(/^input_\d+$/);
    expect(c.metadata.inputs[0].default).toBe(10);
  });
});

describe('declaration metadata — drawing caps', () => {
  it('extracts max_*_count from indicator() (defaults: lines/labels/boxes 50, polylines 100)', () => {
    const def = compile('//@version=6\nindicator("d")\nplot(close)\n').metadata;
    expect([
      def.maxLinesCount,
      def.maxLabelsCount,
      def.maxBoxesCount,
      def.maxPolylinesCount,
    ]).toEqual([50, 50, 50, 100]);
    const set = compile(
      '//@version=6\nindicator("d", max_boxes_count = 500, max_lines_count = 300, max_labels_count = 200, max_polylines_count = 250)\nplot(close)\n',
    ).metadata;
    expect([
      set.maxLinesCount,
      set.maxLabelsCount,
      set.maxBoxesCount,
      set.maxPolylinesCount,
    ]).toEqual([300, 200, 500, 250]);
  });
});

describe('input override by title', () => {
  it('overrides the default value (both backends agree)', async () => {
    const src = `//@version=6
indicator("x")
len = input.int(14, "Length")
plot(ta.sma(close, len))
`;
    const c = compile(src);
    for (const backend of ['js', 'interp'] as const) {
      // default: len=14 → na at bar 5 (only 6 samples)
      const def = new Engine(c, new ArrayFeed(bars), { backend });
      await def.run({ symbol: 'T', timeframe: '1' });
      expect(def.outputs.plots.get(0)!.data[5]).toBeNaN();

      // override len=3 → defined at bar 5
      const ov = new Engine(c, new ArrayFeed(bars), { backend, inputs: { Length: 3 } });
      await ov.run({ symbol: 'T', timeframe: '1' });
      expect(Number.isNaN(ov.outputs.plots.get(0)!.data[5])).toBe(false);
    }
  });

  it('a bool override of false is honored (not treated as "unset")', async () => {
    const c = compile(
      '//@version=6\nindicator("x")\non = input.bool(true, "On")\nplot(on ? 1.0 : 0.0)\n',
    );
    const ov = new Engine(c, new ArrayFeed(bars), { inputs: { On: false } });
    await ov.run({ symbol: 'T', timeframe: '1' });
    expect(ov.outputs.plots.get(0)!.data[5]).toBe(0);
  });

  it('input.source override resolves a source-NAME string to that series (both backends)', async () => {
    // bars[5]: open=105 high=110 low=90 close=105 → hl2=100
    const c = compile(
      '//@version=6\nindicator("x")\nsrc = input.source(close, "Source")\nplot(src)\n',
    );
    for (const backend of ['js', 'interp'] as const) {
      const def = new Engine(c, new ArrayFeed(bars), { backend });
      await def.run({ symbol: 'T', timeframe: '1' });
      expect(def.outputs.plots.get(0)!.data[5]).toBe(bars[5].close); // default: close=105

      const hi = new Engine(c, new ArrayFeed(bars), { backend, inputs: { Source: 'high' } });
      await hi.run({ symbol: 'T', timeframe: '1' });
      expect(hi.outputs.plots.get(0)!.data[5]).toBe(110); // picked the high series, not close

      const hl2 = new Engine(c, new ArrayFeed(bars), { backend, inputs: { Source: 'hl2' } });
      await hl2.run({ symbol: 'T', timeframe: '1' });
      expect(hl2.outputs.plots.get(0)!.data[5]).toBe(100); // computed source (high+low)/2
    }
  });
});
