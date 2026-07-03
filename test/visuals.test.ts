import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// close = 100 + 2i, open = 100 + i  →  close > open for i > 0 (equal at i=0)
const bars: Bar[] = Array.from({ length: 10 }, (_, i) => ({
  time: i * 60000,
  open: 100 + i,
  high: 120 + i,
  low: 80 + i,
  close: 100 + i * 2,
  volume: 1000,
}));
const HEX = /^#[0-9A-F]{8}$/;

function serializeVisuals(out: Engine['outputs']) {
  const m = (map: Map<number, unknown>) => [...map.entries()].map(([k, v]) => [k, v]);
  return JSON.stringify({
    plots: m(out.plots),
    markers: m(out.markers),
    candles: m(out.candles),
    hlines: m(out.hlines),
    fills: m(out.fills),
    barColors: [...out.barColors.entries()],
    bgColors: [...out.bgColors.entries()],
  });
}

async function bothBackends(src: string) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  // The whole visual IR must be byte-identical across backends.
  expect(serializeVisuals(ip.outputs)).toBe(serializeVisuals(js.outputs));
  return js;
}

describe('per-bar plot color', () => {
  it('plot(color=cond?green:red) fills a per-bar colors array', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplot(close, color = close > open ? color.green : color.red)\n',
    );
    const p = eng.outputs.plots.get(0)!;
    expect(p.colors[0]).toMatch(HEX);
    expect(p.colors[5]).toMatch(HEX);
    expect(p.colors[0]).not.toBe(p.colors[5]); // red at bar 0, green at bar 5
    expect(p.data[5]).toBe(bars[5].close);
  });
});

describe('bgcolor / barcolor (per-bar coloring layers)', () => {
  it('bgcolor sets a background layer; na → null (no fill)', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nbgcolor(close > open ? color.new(color.green, 80) : na)\nplot(close)\n',
    );
    const layer = [...eng.outputs.bgColors.values()][0];
    expect(layer[0]).toBeNull(); // bar 0: close==open → na → null
    expect(layer[5]).toMatch(HEX);
  });
  it('barcolor colors the price bars per bar', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nbarcolor(close > open ? color.lime : color.red)\nplot(close)\n',
    );
    const layer = [...eng.outputs.barColors.values()][0];
    expect(layer[5]).toMatch(HEX);
  });
});

describe('markers: plotshape / plotchar / plotarrow', () => {
  it('plotshape records a marker with location, color and text where the condition holds', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplotshape(close > open, title="up", location=location.belowbar, color=color.lime, text="B", style=shape.triangleup)\nplot(close)\n',
    );
    const mk = [...eng.outputs.markers.values()][0];
    expect(mk.kind).toBe('shape');
    expect(mk.location).toBe('belowbar');
    expect(mk.glyph).toBe('triangleup');
    expect(mk.data[0]).toBeNull(); // bar 0: condition false
    expect(mk.data[5]).not.toBeNull();
    expect(mk.data[5]!.text).toBe('B');
    expect(mk.data[5]!.color).toMatch(HEX);
  });
  it('plotshape binds POSITIONAL args (series, title, style, location, color, offset, text)', async () => {
    // The common LuxAlgo/SMC call style — all positional. Regression: title/style/location/
    // color/text were dropped (everything defaulted to abovebar / circle / no text).
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplotshape(close > open, "Up", shape.triangleup, location.belowbar, color.lime, 0, "B")\nplot(close)\n',
    );
    const mk = [...eng.outputs.markers.values()][0];
    expect(mk.title).toBe('Up');
    expect(mk.glyph).toBe('triangleup');
    expect(mk.location).toBe('belowbar');
    expect(mk.data[5]).not.toBeNull();
    expect(mk.data[5]!.text).toBe('B');
    expect(mk.data[5]!.color).toMatch(HEX);
  });
  it('plotchar binds POSITIONAL char at index 2 (plotchar(series, title, char, location, …))', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplotchar(close > open, "C", "✓", location.abovebar, color.red)\nplot(close)\n',
    );
    const mk = [...eng.outputs.markers.values()][0];
    expect(mk.kind).toBe('char');
    expect(mk.glyph).toBe('✓');
    expect(mk.location).toBe('abovebar');
  });
  it('plotchar / plotarrow set the right marker kind', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplotchar(close > open, char="X")\nplotarrow(close - open)\nplot(close)\n',
    );
    const kinds = [...eng.outputs.markers.values()].map((mk) => mk.kind).sort();
    expect(kinds).toEqual(['arrow', 'char']);
  });
});

