import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

const bars: Bar[] = Array.from({ length: 8 }, (_, i) => ({
  time: i * 60000, open: 100 + i, high: 110 + i, low: 90 + i, close: 100 + i * 2, volume: 1000,
}));

async function runBoth(src: string) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'T', timeframe: '1' });
  await ip.run({ symbol: 'T', timeframe: '1' });
  return { js, ip };
}

describe('chart.point (two-level namespace) + field access', () => {
  it('chart.point.from_index builds a point and obj.field reads it', async () => {
    const { js, ip } = await runBoth('//@version=6\nindicator("x")\np = chart.point.from_index(bar_index, close)\nplot(p.price)\nplot(p.index)\n');
    const price = js.outputs.plots.get(0)!.data;
    const index = js.outputs.plots.get(1)!.data;
    for (let i = 0; i < bars.length; i++) {
      expect(price[i]).toBe(bars[i].close);
      expect(index[i]).toBe(i);
    }
    // backends agree
    expect(ip.outputs.plots.get(0)!.data).toEqual(price);
  });

  it('chart.point.now uses the current bar index/time', async () => {
    const { js } = await runBoth('//@version=6\nindicator("x")\npt = chart.point.now(close)\nplot(pt.time)\n');
    expect(js.outputs.plots.get(0)!.data[5]).toBe(bars[5].time);
  });
});

describe('polyline.new over an array of chart points', () => {
  it('records a polyline drawing with its points and options; backends agree', async () => {
    const src = `//@version=6
indicator("x")
pts = array.from(chart.point.from_index(bar_index, high), chart.point.from_index(bar_index, low))
var pl = polyline.new(pts, curved = true)
plot(close)
`;
    const { js, ip } = await runBoth(src);
    const pl = js.drawings.find((d) => d.type === 'polyline')!;
    expect(pl).toBeDefined();
    const pts = pl.props.points as Array<{ price: number }>;
    expect(pts.length).toBe(2);
    expect(pts[0].price).toBe(bars[0].high); // created on first bar (var)
    expect(pts[1].price).toBe(bars[0].low);
    expect(pl.props.curved).toBe(true);
    expect(JSON.stringify(js.drawings)).toBe(JSON.stringify(ip.drawings));
  });

  it('parses the idiomatic array.new<chart.point>() (dotted generic type arg)', async () => {
    const src = `//@version=6
indicator("x")
pts = array.new<chart.point>()
array.push(pts, chart.point.from_index(bar_index, high))
array.push(pts, chart.point.from_index(bar_index, low))
var pl = polyline.new(pts)
plot(close)
`;
    const { js, ip } = await runBoth(src);
    const pl = js.drawings.find((d) => d.type === 'polyline')!;
    expect(pl).toBeDefined();
    expect((pl.props.points as unknown[]).length).toBe(2);
    expect(JSON.stringify(js.drawings)).toBe(JSON.stringify(ip.drawings));
  });
});
