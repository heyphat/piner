/**
 * Bar Magnifier contract, public historical no-COOF traversal, and lifecycle
 * tests (dev-docs/bar-magnifier-plan.md §3-§5/§11.1): timeframe mapping,
 * settings, injected-data validation/preparation, portfolio isolation, reports,
 * and explicit fallback for unsupported COOF/realtime execution.
 */
import { describe, it, expect } from 'bun:test';
import {
  compile,
  Engine,
  ArrayFeed,
  PortfolioEngine,
  BAR_MAGNIFIER_CONTRACT_VERSION,
  BAR_MAGNIFIER_MAPPING_VERSION,
  parsePineTimeframe,
  barMagnifierTimeframe,
  type Bar,
  type BarMagnifierData,
  type EngineOptions,
  type UnixMillisecond,
  type StrategySettings,
} from '../src/index.js';
import * as rootEntry from '../src/index.js';
import * as nodeEntry from '../src/node.js';

const LEGACY_TRAVERSAL_SWITCH = 'TEST_ONLY_enableBarMagnifierTraversal' as const;
const INTERNAL_BROKER_LIFECYCLE = [
  'beginMagnifiedChartBar',
  'processMagnifierIntrabar',
  'endMagnifiedChartBar',
  'recordMagnifierFallback',
  'recordRealtimeMagnifierFallback',
] as const;
type EngineOptionsExposesTraversal = typeof LEGACY_TRAVERSAL_SWITCH extends keyof EngineOptions
  ? true
  : false;
const ENGINE_OPTIONS_EXPOSES_TRAVERSAL: EngineOptionsExposesTraversal = false;

const bars: Bar[] = Array.from({ length: 10 }, (_, i) => {
  const px = 100 + i;
  return { time: i * 60000, open: px, high: px + 2, low: px - 2, close: px, volume: 1 };
});

const ms = (n: number) => n as unknown as UnixMillisecond;

/** Complete, valid 60m-chart → 10m-target data. Target rows are intentionally
 * flat so public traversal is economically observable in scope tests. */
function makeMagnifierData(chartBars: readonly Bar[] = bars): BarMagnifierData {
  if (chartBars.length === 0) throw new Error('test fixture requires chart bars');
  const closeTimes = chartBars.map((b) => ms(b.time + 60000));
  const from = ms(chartBars[0].time);
  const to = closeTimes[closeTimes.length - 1];
  return {
    targetTimeframe: '10',
    bars: chartBars.flatMap((b) =>
      Array.from({ length: 6 }, (_, k) => ({
        time: ms(b.time + k * 10000),
        open: b.open,
        high: b.open,
        low: b.open,
        close: b.open,
        volume: 0,
      })),
    ),
    chartIntervals: { closeTimes, source: 'host-explicit' },
    coverage: {
      requested: { from, to },
      covered: [{ from, to }],
      gaps: [],
      complete: true,
    },
  };
}

/** Makes one partitioner invocation observable without adding production hooks:
 * prepareMagnifierBuckets reads chartIntervals exactly once per invocation. */
function observableMagnifierData(chartBars: readonly Bar[] = bars) {
  const base = makeMagnifierData(chartBars);
  let chartIntervalReads = 0;
  const data: BarMagnifierData = {
    targetTimeframe: base.targetTimeframe,
    bars: base.bars,
    get chartIntervals() {
      chartIntervalReads++;
      return base.chartIntervals;
    },
    coverage: base.coverage,
  };
  return { data, preparationCount: () => chartIntervalReads };
}

async function runStrategy(
  src: string,
  opts: {
    timeframe?: string;
    strategy?: Partial<StrategySettings>;
    backend?: 'js' | 'interp';
    magnifierData?: BarMagnifierData;
  } = {},
) {
  const c = compile(src);
  const eng = new Engine(c, new ArrayFeed(bars), {
    backend: opts.backend ?? 'js',
    ...(opts.strategy ? { strategy: opts.strategy } : {}),
  });
  if (opts.magnifierData) eng.ctx.magnifierData = opts.magnifierData;
  await eng.run({ symbol: 'BTCUSD', timeframe: opts.timeframe ?? '60' });
  return eng;
}

const STRAT = (header: string) => `//@version=6
strategy("bm"${header})
if bar_index == 2
    strategy.entry("L", strategy.long)
plot(close)
`;

