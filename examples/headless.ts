/**
 * Headless piner usage — no UI, just code.
 *
 * Pipeline: generate OHLCV bars → wrap them in a DataFeed → compile a Pine v6
 * script → run the Engine over the feed → read the structured outputs.
 *
 * A real consumer installs the package and imports from it:
 *
 *     import { compile, Engine, ArrayFeed, type Bar } from '@heyphat/piner';
 *
 * This in-repo example imports from the source instead so it runs as-is:
 *
 *     bun run examples/headless.ts
 */
import { compile, Engine, ArrayFeed, type Bar } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Generate some data for the feed.
//    A DataFeed is anything with `history(symbol, timeframe) => Promise<Bar[]>`.
//    ArrayFeed is the built-in in-memory one. A Bar is { time, open, high, low,
//    close, volume } with time in epoch-ms. Here we synthesize a deterministic
//    random-walk so the run is reproducible (the engine never reads the clock).
// ─────────────────────────────────────────────────────────────────────────────
function makeBars(count: number, startMs = Date.UTC(2024, 0, 1)): Bar[] {
  const bars: Bar[] = [];
  const tf = 60_000; // 1-minute bars
  let price = 100;
  for (let i = 0; i < count; i++) {
    // deterministic drift + oscillation (no Math.random → same output every run)
    const drift = Math.sin(i / 9) * 2.5 + Math.cos(i / 23) * 1.2;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 0.8;
    const low = Math.min(open, close) - 0.8;
    bars.push({ time: startMs + i * tf, open, high, low, close, volume: 1_000 + (i % 13) * 25 });
    price = close;
  }
  return bars;
}

const bars = makeBars(200);
const feed = new ArrayFeed(bars);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The Pine v6 script. Plots two SMAs, marks crossovers with shapes, and fires
//    an alert on a bullish cross. Lengths are inputs so we can override them.
// ─────────────────────────────────────────────────────────────────────────────
const source = `//@version=6
indicator("SMA Cross Demo", overlay = true)

fastLen = input.int(10, "Fast length")
slowLen = input.int(30, "Slow length")

fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)

plot(fast, "Fast SMA", color = color.aqua)
plot(slow, "Slow SMA", color = color.orange)

bull = ta.crossover(fast, slow)
bear = ta.crossunder(fast, slow)

plotshape(bull, "Buy",  shape.triangleup,   location.belowbar, color = color.green)
plotshape(bear, "Sell", shape.triangledown, location.abovebar, color = color.red)

if bull
    alert("Bullish SMA cross", alert.freq_once_per_bar)
`;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Compile once. `compile` throws CompileError on lex/parse/semantic errors;
//    the result carries both backends + metadata (history slots, plot count, …).
// ─────────────────────────────────────────────────────────────────────────────
const compiled = compile(source);
const meta = compiled.metadata;
console.log(`compiled "${meta.title}" — overlay=${meta.overlay}, ${meta.inputs.length} inputs\n`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Run the engine over the feed. `inputs` overrides the defaults by title.
//    `backend: 'js'` runs the codegen'd function; 'interp' runs the tree-walker
//    (identical results — that equivalence is what the test suite enforces).
// ─────────────────────────────────────────────────────────────────────────────
const engine = new Engine(compiled, feed, { backend: 'js', inputs: { 'Fast length': 8 } });
await engine.run({ symbol: 'BINANCE:BTCUSDT', timeframe: '1' });

// ─────────────────────────────────────────────────────────────────────────────
// 5. Read the structured outputs. Everything is plain data — no rendering.
//    plots:   Map<id, { title, data: number[] (NaN = na) }>
//    markers: Map<id, { title, data: (MarkerPoint | null)[] }>
//    alerts:  { bar, message }[]
// ─────────────────────────────────────────────────────────────────────────────
const out = engine.outputs;
console.log(
  `ran ${bars.length} bars → ${out.plots.size} plot series, ${out.markers.size} marker series, ${out.alerts.length} alerts\n`,
);

for (const plot of out.plots.values()) {
  const last = plot.data[plot.data.length - 1];
  const firstValid = plot.data.findIndex((v) => !Number.isNaN(v));
  console.log(`plot "${plot.title}": warms up at bar ${firstValid}, last = ${last.toFixed(2)}`);
}

for (const marker of out.markers.values()) {
  const hits = marker.data.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  console.log(
    `marker "${marker.title}" (${marker.glyph}): fired on ${hits.length} bars → ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ' …' : ''}`,
  );
}

console.log(`\nalerts (${out.alerts.length}):`);
for (const a of out.alerts) {
  console.log(`  bar ${a.bar} @ ${new Date(bars[a.bar].time).toISOString()} — ${a.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. (Optional) Realtime: after the historical run, push developing ticks. Each
//    tick repaints the last bar; isClose=true commits it and advances.
// ─────────────────────────────────────────────────────────────────────────────
const nextTime = bars[bars.length - 1].time + 60_000;
engine.tick({ time: nextTime, open: 101, high: 101.5, low: 100.5, close: 101, volume: 10 }, false);
engine.tick({ time: nextTime, open: 101, high: 103.0, low: 100.5, close: 102.8, volume: 90 }, true);
const fast = out.plots.values().next().value!;
const tail = fast.data[fast.data.length - 1];
console.log(
  `\nafter 1 live bar: "${fast.title}" now has ${fast.data.length} points, last = ${tail.toFixed(2)}`,
);
