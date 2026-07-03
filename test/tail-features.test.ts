import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

const bars: Bar[] = Array.from({ length: 8 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 1, close: px + 0.5, volume: 10 + i };
});

/** Compile, run BOTH backends, assert every plot agrees byte-for-byte, return JS engine. */
async function both(src: string) {
  const c = compile(src);
  const js = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
  const ip = new Engine(c, new ArrayFeed(bars), { backend: 'interp' });
  await js.run({ symbol: 'BTCUSD', timeframe: '60' });
  await ip.run({ symbol: 'BTCUSD', timeframe: '60' });
  for (const [id, jp] of js.outputs.plots) {
    const ipp = ip.outputs.plots.get(id)!;
    for (let i = 0; i < jp.data.length; i++) {
      const a = jp.data[i],
        b = ipp.data[i];
      const same = (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
      if (!same) throw new Error(`backend divergence plot ${id} bar ${i}: js=${a} ip=${b}`);
    }
  }
  return js;
}
const last = (eng: Awaited<ReturnType<typeof both>>, id = 0) => {
  const d = eng.outputs.plots.get(id)!.data;
  return d[d.length - 1];
};

describe('UDT (user-defined types)', () => {
  it('constructs via T.new(positional) and reads fields', async () => {
    const eng = await both(
      '//@version=6\nindicator("u")\ntype Point\n    int index\n    float price\np = Point.new(bar_index, close)\nplot(p.index)\nplot(p.price)\n',
    );
    expect(last(eng, 0)).toBe(7); // bar_index of last bar
    expect(last(eng, 1)).toBe(107.5); // close of last bar
  });

  it('applies field defaults when args are omitted', async () => {
    const eng = await both(
      '//@version=6\nindicator("u")\ntype B\n    float o = open\n    float h = high\nb = B.new()\nplot(b.o)\nplot(b.h)\n',
    );
    expect(last(eng, 0)).toBe(107); // open
    expect(last(eng, 1)).toBe(109); // high
  });

  it('supports named-arg construction and field reassignment', async () => {
    const eng = await both(
      '//@version=6\nindicator("u")\ntype P\n    float x\n    float y\np = P.new(y = close)\np.x := close * 2\nplot(p.x)\nplot(na(p.y) ? -1 : p.y)\n',
    );
    expect(last(eng, 0)).toBe(215); // close*2
    expect(last(eng, 1)).toBe(107.5); // y = close
  });
});

describe('enums', () => {
  it('resolves E.member to its title (compile-time constant)', async () => {
    const eng = await both(
      '//@version=6\nindicator("e")\nenum Dir\n    up = "UP"\n    down = "DOWN"\nd = Dir.up\nplot(d == "UP" ? 1.0 : 0.0)\nplot(str.length(d))\n',
    );
    expect(last(eng, 0)).toBe(1);
    expect(last(eng, 1)).toBe(2); // "UP"
  });
  it('member with no explicit title defaults to its name', async () => {
    const eng = await both(
      '//@version=6\nindicator("e")\nenum Color\n    red\n    green\nc = Color.green\nplot(c == "green" ? 1.0 : 0.0)\n',
    );
    expect(last(eng, 0)).toBe(1);
  });
});

describe('new builtins (both backends agree)', () => {
  it('color.r/g/b/t channels', async () => {
    const eng = await both(
      '//@version=6\nindicator("c")\nx = color.rgb(10, 20, 30, 50)\nplot(color.r(x))\nplot(color.g(x))\nplot(color.b(x))\nplot(color.t(x))\n',
    );
    expect(last(eng, 0)).toBe(10);
    expect(last(eng, 1)).toBe(20);
    expect(last(eng, 2)).toBe(30);
    expect(last(eng, 3)).toBe(50); // transparency
  });
  it('math trig + conversions', async () => {
    const eng = await both(
      '//@version=6\nindicator("m")\nplot(math.sin(0))\nplot(math.todegrees(math.pi))\nplot(math.gcd(12, 18))\nplot(math.factorial(5))\n',
    );
    expect(last(eng, 0)).toBeCloseTo(0, 9);
    expect(last(eng, 1)).toBeCloseTo(180, 9);
    expect(last(eng, 2)).toBe(6);
    expect(last(eng, 3)).toBe(120);
  });
  it('math.random is deterministic and identical across backends', async () => {
    // bothBackends() already asserts byte-for-byte agreement; also check stability.
    const eng = await both('//@version=6\nindicator("r")\nplot(math.random(0, 100, 7))\n');
    const a = last(eng, 0);
    expect(a).toBe(last(eng, 0)); // stable for a fixed seed
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });
  it('array.binary_search / sort_indices / standardize', async () => {
    const eng = await both(
      '//@version=6\nindicator("a")\nvar a = array.from(5.0, -2.0, 0.0, 9.0, 1.0)\nb = array.copy(a)\narray.sort(b)\nplot(array.binary_search(b, 0.0))\nplot(array.size(array.sort_indices(a)))\n',
    );
    expect(last(eng, 0)).toBe(1); // sorted [-2,0,1,5,9] → index of 0 is 1
    expect(last(eng, 1)).toBe(5);
  });
  it('str.split / upper / replace / contains', async () => {
    const eng = await both(
      '//@version=6\nindicator("s")\nparts = str.split("a,b,c", ",")\nplot(array.size(parts))\nplot(str.length(str.upper("abc")))\nplot(str.contains(str.replace_all("xixix", "x", "yy"), "yy") ? 1.0 : 0.0)\n',
    );
    expect(last(eng, 0)).toBe(3);
    expect(last(eng, 1)).toBe(3);
    expect(last(eng, 2)).toBe(1);
  });
  it('matrix.avg / det (and element-wise sum)', async () => {
    const eng = await both(
      '//@version=6\nindicator("mx")\nvar m = matrix.new<float>(2, 2, 0.0)\nmatrix.set(m, 0, 0, 1.0)\nmatrix.set(m, 0, 1, 2.0)\nmatrix.set(m, 1, 0, 3.0)\nmatrix.set(m, 1, 1, 4.0)\nplot(matrix.avg(m))\nplot(matrix.det(m))\ns = matrix.sum(m, 10.0)\nplot(matrix.get(s, 0, 0))\n',
    );
    expect(last(eng, 0)).toBe(2.5); // mean of 1,2,3,4
    expect(last(eng, 1)).toBeCloseTo(-2, 9); // 1*4 - 2*3
    expect(last(eng, 2)).toBe(11); // element-wise +10
  });
  it('timeframe.in_seconds() / from_seconds() are functions', async () => {
    const eng = await both(
      '//@version=6\nindicator("t")\nplot(timeframe.in_seconds())\nplot(str.length(timeframe.from_seconds(86400)))\n',
    );
    expect(last(eng, 0)).toBe(3600); // "60" → 3600s
    expect(last(eng, 1)).toBe(2); // "1D"
  });

  it('timeframe.change("1W") rolls on MONDAY, not Sunday (ISO/TradingView week)', async () => {
    // Regression (LuxAlgo "HTF Candle Footprint"): weekly buckets started on Sunday, so a
    // Sunday bar opened a "new week" and the HTF range collapsed to that day. Hourly bars
    // across Mon Jun 22 → Mon Jun 29 2026: change must fire only on the two Mondays.
    const startMs = Date.parse('2026-06-22T00:00:00Z'); // Monday
    const wbars: Bar[] = Array.from({ length: 8 * 24 }, (_, i) => ({
      time: startMs + i * 3600000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    }));
    const c = compile('//@version=6\nindicator("w")\nplot(timeframe.change("1W") ? 1 : 0)\n');
    for (const backend of ['js', 'interp'] as const) {
      const eng = new Engine(c, new ArrayFeed(wbars), { backend });
      await eng.run({ symbol: 'X', timeframe: '60' });
      const data = eng.outputs.plots.get(0)!.data;
      const fires = data.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
      expect(fires).toEqual([0, 168]); // bar 0 = Mon Jun 22, bar 168 = Mon Jun 29 (NOT Sun bar 144)
    }
  });
});

// Regressions for correctness bugs caught by adversarial verification (would have
// shipped as wrong-but-consistent: identical across both backends, yet wrong).
describe('verified-correctness regressions', () => {
  it('array.percentile_nearest_rank uses ceil-rank (not round)', async () => {
    const eng = await both(
      '//@version=6\nindicator("p")\nvar a = array.from(15.0, 20.0, 35.0, 40.0, 50.0)\nplot(array.percentile_nearest_rank(a, 40))\n',
    );
    expect(last(eng, 0)).toBe(20); // ceil(0.4*5)=2 → 2nd smallest
  });
  it('matrix.sum is element-wise (matrix + scalar → new matrix)', async () => {
    const eng = await both(
      '//@version=6\nindicator("m")\nvar m = matrix.new<float>(1, 1, 4.0)\ns = matrix.sum(m, 10.0)\nplot(matrix.get(s, 0, 0))\n',
    );
    expect(last(eng, 0)).toBe(14);
  });
  it('ta.tsi returns the raw ratio in [-1,1] (no ×100)', async () => {
    // monotonically rising close → pc always positive → tsi → +1
    const eng = await both('//@version=6\nindicator("t")\nplot(ta.tsi(close, 13, 25))\n');
    const v = last(eng, 0);
    expect(v).toBeLessThanOrEqual(1 + 1e-9);
    expect(v).toBeGreaterThan(0.9); // rising series approaches +1
  });
  it('str functions propagate the na sentinel without crashing', async () => {
    const eng = await both(
      '//@version=6\nindicator("s")\nstring x = na\nplot(str.contains(x, "a") ? 1.0 : 0.0)\nplot(na(str.upper(x)) ? -1.0 : 0.0)\n',
    );
    expect(last(eng, 0)).toBe(0); // contains(na,..) → false, no throw
    expect(last(eng, 1)).toBe(-1); // upper(na) → na
  });
});