describe('bar magnifier — contract versions and exports (plan §1.3)', () => {
  it('exports contract version 1 and fail-closed mapping version 2 from the root', () => {
    expect(BAR_MAGNIFIER_CONTRACT_VERSION).toBe(1);
    expect(BAR_MAGNIFIER_MAPPING_VERSION).toBe(3);
    expect(typeof parsePineTimeframe).toBe('function');
    expect(typeof barMagnifierTimeframe).toBe('function');
  });

  it('re-exports the identical contract from the node entrypoint', () => {
    expect(nodeEntry.BAR_MAGNIFIER_CONTRACT_VERSION).toBe(BAR_MAGNIFIER_CONTRACT_VERSION);
    expect(nodeEntry.BAR_MAGNIFIER_MAPPING_VERSION).toBe(BAR_MAGNIFIER_MAPPING_VERSION);
    expect(nodeEntry.parsePineTimeframe).toBe(parsePineTimeframe);
    expect(nodeEntry.barMagnifierTimeframe).toBe(barMagnifierTimeframe);
  });

  it('keeps traversal activation data-driven without exporting broker lifecycle hooks', async () => {
    expect(ENGINE_OPTIONS_EXPOSES_TRAVERSAL).toBe(false);
    expect(LEGACY_TRAVERSAL_SWITCH in rootEntry).toBe(false);
    expect(LEGACY_TRAVERSAL_SWITCH in nodeEntry).toBe(false);

    const noData = new Engine(compile(STRAT(', use_bar_magnifier=true')), new ArrayFeed(bars), {
      [LEGACY_TRAVERSAL_SWITCH]: true,
    } as unknown as EngineOptions);
    for (const name of INTERNAL_BROKER_LIFECYCLE) {
      expect(name in rootEntry).toBe(false);
      expect(name in nodeEntry).toBe(false);
      expect(name in noData.ctx.strategyBroker).toBe(false);
    }
    expect(LEGACY_TRAVERSAL_SWITCH in noData.ctx).toBe(false);
    (noData.ctx as unknown as Record<string, unknown>)[LEGACY_TRAVERSAL_SWITCH] = true;
    await noData.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(noData.strategy.barMagnifier).toMatchObject({
      active: false,
      magnifiedBars: 0,
      fallbackBars: bars.length,
      coverage: 'no-data',
    });

    const withData = new Engine(compile(STRAT(', use_bar_magnifier=true')), new ArrayFeed(bars));
    withData.ctx.magnifierData = makeMagnifierData();
    await withData.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(withData.strategy.barMagnifier).toEqual({
      requested: true,
      active: true,
      targetTimeframe: '10',
      magnifiedBars: bars.length,
      fallbackBars: 0,
      capFallbackBars: 0,
      dataFallbackBars: 0,
      intrabarsUsed: 6 * bars.length,
      firstMagnifiedBar: 0,
      coverage: 'complete',
    });
  });
});

describe('bar magnifier — Pine timeframe parser domains (plan §1.3)', () => {
  it('parses time-domain strings exactly', () => {
    expect(parsePineTimeframe('60')).toEqual({ domain: 'time', unit: 'minute', count: 60 });
    expect(parsePineTimeframe('1')).toEqual({ domain: 'time', unit: 'minute', count: 1 });
    expect(parsePineTimeframe('1440')).toEqual({ domain: 'time', unit: 'minute', count: 1440 });
    expect(parsePineTimeframe('30S')).toEqual({ domain: 'time', unit: 'second', count: 30 });
    expect(parsePineTimeframe('1D')).toEqual({ domain: 'time', unit: 'day', count: 1 });
    expect(parsePineTimeframe('3D')).toEqual({ domain: 'time', unit: 'day', count: 3 });
    expect(parsePineTimeframe('1W')).toEqual({ domain: 'time', unit: 'week', count: 1 });
    expect(parsePineTimeframe('12M')).toEqual({ domain: 'time', unit: 'month', count: 12 });
  });

  it('parses tick-domain strings as a distinct domain (tfSeconds cannot)', () => {
    expect(parsePineTimeframe('1T')).toEqual({ domain: 'tick', count: 1 });
    expect(parsePineTimeframe('10T')).toEqual({ domain: 'tick', count: 10 });
    expect(parsePineTimeframe('100T')).toEqual({ domain: 'tick', count: 100 });
    expect(parsePineTimeframe('1000T')).toEqual({ domain: 'tick', count: 1000 });
  });

  it('a bare unit letter means a multiplier of 1', () => {
    expect(parsePineTimeframe('D')).toEqual({ domain: 'time', unit: 'day', count: 1 });
    expect(parsePineTimeframe('W')).toEqual({ domain: 'time', unit: 'week', count: 1 });
    expect(parsePineTimeframe('M')).toEqual({ domain: 'time', unit: 'month', count: 1 });
    expect(parsePineTimeframe('S')).toEqual({ domain: 'time', unit: 'second', count: 1 });
    expect(parsePineTimeframe('T')).toEqual({ domain: 'tick', count: 1 });
  });

  it('rejects malformed strings (fail closed, plan §0.1)', () => {
    for (const bad of ['', '0', '00', '060', '1.5', '-5', '60m', '1d', ' 60', '60 ', 'X', '5X']) {
      expect(() => parsePineTimeframe(bad)).toThrow(/bar magnifier/);
    }
  });

  it('rejects values outside Pine v6 legal multipliers', () => {
    for (const bad of [
      '2S',
      '29S',
      '59S',
      '60S',
      '2T',
      '99T',
      '101T',
      '999T',
      '1001T',
      '999999999999999999999999T',
      '1441',
      '366D',
      '53W',
      '13M',
      '0T',
    ]) {
      expect(() => parsePineTimeframe(bad)).toThrow(/bar magnifier/);
    }
    // Discrete second/tick values and inclusive range maxima parse.
    expect(parsePineTimeframe('45S').count).toBe(45);
    expect(parsePineTimeframe('1000T').count).toBe(1000);
    expect(parsePineTimeframe('1440').count).toBe(1440);
    expect(parsePineTimeframe('365D').count).toBe(365);
    expect(parsePineTimeframe('52W').count).toBe(52);
  });
});

