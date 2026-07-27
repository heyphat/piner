import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArrayFeed,
  Engine,
  compile,
  type Bar,
  type BarMagnifierData,
  type CompiledScript,
  type ClosedTrade,
} from '../src/index.js';
// PineForge is a proxy oracle for this deliberately bounded fixture slice. It is
// not TradingView evidence or a claim of complete TradingView parity.
const FIXTURE_ROOT = join(import.meta.dir, 'fixtures', 'bar-magnifier');
const FEED_ROOT = join(FIXTURE_ROOT, 'feeds');
const PROBE = readFileSync(
  join(FIXTURE_ROOT, 'pineforge', 'probe-pineforge-prefilled.pine'),
  'utf8',
);

type AddedProxyForm = 'prefilled-once' | 'prefilled-limit' | 'prefilled-stop';
type MagnifierMode = 'mag_on' | 'mag_off';
interface ProxyTrade {
  side: 'long' | 'short';
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  qty: number;
  pnl: number;
  entry_bar_index: number;
  exit_bar_index: number;
}
interface ProxyArtifact {
  scenarios: Record<string, Record<AddedProxyForm, Record<MagnifierMode, ProxyTrade>>>;
}

const ADDED_PROXY_FORMS: AddedProxyForm[] = ['prefilled-once', 'prefilled-limit', 'prefilled-stop'];
const ADDED_PROXY_SOURCES = new Map<AddedProxyForm, string>(
  ADDED_PROXY_FORMS.map((form) => [
    form,
    readFileSync(join(FIXTURE_ROOT, 'pineforge', `probe-pineforge-${form}.pine`), 'utf8'),
  ]),
);
const PROXY_ARTIFACT = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, 'proxy-validated-artifact.json'), 'utf8'),
) as ProxyArtifact;

interface FixtureFeed {
  scenario: string;
  inputs: Record<string, unknown>;
  chart_timeframe: string;
  chart_bars: Bar[];
  magnifier_data: BarMagnifierData;
}

// Load every committed feeds/*.json artifact, while running only the explicitly
// usable prefilled A/B/E scenarios. C/D and submit-once/reissue semantics are not
// asserted as TradingView parity.
const FEED_DOCUMENTS = new Map<string, unknown>(
  readdirSync(FEED_ROOT)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name, JSON.parse(readFileSync(join(FEED_ROOT, name), 'utf8'))]),
);
const FIXTURES = new Map<string, FixtureFeed>(
  [...FEED_DOCUMENTS.values()]
    .filter((value): value is FixtureFeed => {
      const candidate = value as Partial<FixtureFeed>;
      return typeof candidate.scenario === 'string' && candidate.magnifier_data != null;
    })
    .map((fixture) => [fixture.scenario, fixture]),
);

const PROBE_ON = compile(PROBE);
const PROBE_OFF = compile(PROBE.replace('use_bar_magnifier = true', 'use_bar_magnifier = false'));
const PROBE_COOF = compile(
  PROBE.replace('calc_on_order_fills = false', 'calc_on_order_fills = true'),
);
const CHART_RESTORATION_POC_PROBE = compile(`//@version=6
strategy("bm-poc-restoration", use_bar_magnifier = true, process_orders_on_close = true)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L")
plot(open)
plot(high)
plot(low)
plot(close)
plot(time)
plot(strategy.position_size)
`);
const GAP_DISCONTINUITY_PROBE = compile(`//@version=6
strategy("bm-ltf-discontinuity", use_bar_magnifier = true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop = 105)
if bar_index == 1
    strategy.close("L")
plot(time)
`);

type Backend = 'js' | 'interp';

async function runFixture(
  fixture: FixtureFeed,
  opts: {
    backend?: Backend;
    compiled?: CompiledScript;
    inject?: boolean;
  } = {},
) {
  const inputs = Object.fromEntries(
    Object.entries(fixture.inputs).map(([key, value]) => [
      key,
      typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : value,
    ]),
  );
  const engine = new Engine(opts.compiled ?? PROBE_ON, new ArrayFeed(fixture.chart_bars), {
    backend: opts.backend ?? 'js',
    // The generated proxy artifacts serialize numeric UI inputs as strings;
    // piner's host input contract supplies numeric overrides as numbers.
    inputs,
  });
  if (opts.inject !== false) engine.ctx.magnifierData = structuredClone(fixture.magnifier_data);
  await engine.run({ symbol: fixture.scenario, timeframe: fixture.chart_timeframe });
  return engine;
}

const usable = [
  ['A_tp_before_sl', 105, 1735693500000],
  ['B_sl_before_tp', 95, 1735693500000],
  ['E_short_tp_before_sl', 91, 1735693500000],
] as const;