describe('plotcandle', () => {
  it('records per-bar OHLC + color', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nplotcandle(open, high, low, close, color = close > open ? color.green : color.red)\n',
    );
    const cs = [...eng.outputs.candles.values()][0];
    expect(cs.data[5]).toEqual({
      open: bars[5].open,
      high: bars[5].high,
      low: bars[5].low,
      close: bars[5].close,
    });
    expect(cs.colors[5]).toMatch(HEX);
  });
});

describe('fill surface (plot-fill / hline-fill / gradient / linefill)', () => {
  it('fill(plot1, plot2, color) records the two plot ids and the color', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nup = plot(high, title="up")\ndn = plot(low, title="dn")\nfill(up, dn, color = color.new(color.blue, 80))\n',
    );
    const f = [...eng.outputs.fills.values()][0];
    expect(f.plot1).toBe(0); // first plot's id
    expect(f.plot2).toBe(1);
    expect(f.color ?? f.colors[5]).toMatch(HEX);
  });

  it('fill between two hlines references hline ids', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nh1 = hline(70.0)\nh2 = hline(30.0)\nfill(h1, h2, color = color.new(color.blue, 90))\nplot(close)\n',
    );
    const f = [...eng.outputs.fills.values()][0];
    expect(eng.outputs.hlines.has(f.plot1)).toBe(true);
    expect(eng.outputs.hlines.has(f.plot2)).toBe(true);
  });

  it('gradient fill records per-bar top/bottom value + colors', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nu = plot(high)\nd = plot(low)\nfill(u, d, top_value = high, bottom_value = low, top_color = color.green, bottom_color = color.red)\n',
    );
    const f = [...eng.outputs.fills.values()][0];
    expect(f.gradient).toBeDefined();
    expect(f.gradient!.topValue[5]).toBe(bars[5].high);
    expect(f.gradient!.bottomValue[5]).toBe(bars[5].low);
    expect(f.gradient!.topColor[5]).toMatch(HEX);
    expect(f.gradient!.bottomColor[5]).toMatch(HEX);
  });

  it('POSITIONAL gradient fill is detected (top_value/.../top_color args unnamed)', async () => {
    // Regression: the gradient overload was only recognised when its args were named, so a
    // positional fill(p1, p2, topVal, botVal, topCol, botCol) silently fell back to the flat
    // color form with an undefined color (the LuxAlgo "Volatility Trail" cloud bug).
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nu = plot(high)\nd = plot(low)\nfill(u, d, high, low, color.green, color.red)\n',
    );
    const f = [...eng.outputs.fills.values()][0];
    expect(f.gradient).toBeDefined();
    expect(f.gradient!.topValue[5]).toBe(bars[5].high);
    expect(f.gradient!.bottomValue[5]).toBe(bars[5].low);
    expect(f.gradient!.topColor[5]).toMatch(HEX);
    expect(f.gradient!.bottomColor[5]).toMatch(HEX);
  });

  it('POSITIONAL color fill keeps its color (3rd positional arg, not just named color=)', async () => {
    const eng = await bothBackends(
      '//@version=6\nindicator("x")\nu = plot(high)\nd = plot(low)\nfill(u, d, color.new(color.blue, 80))\n',
    );
    const f = [...eng.outputs.fills.values()][0];
    expect(f.gradient).toBeUndefined();
    expect(f.color ?? f.colors[5]).toMatch(HEX);
  });

  it('linefill.new fills between two lines (namespace + method-call forms)', async () => {
    const src = `//@version=6
indicator("x")
var l1 = line.new(bar_index, high, bar_index, high)
var l2 = line.new(bar_index, low, bar_index, low)
var lf = linefill.new(l1, l2, color.new(color.blue, 80))
linefill.set_color(lf, color.new(color.red, 50))
plot(close)
`;
    const js = new Engine(compile(src), new ArrayFeed(bars), { backend: 'js' });
    const ip = new Engine(compile(src), new ArrayFeed(bars), { backend: 'interp' });
    await js.run({ symbol: 'T', timeframe: '1' });
    await ip.run({ symbol: 'T', timeframe: '1' });
    expect(JSON.stringify(js.drawings)).toBe(JSON.stringify(ip.drawings));
    const lf = js.drawings.find((d) => d.type === 'linefill')!;
    expect(lf.props.line1).toBe(1); // first line's pool id
    expect(lf.props.line2).toBe(2);
    expect(lf.props.color).toMatch(HEX); // set_color applied
  });
});