describe('bar magnifier — chart→intrabar mapping (plan §1.3, TV Help Center table)', () => {
  it('maps every published TV table row exactly', () => {
    const tvRows: Array<[string, string]> = [
      ['1T', '1T'],
      ['100T', '10T'],
      ['1000T', '100T'],
      ['1S', '1S'],
      ['30S', '5S'],
      ['1', '10S'],
      ['5', '30S'],
      ['10', '1'],
      ['15', '2'],
      ['30', '5'],
      ['60', '10'],
      ['240', '30'],
      ['1D', '60'],
      ['3D', '240'],
      ['1W', '1D'],
    ];
    for (const [chart, target] of tvRows) {
      expect(barMagnifierTimeframe(chart)).toBe(target);
    }
  });

  it('each row covers chart intervals until the next row (non-row TFs, plan §1.3 tests)', () => {
    // time domain interiors
    expect(barMagnifierTimeframe('2')).toBe('10S');
    expect(barMagnifierTimeframe('3')).toBe('10S');
    expect(barMagnifierTimeframe('7')).toBe('30S');
    expect(barMagnifierTimeframe('12')).toBe('1');
    expect(barMagnifierTimeframe('20')).toBe('2');
    expect(barMagnifierTimeframe('45')).toBe('5');
    expect(barMagnifierTimeframe('90')).toBe('10');
    expect(barMagnifierTimeframe('120')).toBe('10');
    expect(barMagnifierTimeframe('300')).toBe('30');
    expect(barMagnifierTimeframe('1439')).toBe('30');
    expect(barMagnifierTimeframe('2D')).toBe('60');
    expect(barMagnifierTimeframe('4D')).toBe('240');
    expect(barMagnifierTimeframe('6D')).toBe('240');
    // legal discrete seconds
    expect(barMagnifierTimeframe('5S')).toBe('1S');
    expect(barMagnifierTimeframe('10S')).toBe('1S');
    expect(barMagnifierTimeframe('15S')).toBe('1S');
    expect(barMagnifierTimeframe('45S')).toBe('5S');
    // legal discrete ticks
    expect(barMagnifierTimeframe('10T')).toBe('1T');
  });

  it('range boundaries are half-open at exactly the next row', () => {
    // 1440 minutes IS one day — it belongs to the 1D row, not the 240m row.
    expect(barMagnifierTimeframe('1440')).toBe('60');
    // 7 days IS one week — the terminal >=1W row.
    expect(barMagnifierTimeframe('7D')).toBe('1D');
  });

  it('implements the terminal `chart >= 1W` row as the unbounded range it is', () => {
    // The published final row has no upper bound, so every chart at or above one
    // week maps to 1D. Treating it as "exactly 1W" would make month and
    // multi-week charts unmappable and contradict the table.
    for (const atOrAboveAWeek of ['1W', '7D', 'W', '2W', '4W', '52W', '8D', '30D', '1M', 'M', '12M'])
      expect(barMagnifierTimeframe(atOrAboveAWeek)).toBe('1D');
    // The row below it is unaffected — 6D is still under one week.
    expect(barMagnifierTimeframe('6D')).toBe('240');
    // Its tick-domain twin is likewise unbounded.
    expect(barMagnifierTimeframe('1000T')).toBe('100T');
  });

  it('never clamps or substitutes: invalid chart TFs throw (plan §0.1)', () => {
    for (const bad of ['', '0', '2S', '59S', '99T', '5000T', '13M', 'h1', '1h']) {
      expect(() => barMagnifierTimeframe(bad)).toThrow(/bar magnifier/);
    }
  });
});

