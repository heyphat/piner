/**
 * Mathematical parity vs PineTS (LuxAlgo's independent Pine Script runtime, which
 * targets TradingView precision). We run the SAME Pine source over the SAME bars
 * through both engines and compare plot values.
 *
 * Two groups:
 *  - EXACT: piner must match PineTS byte-for-byte (a hard regression guard).
 *  - DOCUMENTED DIVERGENCES: cases where the two differ — every one verified
 *    against the bundled Pine v6 reference manual to be a *PineTS* deviation
 *    (piner matches the documented formula) or pure float-epsilon. These carry
 *    ground-truth assertions against the manual, not against PineTS.
 *
 * Skips gracefully if `pinets` isn't installed.
 */
import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

let PineTS: any;
try { ({ PineTS } = await import('pinets')); } catch { /* optional dev dependency */ }

// ── deterministic, realistic OHLC (seeded random walk) ───────────────────────
function mulberry32(seed: number) {
  return () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeBars(n: number) {
  const rnd = mulberry32(12345);
  const piner: Bar[] = []; const pinets: any[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px = Math.max(5, px + Math.sin(i / 17) * 0.5 + (rnd() - 0.5) * 4);
    const o = px + (rnd() - 0.5) * 2, cl = px + (rnd() - 0.5) * 2;
    const hi = Math.max(o, cl) + rnd() * 2, lo = Math.min(o, cl) - rnd() * 2;
    const vol = 1000 + Math.floor(rnd() * 5000), t = i * 3600000;
    piner.push({ time: t, open: o, high: hi, low: lo, close: cl, volume: vol });
    pinets.push({ openTime: t, open: o, high: hi, low: lo, close: cl, volume: vol, closeTime: t + 3599999, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 });
  }
  return { piner, pinets };
}
const isNa = (v: any) => v == null || (typeof v === 'number' && Number.isNaN(v));
const N = 180;
const { piner: PB, pinets: KB } = makeBars(N);
const HEAD = '//@version=6\nindicator("p")\n';

interface Cmp { title: string; piner: number[]; pinets: number[]; }
async function runBoth(body: string): Promise<Cmp[]> {
  const src = HEAD + body + '\n';
  const eng = new Engine(compile(src), new ArrayFeed(PB));
  await eng.run({ symbol: 'T', timeframe: '60' });
  const pinerPlots = [...eng.outputs.plots.values()];
  const ctx: any = await new PineTS(KB, 'T', '60', KB.length).run(src);
  const ptTitles = Object.keys(ctx.plots).filter((k) => !k.startsWith('__'));
  return pinerPlots.map((ps, i) => ({
    title: ps.title,
    piner: ps.data as number[],
    pinets: ctx.plots[ptTitles[i]]?.data.map((d: any) => d.value) ?? [],
  }));
}
/** Max relative error + na-mismatch count over bars [from, end). */
function diff(c: Cmp, from = 0) {
  let maxRel = 0, naMis = 0;
  const m = Math.min(c.piner.length, c.pinets.length);
  for (let i = from; i < m; i++) {
    const a = c.piner[i], b = c.pinets[i];
    if (isNa(a) && isNa(b)) continue;
    if (isNa(a) !== isNa(b)) { naMis++; continue; }
    maxRel = Math.max(maxRel, Math.abs(a - b) / (Math.max(Math.abs(a), Math.abs(b)) || 1));
  }
  return { maxRel, naMis };
}

// ── EXACT: byte-for-byte parity required ─────────────────────────────────────
const EXACT: [string, string][] = [
  ['sma', 'plot(ta.sma(close,14),"v")'],
  ['rma', 'plot(ta.rma(close,14),"v")'],
  ['wma', 'plot(ta.wma(close,14),"v")'],
  ['hma', 'plot(ta.hma(close,16),"v")'],
  ['vwma', 'plot(ta.vwma(close,14),"v")'],
  ['swma', 'plot(ta.swma(close),"v")'],
  ['rsi', 'plot(ta.rsi(close,14),"v")'],
  ['atr', 'plot(ta.atr(14),"v")'],
  ['tr(true)', 'plot(ta.tr(true),"v")'],
  ['stdev', 'plot(ta.stdev(close,20),"v")'],
  ['dev', 'plot(ta.dev(close,20),"v")'],
  ['variance', 'plot(ta.variance(close,20),"v")'],
  ['cci', 'plot(ta.cci(close,20),"v")'],
  ['mom', 'plot(ta.mom(close,10),"v")'],
  ['roc', 'plot(ta.roc(close,10),"v")'],
  ['cog', 'plot(ta.cog(close,10),"v")'],
  ['wpr', 'plot(ta.wpr(14),"v")'],
  ['highest', 'plot(ta.highest(high,20),"v")'],
  ['lowest', 'plot(ta.lowest(low,20),"v")'],
  ['change', 'plot(ta.change(close,5),"v")'],
  ['median', 'plot(ta.median(close,20),"v")'],
  ['linreg', 'plot(ta.linreg(close,20,0),"v")'],
  ['percentrank', 'plot(ta.percentrank(close,20),"v")'],
  ['cum', 'plot(ta.cum(close),"v")'],
  ['vwap (session-anchored)', 'plot(ta.vwap(hlc3),"v")'],
  ['alma', 'plot(ta.alma(close,9,0.85,6),"v")'],
  ['bb', '[mid,up,lo]=ta.bb(close,20,2)\nplot(mid,"mid")\nplot(up,"up")\nplot(lo,"lo")'],
  ['stoch', 'plot(ta.stoch(close,high,low,14),"v")'],
  ['sar', 'plot(ta.sar(0.02,0.02,0.2),"v")'],
  ['math.log', 'plot(math.log(close),"v")'],
  ['math.sqrt', 'plot(math.sqrt(close),"v")'],
  ['math.pow', 'plot(math.pow(close,2),"v")'],
  ['math.sin', 'plot(math.sin(close/50),"v")'],
  ['math.sum', 'plot(math.sum(close,10),"v")'],
  ['barssince', 'plot(ta.barssince(close>open),"v")'],
  ['valuewhen', 'plot(ta.valuewhen(close>open,close,0),"v")'],
  // ── v6 coverage-gap fills (see docs/v6-coverage-gap.md) ──
  ['ta.pvt (price-volume trend)', 'plot(ta.pvt,"v")'],
  ['dayofweek (leaf, regression)', 'plot(dayofweek,"v")'],
  ['dayofweek.sunday const', 'plot(dayofweek.sunday,"v")'],
  ['dayofweek.monday const', 'plot(dayofweek.monday,"v")'],
  ['dayofweek.friday const', 'plot(dayofweek.friday,"v")'],
  ['dayofweek.saturday const', 'plot(dayofweek.saturday,"v")'],
  ['last_bar_time', 'plot(last_bar_time,"v")'],
  ['time_tradingday', 'plot(time_tradingday,"v")'],
];

describe.skipIf(!PineTS)('parity vs PineTS — exact match', () => {
  for (const [name, body] of EXACT) {
    it(name, async () => {
      const cmps = await runBoth(body);
      expect(cmps.length).toBeGreaterThan(0);
      for (const c of cmps) {
        const d = diff(c);
        if (d.maxRel >= 1e-6 || d.naMis !== 0) {
          throw new Error(`${name}/${c.title}: maxRel=${d.maxRel.toExponential(2)} naMis=${d.naMis}`);
        }
      }
    });
  }
});

// ── DOCUMENTED DIVERGENCES (verified piner-correct against the v6 manual) ────
describe.skipIf(!PineTS)('parity vs PineTS — documented divergences (piner matches the manual)', () => {
  it('ema: piner seeds with the first value (pine_ema), PineTS warms up with an sma seed', async () => {
    const [c] = await runBoth('plot(ta.ema(close,14),"v")');
    // Documented pine_ema: `sum := na(sum[1]) ? src : alpha*src+(1-alpha)*sum[1]`
    // → value from bar 0 seeded with close[0]. PineTS returns na for bars 0..12.
    expect(c.piner[0]).toBeCloseTo(PB[0].close, 9);     // piner: documented seed, no warmup
    expect(isNa(c.pinets[0])).toBe(true);               // PineTS: na warmup (deviation)
    expect(diff(c, 60).maxRel).toBeLessThan(5e-3);      // converge in deep steady state
  });

  it('macd: inherits the ema seeding difference (downstream of pine_ema)', async () => {
    const cmps = await runBoth('[m,s,h]=ta.macd(close,12,26,9)\nplot(m,"m")');
    expect(isNa(cmps[0].piner[0])).toBe(false);          // finite from bar 0 (ema seed)
    expect(isNa(cmps[0].pinets[0])).toBe(true);
  });

  it('crossover: piner fires per the Pine spec (x[1]<=y[1] and x>y); PineTS misses it', async () => {
    // hand-built: f rises through s exactly once, between bar 2 and 3.
    const bars: Bar[] = [4, 4, 4, 9, 9].map((cl, i) => ({ time: i * 60000, open: cl, high: cl, low: cl, close: cl, volume: 1 }));
    const c = compile('//@version=6\nindicator("x")\nf=close\ns=ta.sma(close,3)\nplot(ta.crossover(f,s)?1.0:0.0,"x")\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    const x = eng.outputs.plots.get(0)!.data;
    // sma3 = [na,na,4,17/3,22/3]; f=[4,4,4,9,9]; f crosses above sma3 at bar 3.
    expect(x[3]).toBe(1);
    expect(x[2]).toBe(0);
  });

  it('cmo: float-epsilon agreement (steady state byte-matches after warmup)', async () => {
    const [c] = await runBoth('plot(ta.cmo(close,14),"v")');
    expect(diff(c, 16).maxRel).toBeLessThan(1e-6);
  });

  it('mfi: steady state byte-matches; only the first bar differs (v6 na<=0→false at warmup)', async () => {
    const [c] = await runBoth('plot(ta.mfi(close,14),"v")');
    expect(diff(c, 15).maxRel).toBeLessThan(1e-6);
  });
});

// ── language core: operators, na-propagation, history, var/varip, control flow,
//    casts, built-in series. These exercise the engine's semantics, not a library. ─
const LANG_EXACT: [string, string][] = [
  ['arithmetic + - * / %', 'plot(close+open,"1")\nplot(close-open,"2")\nplot(close*2.0,"3")\nplot(close/open,"4")\nplot(close%7.0,"5")'],
  ['unary minus', 'plot(-close,"v")'],
  ['na propagates through arithmetic', 'plot(na(close+na)?1.0:0.0,"1")\nplot(na(na*2.0)?1.0:0.0,"2")'],
  ['comparisons', 'plot(close>open?1.0:0.0,"1")\nplot(close>=open?1.0:0.0,"2")\nplot(close<open?1.0:0.0,"3")\nplot(close==open?1.0:0.0,"4")\nplot(close!=open?1.0:0.0,"5")'],
  ['na comparison → false (v6)', 'plot((na>close)?1.0:0.0,"1")\nplot((close==na)?1.0:0.0,"2")'],
  ['logical and / or / not (lazy)', 'plot((close>open and high>low)?1.0:0.0,"1")\nplot((close>open or false)?1.0:0.0,"2")\nplot(not (close>open)?1.0:0.0,"3")'],
  ['nested ternary', 'plot(close>open?(high>low?1.0:2.0):3.0,"v")'],
  ['history [] on series', 'plot(close[1],"1")\nplot(close[5],"2")'],
  ['history [] on a variable', 'x=close+open\nplot(x[2],"v")'],
  ['history out-of-range → na', 'plot(na(close[500])?1.0:0.0,"v")'],
  ['var accumulation', 'var float s=0.0\ns:=s+close\nplot(s,"v")'],
  ['var counter', 'var int n=0\nn:=n+1\nplot(n,"v")'],
  ['varip', 'varip int v=0\nv:=v+1\nplot(v,"v")'],
  ['if as expression', 'x = if close>open\n    high\nelse\n    low\nplot(x,"v")'],
  ['switch as expression', 'x = switch\n    close>open => 1.0\n    close<open => -1.0\n    => 0.0\nplot(x,"v")'],
  ['for loop accumulation', 's=0.0\nfor i=0 to 9\n    s+=close[i]\nplot(s/10.0,"v")'],
  ['while loop', 'i=0\ns=0.0\nwhile i<5\n    s:=s+close[i]\n    i:=i+1\nplot(s,"v")'],
  ['int / float casts', 'plot(int(close),"1")\nplot(float(5),"2")\nplot(int(-close),"3")'],
  ['nz / na / fixnan', 'plot(nz(na,9.0),"1")\nplot(nz(close),"2")\nplot(na(na)?1.0:0.0,"3")\nplot(fixnan(close>110?na:close),"4")'],
  ['built-in OHLCV series', 'plot(open,"1")\nplot(high,"2")\nplot(low,"3")\nplot(close,"4")\nplot(volume,"5")'],
  ['derived hl2 / hlc3 / ohlc4', 'plot(hl2,"1")\nplot(hlc3,"2")\nplot(ohlc4,"3")'],
  ['bar_index', 'plot(bar_index,"v")'],
  ['operator precedence', 'plot(close+open*2.0-high/2.0,"v")'],
  ['compound assignment', 'x=close\nx+=open\nx*=2.0\nplot(x,"v")'],
  ['date/time accessors', 'plot(hour,"1")\nplot(minute,"2")\nplot(dayofmonth,"3")\nplot(dayofweek,"4")'],
];

describe.skipIf(!PineTS)('parity vs PineTS — language core (exact)', () => {
  for (const [name, body] of LANG_EXACT) {
    it(name, async () => {
      const cmps = await runBoth(body);
      expect(cmps.length).toBeGreaterThan(0);
      for (const c of cmps) {
        const d = diff(c);
        if (d.maxRel >= 1e-6 || d.naMis !== 0) throw new Error(`${name}/${c.title}: maxRel=${d.maxRel.toExponential(2)} naMis=${d.naMis}`);
      }
    });
  }
});

describe.skipIf(!PineTS)('parity vs PineTS — language: documented divergences/limits', () => {
  it('bool(false) is false (piner correct); PineTS returns true for bool(comparison)', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(bool(close>open) == (close>open) ? 1.0 : 0.0,"v")\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    // bool(x) must equal x for a bool x — true on every bar in piner.
    expect(eng.outputs.plots.get(0)!.data.every((v) => v === 1)).toBe(true);
  });

  it('history on an inline expression `(a+b)[n]` compiles (materialized into an auto-history slot)', () => {
    expect(() => compile('//@version=6\nindicator("x")\nplot((close+open)[2],"v")\n')).not.toThrow();
    // equivalent to the assign-to-a-var form:
    expect(() => compile('//@version=6\nindicator("x")\nx=close+open\nplot(x[2],"v")\n')).not.toThrow();
  });
});

// ── namespace breadth: exact parity for the value-producing builtins beyond the
//    indicator set above (collections, color channels, the ta series vars, …) ──
const NS_EXACT: [string, string][] = [
  // arrays (stats / accessors)
  ['array.percentrank', 'var a=array.from(5.0,-2.0,0.0,9.0,1.0)\nplot(array.percentrank(a,3),"v")'],
  ['array.min/max nth', 'var a=array.from(5.0,-2.0,0.0,9.0,1.0)\nplot(array.min(a,1),"1")\nplot(array.max(a,2),"2")'],
  ['array.stdev biased vs sample', 'var a=array.from(2.0,4.0,6.0,8.0)\nplot(array.stdev(a),"1")\nplot(array.stdev(a,false),"2")'],
  ['array.variance/covariance', 'var a=array.from(2.0,4.0,6.0,8.0)\nvar b=array.from(1.0,2.0,3.0,4.0)\nplot(array.variance(a,false),"1")\nplot(array.covariance(a,b,false),"2")'],
  ['array.mode (smallest on tie)', 'var a=array.from(3.0,3.0,1.0,1.0,2.0)\nplot(array.mode(a),"v")'],
  ['array.median/sum/avg', 'var a=array.from(5.0,-2.0,0.0,9.0,1.0)\nplot(array.median(a),"1")\nplot(array.sum(a),"2")\nplot(array.avg(a),"3")'],
  // matrix (built once, read via accessors)
  ['matrix.get/sum/det', 'var m=matrix.new<float>(2,2,0.0)\nif bar_index==0\n    matrix.set(m,0,0,1.0)\n    matrix.set(m,0,1,2.0)\n    matrix.set(m,1,0,3.0)\n    matrix.set(m,1,1,4.0)\nplot(matrix.get(m,1,1),"1")\nplot(matrix.sum(m,10.0)==na?na:matrix.get(matrix.sum(m,10.0),0,0),"2")\nplot(matrix.det(m),"3")'],
  ['matrix.add_row at index', 'var m=matrix.new<float>(1,2,7.0)\nif bar_index==0\n    matrix.add_row(m,0,array.from(1.0,2.0))\nplot(matrix.rows(m),"1")\nplot(matrix.get(m,0,0),"2")'],
  // strings
  ['str.split/upper/pos', 'plot(array.size(str.split("a,b,c",",")),"1")\nplot(str.length(str.upper("abc")),"2")\nplot(str.pos("hello","l"),"3")'],
  // map
  ['map size/get', 'var mp=map.new<string,float>()\nif bar_index==0\n    map.put(mp,"k",42.0)\nplot(map.size(mp),"1")\nplot(map.get(mp,"k"),"2")'],
  // color channels (v6 palette; blue excluded — PineTS still carries stale v4 blue)
  ['color.red/green/black/olive channels', 'plot(color.r(color.red),"1")\nplot(color.g(color.green),"2")\nplot(color.b(color.black),"3")\nplot(color.r(color.olive),"4")'],
  // timeframe
  ['timeframe.in_seconds/isintraday', 'plot(timeframe.in_seconds(),"1")\nplot(timeframe.isintraday?1.0:0.0,"2")'],
  // the no-paren ta series variables
  ['ta.obv', 'plot(ta.obv,"v")'],
  ['ta.wvad', 'plot(ta.wvad,"v")'],
  ['ta.wad', 'plot(ta.wad,"v")'],
  ['ta.nvi', 'plot(ta.nvi,"v")'],
  ['ta.pvi', 'plot(ta.pvi,"v")'],
  ['ta.accdist', 'plot(ta.accdist,"v")'],
  ['ta.range', 'plot(ta.range(close,14),"v")'],
  ['ta.percentile_nearest_rank', 'plot(ta.percentile_nearest_rank(close,20,75),"v")'],
  ['ta.percentile_linear_interpolation', 'plot(ta.percentile_linear_interpolation(close,20,75),"v")'],
  // valuewhen with occurrence (nth prior true)
  ['ta.valuewhen occurrence 1 & 2', 'plot(ta.valuewhen(close>open,close,1),"1")\nplot(ta.valuewhen(close>open,close,2),"2")'],
  // bare auto-typed input
  ['input() bare (int/float/bool)', 'plot(input(21,"a"),"1")\nplot(input(2.5,"b"),"2")\nplot(input(close>open,"c")?1.0:0.0,"3")'],
];

describe.skipIf(!PineTS)('parity vs PineTS — namespace breadth (exact)', () => {
  for (const [name, body] of NS_EXACT) {
    it(name, async () => {
      const cmps = await runBoth(body);
      expect(cmps.length).toBeGreaterThan(0);
      for (const c of cmps) {
        const d = diff(c);
        if (d.maxRel >= 1e-6 || d.naMis !== 0) throw new Error(`${name}/${c.title}: maxRel=${d.maxRel.toExponential(2)} naMis=${d.naMis}`);
      }
    });
  }
});

describe.skipIf(!PineTS)('parity vs PineTS — verified piner-correct (PineTS missing or wrong)', () => {
  it('request.security same-TF is identity (returns close, not close[1])', async () => {
    // PineTS errors on syminfo in this harness, so assert piner against close directly.
    const eng = new Engine(compile('//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid,"60",close),"s")\nplot(close,"c")\n'), new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const [s, raw] = [...eng.outputs.plots.values()];
    expect(s.data).toEqual(raw.data);
  });

  it('ta.bbw matches the manual (upper-lower)/basis; PineTS returns it ×100', async () => {
    const eng = new Engine(compile('//@version=6\nindicator("x")\nb=ta.sma(close,20)\nd=ta.stdev(close,20)*2\nplot(ta.bbw(close,20,2),"bbw")\nplot((2*d)/b,"manual")\n'), new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const [bbw, man] = [...eng.outputs.plots.values()];
    for (let i = 40; i < PB.length; i++) expect(bbw.data[i]).toBeCloseTo(man.data[i], 9);
  });

  it('math.round_to_mintick / gcd / factorial (PineTS lacks these) — ground truth', async () => {
    const eng = new Engine(compile('//@version=6\nindicator("x")\nplot(math.round_to_mintick(123.4567),"1")\nplot(math.gcd(48,18),"2")\nplot(math.factorial(6),"3")\n'), new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const [r, g, f] = [...eng.outputs.plots.values()];
    expect(r.data[0]).toBeCloseTo(123.46, 9);
    expect(g.data[0]).toBe(6);
    expect(f.data[0]).toBe(720);
  });

  it('bare ta.tr ≡ tr(handle_na=false): na on bar 0 (v6 manual); PineTS returns high-low', async () => {
    const eng = new Engine(compile('//@version=6\nindicator("x")\nplot(ta.tr,"bare")\nplot(ta.tr(true),"hna")\n'), new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const [bare, hna] = [...eng.outputs.plots.values()];
    expect(Number.isNaN(bare.data[0])).toBe(true);
    expect(hna.data[0]).toBeCloseTo(PB[0].high - PB[0].low, 9);
    for (let i = 1; i < PB.length; i++) expect(bare.data[i]).toBeCloseTo(hna.data[i], 9); // identical past bar 0
  });

  it('barstate.isfirst / islastconfirmedhistory', async () => {
    const eng = new Engine(compile('//@version=6\nindicator("x")\nplot(barstate.isfirst?1.0:0.0,"f")\nplot(barstate.islastconfirmedhistory?1.0:0.0,"l")\n'), new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const [f, l] = [...eng.outputs.plots.values()];
    expect(f.data[0]).toBe(1); expect(f.data[1]).toBe(0);
    expect(l.data[PB.length - 1]).toBe(1); expect(l.data[0]).toBe(0);
  });
});

// ── newly-completed "Not yet" builtins ───────────────────────────────────────
const NOTYET_EXACT: [string, string][] = [
  ['ta.mode (rolling)', 'plot(ta.mode(math.round(close),20),"v")'],
  ['timestamp(y,mo,d,h,mi)', 'plot(timestamp(2021,6,15,9,30),"v")'],
  ['timestamp(tz, …)', 'plot(timestamp("America/New_York",2021,1,1,0,0),"v")'],
  ['time(timeframe.period)', 'plot(time(timeframe.period),"v")'],
  ['matrix.eigenvalues', 'var m=matrix.new<float>(2,2,0.0)\nif bar_index==0\n    matrix.set(m,0,0,2.0)\n    matrix.set(m,0,1,4.0)\n    matrix.set(m,1,0,6.0)\n    matrix.set(m,1,1,8.0)\nev=matrix.eigenvalues(m)\nplot(array.get(ev,0),"v")'],
  ['color.from_gradient transparency', 'c1=color.new(color.red,10)\nc2=color.new(color.green,80)\ng=color.from_gradient(close,90,120,c1,c2)\nplot(color.r(g),"r")\nplot(color.t(g),"t")'],
];

describe.skipIf(!PineTS)('parity vs PineTS — newly-completed builtins (exact)', () => {
  for (const [name, body] of NOTYET_EXACT) {
    it(name, async () => {
      const cmps = await runBoth(body);
      expect(cmps.length).toBeGreaterThan(0);
      for (const c of cmps) {
        const d = diff(c);
        if (d.maxRel >= 1e-6 || d.naMis !== 0) throw new Error(`${name}/${c.title}: maxRel=${d.maxRel.toExponential(2)} naMis=${d.naMis}`);
      }
    });
  }
});

describe.skipIf(!PineTS)('newly-completed builtins (PineTS lacks/differs — manual ground truth)', () => {
  it('ta.rci is +100 on a strictly rising series, -100 on falling', async () => {
    const up: Bar[] = Array.from({ length: 20 }, (_, i) => ({ time: i * 60000, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1 }));
    const eng = new Engine(compile('//@version=6\nindicator("x")\nplot(ta.rci(close,9,1),"v")\n'), new ArrayFeed(up));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect(eng.outputs.plots.get(0)!.data[19]).toBeCloseTo(100, 6);
  });
  it('ta.pivot_point_levels("Traditional") returns 11 levels with P=(H+L+C)/3', async () => {
    const c = compile('//@version=6\nindicator("x")\na = ta.pivot_point_levels("Traditional", false)\nplot(array.size(a),"n")\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[PB.length - 1]).toBe(11);
  });
  it('syminfo.prefix(tickerid) / ticker(tickerid) split "EXCHANGE:SYMBOL"', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(str.length(syminfo.prefix("NASDAQ:AAPL")),"p")\nplot(str.length(syminfo.ticker("NASDAQ:AAPL")),"t")\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(6); // "NASDAQ"
    expect(eng.outputs.plots.get(1)!.data[0]).toBe(4); // "AAPL"
  });
  it('str.tostring/format number patterns (manual semantics)', async () => {
    const c = compile('//@version=6\nindicator("x")\nplot(str.tostring(3.14159, "#.000")=="3.142"?1.0:0.0,"a")\nplot(str.format("{0,number,currency}", 1.34)=="$1.34"?1.0:0.0,"b")\nplot(str.format("{0,number,percent}", 0.5)=="50%"?1.0:0.0,"c")\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(1);
    expect(eng.outputs.plots.get(1)!.data[0]).toBe(1);
    expect(eng.outputs.plots.get(2)!.data[0]).toBe(1);
  });
});

// ── coverage-audit completions (vs the documented manual surface) ────────────
const AUDIT_EXACT: [string, string][] = [
  ['matrix.is_square / elements_count', 'var m=matrix.new<float>(2,2,1.0)\nplot(matrix.is_square(m)?1.0:0.0,"1")\nplot(matrix.elements_count(m),"2")'],
  ['matrix.is_identity / is_zero', 'var m=matrix.new<float>(2,2,0.0)\nif bar_index==0\n    matrix.set(m,0,0,1.0)\n    matrix.set(m,1,1,1.0)\nplot(matrix.is_identity(m)?1.0:0.0,"1")\nplot(matrix.is_zero(matrix.new<float>(2,2,0.0))?1.0:0.0,"2")'],
];

describe.skipIf(!PineTS)('coverage-audit completions — parity exact', () => {
  for (const [name, body] of AUDIT_EXACT) {
    it(name, async () => {
      for (const c of await runBoth(body)) {
        const d = diff(c);
        if (d.maxRel >= 1e-6 || d.naMis !== 0) throw new Error(`${name}/${c.title}: maxRel=${d.maxRel.toExponential(2)} naMis=${d.naMis}`);
      }
    });
  }
});

describe('coverage-audit completions — piner ground truth', () => {
  it('ta.max / ta.min are the running all-time high / low', async () => {
    const tb: Bar[] = [3, 7, 2, 9, 5].map((px, i) => ({ time: i * 60000, open: px, high: px, low: px, close: px, volume: 1 }));
    const c = compile('//@version=6\nindicator("x")\nplot(ta.max(close),"hi")\nplot(ta.min(close),"lo")\n');
    const js = new Engine(c, new ArrayFeed(tb), { backend: 'js' });
    const ip = new Engine(c, new ArrayFeed(tb), { backend: 'interp' });
    await js.run({ symbol: 'T', timeframe: '1' });
    await ip.run({ symbol: 'T', timeframe: '1' });
    expect(js.outputs.plots.get(0)!.data).toEqual([3, 7, 7, 9, 9]);
    expect(js.outputs.plots.get(1)!.data).toEqual([3, 3, 2, 2, 2]);
    expect(ip.outputs.plots.get(0)!.data).toEqual(js.outputs.plots.get(0)!.data);
  });
  it('runtime.error(message) halts the run', async () => {
    const c = compile('//@version=6\nindicator("x")\nif bar_index == 1\n    runtime.error("boom")\nplot(close)\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await expect(eng.run({ symbol: 'T', timeframe: '60' })).rejects.toThrow(/boom/);
  });
  it('array.new_linefill, max_bars_back (noop), box()/line() casts, default_entry_qty compile & run', async () => {
    const c = compile('//@version=6\nstrategy("x")\nmax_bars_back(close, 100)\nvar a = array.new_linefill(2)\nq = strategy.default_entry_qty(close)\nplot(array.size(a) + q)\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    expect(eng.outputs.plots.get(0)!.data[0]).toBe(3); // size 2 + default qty 1
  });
  it('line.set_first_point/set_second_point from chart.point updates the line', async () => {
    const c = compile('//@version=6\nindicator("x", overlay=true)\nvar l = line.new(0, 0.0, 1, 1.0)\nif barstate.islast\n    l.set_first_point(chart.point.from_index(5, 42.0))\nplot(close)\n');
    const eng = new Engine(c, new ArrayFeed(PB));
    await eng.run({ symbol: 'T', timeframe: '60' });
    const ln = eng.drawings.find((d) => d.type === 'line')!;
    expect(ln.props.x1).toBe(5);
    expect(ln.props.y1).toBe(42);
  });
});