// Piner-owned synthetic traversal fixture: the stop level 105 exists only in
// the discontinuity from one flat LTF row at 100 to the next flat row at 110.
// It is not PineForge or TradingView evidence.
const GAP_DISCONTINUITY_FIXTURE: FixtureFeed = {
  scenario: 'piner-ltf-discontinuity',
  inputs: {},
  chart_timeframe: '10',
  chart_bars: [
    { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: 600_000, open: 100, high: 110, low: 100, close: 110, volume: 1 },
    { time: 1_200_000, open: 110, high: 110, low: 110, close: 110, volume: 1 },
  ],
  magnifier_data: {
    targetTimeframe: '1',
    bars: [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 600_000, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 660_000, open: 110, high: 110, low: 110, close: 110, volume: 1 },
      { time: 1_200_000, open: 110, high: 110, low: 110, close: 110, volume: 1 },
    ],
    chartIntervals: {
      closeTimes: [600_000, 1_200_000, 1_800_000],
      source: 'host-explicit',
    },
    coverage: {
      requested: { from: 0, to: 1_800_000 },
      covered: [{ from: 0, to: 1_800_000 }],
      gaps: [],
      complete: true,
    },
  } as unknown as BarMagnifierData,
};

describe('Bar Magnifier — bounded PineForge prefilled proxy fixtures', () => {
  it('keeps requested no-data execution inactive on the chart path', async () => {
    for (const [scenario] of usable) {
      const fixture = FIXTURES.get(scenario)!;
      const chartOnly = await runFixture(fixture, { inject: false });

      expect(chartOnly.strategy.barMagnifier).toMatchObject({
        active: false,
        magnifiedBars: 0,
        fallbackBars: fixture.chart_bars.length,
        intrabarsUsed: 0,
        coverage: 'no-data',
      });
    }
  });

  it('publicly walks the usable prefilled A/B/E proxy cases on both backends', async () => {
    for (const [scenario, exitPrice, exitTime] of usable) {
      const fixture = FIXTURES.get(scenario)!;
      const js = await runFixture(fixture, { backend: 'js' });
      const interp = await runFixture(fixture, { backend: 'interp' });

      expect(JSON.stringify(interp.strategy)).toBe(JSON.stringify(js.strategy));
      expect(js.strategy.barsProcessed).toBe(10);
      expect(js.strategy.barsInMarket).toBe(3);
      expect(js.strategy.closedTrades).toHaveLength(1);
      expect(js.strategy.closedTrades[0]).toMatchObject({ exitPrice, exitTime });
      expect(js.strategy.barMagnifier).toEqual({
        requested: true,
        active: true,
        targetTimeframe: '1',
        magnifiedBars: 10,
        fallbackBars: 0,
        capFallbackBars: 0,
        dataFallbackBars: 0,
        intrabarsUsed: 100,
        firstMagnifiedBar: 0,
        coverage: 'complete',
      });
    }
  });

  it('matches the expanded live-exit PineForge artifact on both backends', async () => {
    const project = (trade: ClosedTrade): ProxyTrade => ({
      side: trade.dir > 0 ? ('long' as const) : ('short' as const),
      entry_time: trade.entryTime,
      exit_time: trade.exitTime,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      qty: trade.qty,
      pnl: trade.profit,
      entry_bar_index: trade.entryBar,
      exit_bar_index: trade.exitBar,
    });

    for (const form of ADDED_PROXY_FORMS) {
      const source = ADDED_PROXY_SOURCES.get(form)!;
      const compiled: Record<MagnifierMode, CompiledScript> = {
        mag_on: compile(source),
        mag_off: compile(source.replace('use_bar_magnifier = true', 'use_bar_magnifier = false')),
      };

      for (const [scenario] of usable) {
        const fixture = FIXTURES.get(scenario)!;
        for (const mode of ['mag_on', 'mag_off'] as const) {
          const js = await runFixture(fixture, { backend: 'js', compiled: compiled[mode] });
          const interp = await runFixture(fixture, {
            backend: 'interp',
            compiled: compiled[mode],
          });

          expect(JSON.stringify(interp.strategy)).toBe(JSON.stringify(js.strategy));
          expect(js.strategy.closedTrades).toHaveLength(1);
          expect(project(js.strategy.closedTrades[0])).toEqual(
            PROXY_ARTIFACT.scenarios[scenario][form][mode],
          );
          if (mode === 'mag_on') {
            expect(js.strategy.barMagnifier).toMatchObject({
              active: true,
              magnifiedBars: 10,
              fallbackBars: 0,
              intrabarsUsed: 100,
              coverage: 'complete',
            });
          } else {
            expect(js.strategy.barMagnifier).toBeUndefined();
          }
        }
      }
    }
  });

  it('reports mixed available/empty buckets honestly on the public path', async () => {
    const fixture = structuredClone(FIXTURES.get('A_tp_before_sl')!);
    const firstClose = fixture.magnifier_data.chartIntervals.closeTimes[0];
    fixture.magnifier_data.bars = fixture.magnifier_data.bars.filter(
      (bar) => bar.time >= firstClose,
    );

    const engine = await runFixture(fixture, {});
    expect(engine.strategy.closedTrades[0]).toMatchObject({
      exitPrice: 105,
      exitTime: 1735693500000,
    });
    expect(engine.strategy.barMagnifier).toEqual({
      requested: true,
      active: true,
      targetTimeframe: '1',
      magnifiedBars: 9,
      fallbackBars: 1,
      capFallbackBars: 0,
      dataFallbackBars: 1,
      intrabarsUsed: 90,
      firstMagnifiedBar: 1,
      coverage: 'mixed-data-fallback',
    });
  });

  it('restores complete chart OHLC/time before Pine and the chart-close POC pass', async () => {
    const fixture = FIXTURES.get('A_tp_before_sl')!;
    const engine = await runFixture(fixture, {
      compiled: CHART_RESTORATION_POC_PROBE,
    });

    const fields = ['open', 'high', 'low', 'close', 'time'] as const;
    fields.forEach((field, plotId) => {
      expect(engine.outputs.plots.get(plotId)?.data).toEqual(
        fixture.chart_bars.map((bar) => bar[field]),
      );
    });
    expect(engine.outputs.plots.get(5)?.data.slice(0, 2)).toEqual([0, 1]);
    expect(engine.strategy.closedTrades).toHaveLength(1);
    expect(engine.strategy.closedTrades[0]).toMatchObject({
      entryPrice: fixture.chart_bars[0].close,
      exitPrice: fixture.chart_bars[1].close,
      entryTime: fixture.chart_bars[0].time,
      exitTime: fixture.chart_bars[1].time,
    });
    expect(engine.strategy.barsProcessed).toBe(10);
    expect(engine.strategy.barsInMarket).toBe(1);
  });

  it('does not create a continuous fill segment across adjacent LTF rows', async () => {
    const engine = await runFixture(GAP_DISCONTINUITY_FIXTURE, {
      compiled: GAP_DISCONTINUITY_PROBE,
    });

    expect(engine.strategy.closedTrades).toHaveLength(1);
    // The carried stop at 105 is not touched by either flat row. It gap-fills
    // discretely at the next row's 110 open, never at an invented 100→110 segment.
    expect(engine.strategy.closedTrades[0].entryPrice).toBe(110);
    expect(engine.strategy.closedTrades[0].entryPrice).not.toBe(105);
  });

  it('keeps LTF fill timestamps separate from chart-time Pine executions', async () => {
    const engine = await runFixture(GAP_DISCONTINUITY_FIXTURE, {
      compiled: GAP_DISCONTINUITY_PROBE,
    });
    const trade = engine.strategy.closedTrades[0];
    const ltfOpenTimes = new Set(
      GAP_DISCONTINUITY_FIXTURE.magnifier_data.bars.map((bar) => bar.time as number),
    );

    expect(engine.outputs.plots.get(0)?.data).toEqual(
      GAP_DISCONTINUITY_FIXTURE.chart_bars.map((bar) => bar.time),
    );
    expect(ltfOpenTimes.has(trade.entryTime)).toBe(true);
    expect(trade.entryTime).toBe(660_000);
    expect(trade.entryTime).not.toBe(GAP_DISCONTINUITY_FIXTURE.chart_bars[trade.entryBar].time);
  });

  it('falls back for a cap-boundary bucket and reports it separately', async () => {
    const source = FIXTURES.get('A_tp_before_sl')!;
    const chartBars = source.chart_bars.slice(0, 2);
    const from = chartBars[0].time;
    const to = source.magnifier_data.chartIntervals.closeTimes[1];
    const rows = [
      ...Array.from({ length: 200_000 }, (_, i) => ({
        time: from + i * 2,
        open: 98,
        high: 98,
        low: 98,
        close: 98,
        volume: 1,
      })),
      { time: chartBars[1].time, open: 98, high: 98, low: 98, close: 98, volume: 1 },
    ];
    const fixture: FixtureFeed = {
      scenario: 'cap-boundary-report',
      inputs: {},
      chart_timeframe: '10',
      chart_bars: chartBars,
      magnifier_data: {
        targetTimeframe: '1',
        bars: rows,
        chartIntervals: {
          closeTimes: source.magnifier_data.chartIntervals.closeTimes.slice(0, 2),
          source: 'host-explicit',
        },
        coverage: {
          requested: { from, to },
          covered: [{ from, to }],
          gaps: [],
          complete: true,
        },
      } as unknown as BarMagnifierData,
    };

    const engine = await runFixture(fixture, {});
    expect(engine.strategy.barsProcessed).toBe(2);
    expect(engine.strategy.barMagnifier).toEqual({
      requested: true,
      active: true,
      targetTimeframe: '1',
      magnifiedBars: 1,
      fallbackBars: 1,
      capFallbackBars: 1,
      dataFallbackBars: 0,
      intrabarsUsed: 1,
      firstMagnifiedBar: 1,
      coverage: 'tv-cap-fallback',
    });
  });

  it('reports a fully cap-discarded older bucket at an exact edge as cap fallback', async () => {
    const source = FIXTURES.get('A_tp_before_sl')!;
    const chartBars = source.chart_bars.slice(0, 3);
    const from = chartBars[0].time;
    const to = source.magnifier_data.chartIntervals.closeTimes[2];
    const flat = (time: number) => ({
      time,
      open: 98,
      high: 98,
      low: 98,
      close: 98,
      volume: 1,
    });
    const rows = [
      flat(chartBars[0].time),
      ...Array.from({ length: 100_000 }, (_, i) => flat(chartBars[1].time + i * 5)),
      ...Array.from({ length: 100_000 }, (_, i) => flat(chartBars[2].time + i * 5)),
    ];
    const fixture: FixtureFeed = {
      scenario: 'cap-exact-edge-report',
      inputs: {},
      chart_timeframe: '10',
      chart_bars: chartBars,
      magnifier_data: {
        targetTimeframe: '1',
        bars: rows,
        chartIntervals: {
          closeTimes: source.magnifier_data.chartIntervals.closeTimes.slice(0, 3),
          source: 'host-explicit',
        },
        coverage: {
          requested: { from, to },
          covered: [{ from, to }],
          gaps: [],
          complete: true,
        },
      } as unknown as BarMagnifierData,
    };

    const engine = await runFixture(fixture, {});
    expect(engine.strategy.barsProcessed).toBe(3);
    expect(engine.strategy.barMagnifier).toEqual({
      requested: true,
      active: true,
      targetTimeframe: '1',
      magnifiedBars: 2,
      fallbackBars: 1,
      capFallbackBars: 1,
      dataFallbackBars: 0,
      intrabarsUsed: 200_000,
      firstMagnifiedBar: 1,
      coverage: 'tv-cap-fallback',
    });
  });

  it('counts one data fallback across realtime update/update/close rollback', async () => {
    const fixture = FIXTURES.get('A_tp_before_sl')!;
    const engine = await runFixture(fixture, {});
    const time = fixture.magnifier_data.chartIntervals.closeTimes.at(-1)! as number;
    const live = { time, open: 98, high: 98, low: 98, close: 98, volume: 1 };

    for (const [bar, isClose] of [
      [live, false],
      [{ ...live, high: 99, close: 99 }, false],
      [{ ...live, high: 100, close: 99.5 }, true],
    ] as const) {
      engine.tick(bar, isClose);
      expect(engine.strategy.barsProcessed).toBe(11);
      expect(engine.strategy.barMagnifier).toMatchObject({
        magnifiedBars: 10,
        fallbackBars: 1,
        capFallbackBars: 0,
        dataFallbackBars: 1,
        coverage: 'mixed-data-fallback',
      });
      expect(
        engine.strategy.barMagnifier!.magnifiedBars + engine.strategy.barMagnifier!.fallbackBars,
      ).toBe(engine.strategy.barsProcessed);
    }
  });

  it('keeps COOF on the existing inactive chart-OHLC fallback', async () => {
    const fixture = FIXTURES.get('A_tp_before_sl')!;
    const baseline = await runFixture(fixture, { compiled: PROBE_COOF, inject: false });
    const injected = await runFixture(fixture, { compiled: PROBE_COOF });

    expect(JSON.stringify(injected.strategy)).toBe(JSON.stringify(baseline.strategy));
    expect(injected.strategy.barMagnifier?.active).toBe(false);
    expect(injected.strategy.barMagnifier?.coverage).toBe('no-data');
  });

  it('keeps magnifier-off byte/economically identical with injected data', async () => {
    const fixture = FIXTURES.get('A_tp_before_sl')!;
    for (const backend of ['js', 'interp'] as const) {
      const chartOnly = await runFixture(fixture, {
        backend,
        compiled: PROBE_OFF,
        inject: false,
      });
      const injected = await runFixture(fixture, {
        backend,
        compiled: PROBE_OFF,
      });

      expect(JSON.stringify(injected.strategy)).toBe(JSON.stringify(chartOnly.strategy));
      expect(injected.strategy.barMagnifier).toBeUndefined();
    }
  });
});