describe('bar magnifier — use_bar_magnifier setting (plan §9.1-P2)', () => {
  it('parses the const-bool header flag into strategy metadata', () => {
    expect(compile(STRAT(', use_bar_magnifier = true')).metadata.strategy?.useBarMagnifier).toBe(
      true,
    );
    expect(compile(STRAT(', use_bar_magnifier = false')).metadata.strategy?.useBarMagnifier).toBe(
      false,
    );
    expect(
      compile(STRAT(', use_bar_magnifier = not false')).metadata.strategy?.useBarMagnifier,
    ).toBe(true);
    // omitted → not present in the header partial (the broker default applies)
    expect(compile(STRAT('')).metadata.strategy?.useBarMagnifier).toBeUndefined();
  });

  it('rejects a supplied value that is not a const bool', () => {
    expect(() => compile(STRAT(', use_bar_magnifier = 1'))).toThrow(
      /use_bar_magnifier must be a const bool/,
    );
    expect(() =>
      compile(`//@version=6
strategy("bm", use_bar_magnifier = input.bool(true))
plot(close)
`),
    ).toThrow(/use_bar_magnifier must be a const bool/);
    expect(() =>
      compile(`//@version=6
strategy("bm", use_bar_magnifier = close > open)
plot(close)
`),
    ).toThrow(/use_bar_magnifier must be a const bool/);
  });

  it('rejects const-looking identifiers reassigned later at top level or in control flow', () => {
    expect(() =>
      compile(`//@version=6
gate = true
strategy("bm", use_bar_magnifier = gate)
gate := false
plot(close)
`),
    ).toThrow(/use_bar_magnifier must be a const bool/);

    expect(() =>
      compile(`//@version=6
gate = true
strategy("bm", use_bar_magnifier = gate)
if bar_index > 0
    gate := false
plot(close)
`),
    ).toThrow(/use_bar_magnifier must be a const bool/);
  });

  it('keeps complete legacy StrategySettings object literals source-compatible', () => {
    const legacy: StrategySettings = {
      initialCapital: 1_000_000,
      qtyType: 'fixed',
      qtyValue: 1,
      commissionType: 'percent',
      commissionValue: 0,
      pyramiding: 1,
      slippage: 0,
      processOrdersOnClose: false,
      calcOnOrderFills: false,
      calcOnEveryTick: false,
      marginLong: 100,
      marginShort: 100,
      minQty: 0.001,
    };
    expect(legacy.useBarMagnifier).toBeUndefined();
    const broker = new Engine(() => {}, new ArrayFeed([])).ctx.strategyBroker;
    broker.settings = legacy; // compile-time consumer compatibility regression
    expect(broker.settings).toBe(legacy);
  });

  it('defaults to false on the broker', async () => {
    const eng = await runStrategy(STRAT(''));
    expect(eng.ctx.strategyBroker.settings.useBarMagnifier).toBe(false);
  });

  it('host override wins over the header, both directions (plan §0.2 Properties toggle)', async () => {
    const on = await runStrategy(STRAT(''), { strategy: { useBarMagnifier: true } });
    expect(on.ctx.strategyBroker.settings.useBarMagnifier).toBe(true);
    const off = await runStrategy(STRAT(', use_bar_magnifier = true'), {
      strategy: { useBarMagnifier: false },
    });
    expect(off.ctx.strategyBroker.settings.useBarMagnifier).toBe(false);
  });
});

describe('bar magnifier — injected-data lifecycle and public traversal', () => {
  it('prepares exactly once and produces identical active run/step execution', async () => {
    const c = compile(STRAT(', use_bar_magnifier = true'));

    const runObserved = observableMagnifierData();
    const viaRun = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    viaRun.ctx.magnifierData = runObserved.data;
    await viaRun.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(runObserved.preparationCount()).toBe(1);
    expect(Object.isFrozen(runObserved.data.bars[0])).toBe(true);

    const stepObserved = observableMagnifierData();
    const viaStep = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    viaStep.ctx.magnifierData = stepObserved.data;
    viaStep.prepare({ symbol: 'BTCUSD', timeframe: '60' }, bars);
    // Preparation is eager and complete before the first external-clock step.
    expect(stepObserved.preparationCount()).toBe(1);
    while (viaStep.step()) {}
    expect(stepObserved.preparationCount()).toBe(1);
    expect(Object.isFrozen(stepObserved.data.bars[0])).toBe(true);

    expect(viaStep.strategy).toEqual(viaRun.strategy);
    expect(viaStep.outputs.plots.get(0)?.data).toEqual(viaRun.outputs.plots.get(0)?.data);
    expect(viaRun.strategy.barMagnifier).toMatchObject({
      active: true,
      magnifiedBars: bars.length,
      fallbackBars: 0,
      intrabarsUsed: 6 * bars.length,
      firstMagnifiedBar: 0,
      coverage: 'complete',
    });
  });

  it('rejects malformed injected data before any run or step script execution', async () => {
    const invalid = { ...makeMagnifierData(), targetTimeframe: '5' };

    let runExecutions = 0;
    const viaRun = new Engine(
      () => {
        runExecutions++;
      },
      new ArrayFeed(bars),
      { strategy: { useBarMagnifier: true } },
    );
    viaRun.ctx.magnifierData = makeMagnifierData();
    viaRun.prepare({ symbol: 'BTCUSD', timeframe: '60' }, bars);
    viaRun.ctx.magnifierData = invalid;
    await expect(viaRun.run({ symbol: 'BTCUSD', timeframe: '60' })).rejects.toThrow(
      /does not match/,
    );
    expect(runExecutions).toBe(0);
    expect(viaRun.strategy.barsProcessed).toBe(0);
    expect(viaRun.step()).toBe(false); // failed full run also clears stale prepared bars

    let stepExecutions = 0;
    const viaStep = new Engine(
      () => {
        stepExecutions++;
      },
      new ArrayFeed(bars),
      { strategy: { useBarMagnifier: true } },
    );
    viaStep.ctx.magnifierData = invalid;
    expect(() => viaStep.prepare({ symbol: 'BTCUSD', timeframe: '60' }, bars)).toThrow(
      /does not match/,
    );
    expect(stepExecutions).toBe(0);
    expect(viaStep.step()).toBe(false); // failed prepare cannot expose stale work
  });

  it('bind-time rejection clears stale steps and does not commit the rejected identity', async () => {
    const c = compile(STRAT(', use_bar_magnifier = true'));
    const makePrepared = () => {
      const eng = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
      eng.prepare({ symbol: 'OLD', timeframe: '60', mintick: 0.5 }, bars);
      expect(eng.ctx.symbol).toBe('OLD');
      expect(eng.ctx.tfStr).toBe('60');
      expect(eng.ctx.mintick).toBe(0.5);
      expect(eng.ctx.barMagnifierTargetTimeframe).toBe('10');
      return eng;
    };

    const viaPrepare = makePrepared();
    expect(() =>
      viaPrepare.prepare({ symbol: 'REJECTED', timeframe: '1h', mintick: 0.25 }, bars),
    ).toThrow(/bar magnifier/);
    expect(viaPrepare.ctx.symbol).toBe('OLD');
    expect(viaPrepare.ctx.tfStr).toBe('60');
    expect(viaPrepare.ctx.mintick).toBe(0.5);
    expect(viaPrepare.ctx.barMagnifierTargetTimeframe).toBe('10');
    expect(viaPrepare.step()).toBe(false);

    const viaRun = makePrepared();
    await expect(
      viaRun.run({ symbol: 'REJECTED', timeframe: '1h', mintick: 0.25 }),
    ).rejects.toThrow(/bar magnifier/);
    expect(viaRun.ctx.symbol).toBe('OLD');
    expect(viaRun.ctx.tfStr).toBe('60');
    expect(viaRun.ctx.mintick).toBe(0.5);
    expect(viaRun.ctx.barMagnifierTargetTimeframe).toBe('10');
    expect(viaRun.step()).toBe(false);
  });

  it('flag off never reads even a poisoned injected dataset and stays byte-identical', async () => {
    const c = compile(STRAT(''));
    const baseline = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    await baseline.run({ symbol: 'BTCUSD', timeframe: '60' });

    const poisoned = new Proxy({} as BarMagnifierData, {
      get(_target, key) {
        throw new Error(`flag-off run unexpectedly read magnifierData.${String(key)}`);
      },
    });
    const ignored = new Engine(c, new ArrayFeed(bars), { backend: 'js' });
    ignored.ctx.magnifierData = poisoned;
    await ignored.run({ symbol: 'BTCUSD', timeframe: '60' });

    expect(JSON.stringify(ignored.strategy)).toBe(JSON.stringify(baseline.strategy));
    expect(ignored.outputs.plots.get(0)?.data).toEqual(baseline.outputs.plots.get(0)?.data);
  });

  it('injected-data runs remain byte-identical across both execution backends', async () => {
    const src = STRAT(', use_bar_magnifier = true');
    const js = await runStrategy(src, { backend: 'js', magnifierData: makeMagnifierData() });
    const interp = await runStrategy(src, {
      backend: 'interp',
      magnifierData: makeMagnifierData(),
    });
    expect(JSON.stringify(interp.strategy)).toBe(JSON.stringify(js.strategy));
    expect(interp.outputs.plots.get(0)?.data).toEqual(js.outputs.plots.get(0)?.data);
  });
});

describe('bar magnifier — optional report block (plan §3.5)', () => {
  it('keeps a requested pre-run report nonthrowing and adds the block after a valid bind', () => {
    const eng = new Engine(compile(STRAT(', use_bar_magnifier = true')), new ArrayFeed(bars), {
      backend: 'js',
    });
    expect(() => eng.strategy).not.toThrow();
    expect(eng.strategy.barMagnifier).toBeUndefined();

    eng.prepare({ symbol: 'BTCUSD', timeframe: '60' }, bars);
    expect(eng.strategy.barMagnifier).toMatchObject({
      requested: true,
      active: false,
      targetTimeframe: '10',
    });
  });

  it('flag off: the block is entirely absent and the key set is unchanged', async () => {
    const eng = await runStrategy(STRAT(''));
    const rep = eng.strategy;
    expect('barMagnifier' in rep).toBe(false);
    expect(Object.keys(rep)).toEqual([
      'initialCapital',
      'netProfit',
      'grossProfit',
      'grossLoss',
      'wins',
      'losses',
      'evens',
      'maxDrawdown',
      'maxDrawdownPercent',
      'maxRunup',
      'maxRunupPercent',
      'totalCommission',
      'closedTrades',
      'equityCurve',
      'barsProcessed',
      'barsInMarket',
      'marginCalls',
    ]);
    expect(JSON.stringify(rep)).not.toContain('barMagnifier');
  });

  it('omitted, explicit false, and host-forced false produce identical full reports', async () => {
    const omitted = await runStrategy(STRAT(''));
    const explicit = await runStrategy(STRAT(', use_bar_magnifier = false'));
    const overridden = await runStrategy(STRAT(', use_bar_magnifier = true'), {
      strategy: { useBarMagnifier: false },
    });
    expect(JSON.stringify(explicit.strategy)).toBe(JSON.stringify(omitted.strategy));
    expect(JSON.stringify(overridden.strategy)).toBe(JSON.stringify(omitted.strategy));
  });

  it('requested with no data: block present, inactive, and all chart bars fall back', async () => {
    const eng = await runStrategy(STRAT(', use_bar_magnifier = true'), { timeframe: '60' });
    const block = eng.strategy.barMagnifier;
    expect(block).toEqual({
      requested: true,
      active: false,
      targetTimeframe: '10', // barMagnifierTimeframe('60')
      magnifiedBars: 0,
      fallbackBars: bars.length,
      capFallbackBars: 0,
      dataFallbackBars: 0,
      intrabarsUsed: 0,
      coverage: 'no-data',
    });
    expect(block && 'firstMagnifiedBar' in block).toBe(false);
  });

  it('requested via host override only: block present too (requested ≠ header-only)', async () => {
    const eng = await runStrategy(STRAT(''), {
      timeframe: '1D',
      strategy: { useBarMagnifier: true },
    });
    expect(eng.strategy.barMagnifier?.requested).toBe(true);
    expect(eng.strategy.barMagnifier?.targetTimeframe).toBe('60');
  });

  it('fails closed before execution on an unsupported chart timeframe', async () => {
    await expect(
      runStrategy(STRAT(', use_bar_magnifier = true'), { timeframe: '1h' }),
    ).rejects.toThrow(/bar magnifier/);
  });

  it('both backends produce byte-identical reports, flag on and off (two-backend invariant)', async () => {
    for (const header of ['', ', use_bar_magnifier = true']) {
      const js = await runStrategy(STRAT(header), { backend: 'js' });
      const ip = await runStrategy(STRAT(header), { backend: 'interp' });
      expect(JSON.stringify(ip.strategy)).toBe(JSON.stringify(js.strategy));
    }
  });

  it('an indicator with a host strategy override stays inactive and block-free', async () => {
    const c = compile(`//@version=6
indicator("i")
plot(close)
`);
    const eng = new Engine(c, new ArrayFeed(bars), {
      backend: 'js',
      strategy: { useBarMagnifier: true },
    });
    await eng.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(eng.ctx.strategyBroker.active).toBe(false);
    expect('barMagnifier' in eng.strategy).toBe(false);
  });
});

describe('bar magnifier — portfolio aggregate block (plan §3.5 atomic add, §8.3)', () => {
  const sleeves = (tf: string) => [
    { symbol: 'AAA', timeframe: tf, bars },
    { symbol: 'BBB', timeframe: tf, bars: bars.map((b) => ({ ...b, open: b.open + 1 })) },
  ];

  it('flag off: injected malformed sleeve data is ignored and the report stays byte-identical', () => {
    const engine = () => new PortfolioEngine(compile(STRAT('')), { mode: 'isolated' });
    const baseline = engine().run(sleeves('60'));
    const malformed = { ...makeMagnifierData(), targetTimeframe: '5' };
    const res = engine().run(sleeves('60').map((s) => ({ ...s, magnifierData: malformed })));
    expect(JSON.stringify(res)).toBe(JSON.stringify(baseline));
    expect('barMagnifier' in res.report).toBe(false);
    expect(Object.keys(res.report)).toEqual([
      'initialCapital',
      'netProfit',
      'grossProfit',
      'grossLoss',
      'wins',
      'losses',
      'evens',
      'maxDrawdown',
      'maxDrawdownPercent',
      'maxRunup',
      'maxRunupPercent',
      'totalCommission',
      'closedTrades',
      'equityCurve',
      'barsProcessed',
      'barsInMarket',
      'marginCalls',
    ]);
  });

  it('injects each sleeve independently without adding LTF times to the master clock', () => {
    const aBars = bars.slice(0, 3);
    const bBars = bars.slice(0, 3).map((b) => ({ ...b, time: b.time + 1_000_000 }));
    const aData = makeMagnifierData(aBars);
    const bData = makeMagnifierData(bBars);
    const res = new PortfolioEngine(compile(STRAT(', use_bar_magnifier = true')), {
      mode: 'isolated',
    }).run([
      { symbol: 'AAA', timeframe: '60', bars: aBars, magnifierData: aData },
      { symbol: 'BBB', timeframe: '60', bars: bBars, magnifierData: bData },
    ]);

    const chartTimes = [...aBars, ...bBars].map((b) => b.time).sort((a, b) => a - b);
    expect(res.times).toEqual(chartTimes);
    const chartTimeSet = new Set(chartTimes);
    const ltfOnlyTimes = [...aData.bars, ...bData.bars]
      .map((b) => b.time)
      .filter((t) => !chartTimeSet.has(t));
    expect(ltfOnlyTimes.length).toBeGreaterThan(0);
    for (const t of ltfOnlyTimes) expect(res.times).not.toContain(t);

    // Both distinct interval envelopes were validated/prepared. Reusing either
    // sleeve's dataset for the other would fail its chart-interval contract.
    expect(Object.isFrozen(aData.bars[0])).toBe(true);
    expect(Object.isFrozen(bData.bars[0])).toBe(true);
    for (const sleeve of res.sleeves) {
      expect(sleeve.report.barMagnifier).toMatchObject({
        active: true,
        magnifiedBars: 3,
        fallbackBars: 0,
        intrabarsUsed: 18,
        firstMagnifiedBar: 0,
        coverage: 'complete',
      });
    }
    expect(res.report.barMagnifier).toEqual({
      requested: true,
      active: true,
      targetTimeframe: '10',
      magnifiedBars: 6,
      fallbackBars: 0,
      capFallbackBars: 0,
      dataFallbackBars: 0,
      intrabarsUsed: 36,
      coverage: 'complete',
    });
  });

  it('requesting sleeves: per-sleeve blocks AND the aggregate block are present together', () => {
    const res = new PortfolioEngine(compile(STRAT(', use_bar_magnifier = true')), {
      mode: 'isolated',
    }).run(sleeves('60'));
    // per-sleeve verbatim reports carry their own blocks…
    for (const s of res.sleeves) {
      expect(s.report.barMagnifier?.requested).toBe(true);
      expect(s.report.barMagnifier?.targetTimeframe).toBe('10');
    }
    // …and the portfolio-level report carries the §8.3 aggregate: any-sleeve
    // requested → present; none active → inactive/no-data; sums of zeros; the
    // sleeves' common target.
    expect(res.report.barMagnifier).toEqual({
      requested: true,
      active: false,
      targetTimeframe: '10',
      magnifiedBars: 0,
      fallbackBars: 2 * bars.length,
      capFallbackBars: 0,
      dataFallbackBars: 0,
      intrabarsUsed: 0,
      coverage: 'no-data',
    });
  });

  it('fails closed instead of magnifying shared-account sleeves', () => {
    const engine = new PortfolioEngine(compile(STRAT(', use_bar_magnifier = true')), {
      mode: 'shared',
    });
    expect(() =>
      engine.run(sleeves('60').map((s) => ({ ...s, magnifierData: makeMagnifierData(s.bars) }))),
    ).toThrow(/Bar Magnifier data is not supported in shared account mode/);
  });

  it('fails closed on mixed chart timeframes instead of reporting an empty target', () => {
    const engine = new PortfolioEngine(compile(STRAT(', use_bar_magnifier = true')), {
      mode: 'isolated',
    });
    expect(() =>
      engine.run([
        { symbol: 'AAA', timeframe: '60', bars },
        { symbol: 'BBB', timeframe: '1D', bars },
      ]),
    ).toThrow(/one common chart timeframe/);
  });

  it('one-sleeve portfolio preserves its verbatim sleeve report and aggregate fields', async () => {
    const src = `//@version=6
strategy("bm-solo", use_bar_magnifier = true)
plot(close)
`;
    const c = compile(src);
    const solo = await runStrategy(src, {
      timeframe: '60',
      magnifierData: makeMagnifierData(),
    });
    const port = new PortfolioEngine(c, { mode: 'isolated' }).run([
      { symbol: 'BTCUSD', timeframe: '60', bars, magnifierData: makeMagnifierData() },
    ]);
    expect(JSON.stringify(port.sleeves[0].report)).toBe(JSON.stringify(solo.strategy));
    const { firstMagnifiedBar: _sleeveOnly, ...aggregateBlock } = solo.strategy.barMagnifier!;
    expect(port.report).toEqual({ ...solo.strategy, barMagnifier: aggregateBlock });
    expect(port.report.barMagnifier?.active).toBe(true);
    expect(port.report.barMagnifier?.coverage).toBe('complete');
  });
});

describe('bar magnifier — public no-COOF scope and COOF fallback', () => {
  const adversarial = (coof: boolean) => `//@version=6
strategy("bm-scope", use_bar_magnifier = true, calc_on_order_fills = ${coof})
if bar_index == 0
    strategy.entry("L", strategy.long, limit = 100)
if strategy.position_size > 0
    strategy.exit("X", "L", limit = 102)
plot(close)
`;

  it('uses validated LTF rows when COOF is off', async () => {
    const compiled = compile(adversarial(false));
    const chartOnly = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
    await chartOnly.run({ symbol: 'BTCUSD', timeframe: '60' });
    expect(chartOnly.strategy.closedTrades.length).toBeGreaterThan(0);

    // Target rows are flat at each chart open. The carried buy limit at 100
    // therefore never fills on bar 1 (all target prices are 101), unlike the
    // chart bar whose low is 99.
    const ltf = makeMagnifierData();
    const injected = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
    injected.ctx.magnifierData = ltf;
    await injected.run({ symbol: 'BTCUSD', timeframe: '60' });

    expect(Object.isFrozen(ltf.bars[0])).toBe(true);
    expect(injected.strategy.closedTrades).toHaveLength(0);
    expect(JSON.stringify(injected.strategy)).not.toBe(JSON.stringify(chartOnly.strategy));
    expect(injected.strategy.barMagnifier).toMatchObject({
      active: true,
      magnifiedBars: bars.length,
      fallbackBars: 0,
      intrabarsUsed: 6 * bars.length,
      coverage: 'complete',
    });
  });

  it('keeps injected COOF execution byte-identical to its established chart path', async () => {
    const compiled = compile(adversarial(true));
    const chartOnly = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
    await chartOnly.run({ symbol: 'BTCUSD', timeframe: '60' });

    const ltf = makeMagnifierData();
    const injected = new Engine(compiled, new ArrayFeed(bars), { backend: 'js' });
    injected.ctx.magnifierData = ltf;
    await injected.run({ symbol: 'BTCUSD', timeframe: '60' });

    expect(Object.isFrozen(ltf.bars[0])).toBe(true);
    expect(JSON.stringify(injected.strategy)).toBe(JSON.stringify(chartOnly.strategy));
    expect(injected.strategy.barMagnifier).toMatchObject({
      active: false,
      magnifiedBars: 0,
      fallbackBars: bars.length,
      intrabarsUsed: 0,
      coverage: 'no-data',
    });
  });
});
