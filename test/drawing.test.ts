import { describe, it, expect } from 'bun:test';
import { compile, Engine, ArrayFeed, DrawingPool, isNa, type Bar } from '../src/index.js';
import { makeLineNs, makeLabelNs, makeBoxNs, makeTableNs } from '../src/runtime/builtins/drawing.js';

const bars: Bar[] = Array.from({ length: 8 }, (_, i) => ({
  time: i * 60000, open: 100 + i, high: 110 + i, low: 90 + i, close: 100 + i, volume: 1,
}));

const run = async (src: string, backend: 'js' | 'interp' = 'js') => {
  const eng = new Engine(compile(src), new ArrayFeed(bars), { backend });
  await eng.run({ symbol: 'T', timeframe: '1' });
  return eng;
};

describe('DrawingPool (rollback-safe object store)', () => {
  it('create / set / get / remove', () => {
    const p = new DrawingPool();
    const id = p.create('line', { x1: 0, y1: 1 });
    expect(id).toBe(1);
    p.set(id, 'color', '#FF0000FF');
    expect(p.get(id, 'color')).toBe('#FF0000FF');
    expect(isNa(p.get(id, 'missing'))).toBe(true); // missing key → na sentinel
    p.remove(id);
    expect(p.objects.size).toBe(0);
  });
  it('snapshot/restore reverts created objects and the id counter', () => {
    const p = new DrawingPool();
    p.create('line', { x1: 0 });
    const snap = p.snapshot();
    const id2 = p.create('label', { x: 5 });
    p.set(1, 'x1', 99);
    expect(p.objects.size).toBe(2);
    p.restore(snap);
    expect(p.objects.size).toBe(1); // id2 undone
    expect(p.get(1, 'x1')).toBe(0); // mutation reverted
    expect(p.create('label', { x: 1 })).toBe(id2); // counter rolled back → same id
  });
});

describe('drawing namespace methods (full setter/getter coverage)', () => {
  it('line setters and getters', () => {
    const p = new DrawingPool();
    const line = makeLineNs(p);
    const id = line.new(0, 1, 2, 3, { color: '#111111FF' });
    line.set_x1(id, 10); line.set_y1(id, 11); line.set_x2(id, 12); line.set_y2(id, 13);
    line.set_color(id, '#222222FF'); line.set_width(id, 4); line.set_style(id, 'dashed');
    expect([line.get_x1(id), line.get_y1(id), line.get_x2(id), line.get_y2(id)]).toEqual([10, 11, 12, 13]);
    line.set_xy1(id, 1, 2); line.set_xy2(id, 3, 4);
    expect([line.get_x1(id), line.get_y2(id)]).toEqual([1, 4]);
    line.delete(id);
    expect(p.objects.size).toBe(0);
  });
  it('label setters and getters', () => {
    const p = new DrawingPool();
    const label = makeLabelNs(p);
    const id = label.new(0, 0, 'a');
    label.set_x(id, 5); label.set_y(id, 6); label.set_xy(id, 7, 8);
    label.set_text(id, 't'); label.set_color(id, '#1'); label.set_textcolor(id, '#2');
    label.set_style(id, 's'); label.set_size(id, 'large');
    expect([label.get_x(id), label.get_y(id)]).toEqual([7, 8]);
    label.delete(id);
    expect(p.objects.size).toBe(0);
  });
  it('box and table setters', () => {
    const p = new DrawingPool();
    const box = makeBoxNs(p);
    const bid = box.new(0, 1, 2, 3);
    box.set_lefttop(bid, 4, 5); box.set_rightbottom(bid, 6, 7);
    box.set_bgcolor(bid, '#a'); box.set_border_color(bid, '#b');
    expect(p.get(bid, 'left')).toBe(4);
    box.delete(bid);

    const table = makeTableNs(p);
    const tid = table.new('top_right', 2, 2);
    table.cell(tid, 1, 1, 'x', { text_color: '#c' });
    table.set_position(tid, 'bottom_left');
    expect((p.get(tid, 'cells') as any)['1,1'].text).toBe('x');
    table.clear(tid);
    expect(Object.keys(p.get(tid, 'cells') as object).length).toBe(0);
    table.delete(tid);
    expect(p.objects.size).toBe(0);
  });
});

describe('line.* with named-argument binding', () => {
  it('binds named style args into the object and applies setters', async () => {
    const eng = await run(`//@version=6
indicator("d", overlay=true)
var l = line.new(bar_index, low, bar_index, high, color=color.red, width=2)
line.set_xy2(l, bar_index, close)
plot(close)
`);
    expect(eng.drawings.length).toBe(1);
    const l = eng.drawings[0];
    expect(l.type).toBe('line');
    expect(l.props.color).toMatch(/^#[0-9A-F]{8}$/); // color.red resolved
    expect(l.props.width).toBe(2);
    expect(l.props.x2).toBe(bars.length - 1); // last bar_index via set_xy2
    expect(l.props.y2).toBe(bars[bars.length - 1].close);
  });

  it('both backends produce identical drawings', async () => {
    const src = `//@version=6
indicator("d")
var l = line.new(bar_index, low, bar_index, high, color=color.blue)
line.set_y2(l, close)
label.new(bar_index, high, text="hi", color=color.green)
plot(close)
`;
    const js = await run(src, 'js');
    const ip = await run(src, 'interp');
    expect(JSON.stringify(js.drawings)).toBe(JSON.stringify(ip.drawings));
  });
});

describe('label / box / table', () => {
  it('label with positional text + named color', async () => {
    const eng = await run(`//@version=6
indicator("d")
var lb = label.new(bar_index, high, "mark", color=color.orange)
label.set_text(lb, "updated")
plot(close)
`);
    const lb = eng.drawings.find((d) => d.type === 'label')!;
    expect(lb.props.text).toBe('updated');
    expect(lb.props.color).toMatch(/^#[0-9A-F]{8}$/);
  });
  it('box and table construct with their coordinates/grid', async () => {
    const eng = await run(`//@version=6
indicator("d")
var b = box.new(bar_index, high, bar_index, low, bgcolor=color.green)
var t = table.new(position.top_right, 2, 1)
table.cell(t, 0, 0, "x")
plot(close)
`);
    const box = eng.drawings.find((d) => d.type === 'box')!;
    expect(box.props.bottom).toBe(bars[0].low); // var → created on first bar
    const table = eng.drawings.find((d) => d.type === 'table')!;
    expect((table.props.cells as any)['0,0'].text).toBe('x');
  });

  it('binds FULLY-NAMED positional params into the right slots (box/line/label)', async () => {
    // Regression: named positional coords (box.new(left=.., top=.., ..)) must slot into
    // their params, not dump into the opts bag → `left` becoming the whole opts object
    // (which the FVG indicator hit, so no boxes rendered).
    const src = `//@version=6
indicator("d", overlay=true)
if barstate.islast
    box.new(left=bar_index - 2, top=high, right=bar_index, bottom=low, bgcolor=color.green, border_width=2)
    line.new(x1=bar_index - 3, y1=low, x2=bar_index, y2=high, color=color.red)
    label.new(x=bar_index, y=high, text="hi", color=color.orange)
plot(close)
`;
    const eng = await run(src);
    const last = bars.length - 1;

    const box = eng.drawings.find((d) => d.type === 'box')!;
    expect(typeof box.props.left).toBe('number'); // NOT an opts object
    expect(box.props.left).toBe(last - 2);
    expect(box.props.top).toBe(bars[last].high);
    expect(box.props.right).toBe(last);
    expect(box.props.bottom).toBe(bars[last].low);
    expect(box.props.border_width).toBe(2); // non-positional named → still bound via opts
    expect(box.props.bgcolor).toMatch(/^#[0-9A-F]{8}$/);

    const line = eng.drawings.find((d) => d.type === 'line')!;
    expect(typeof line.props.x1).toBe('number');
    expect(line.props.x1).toBe(last - 3);
    expect(line.props.y2).toBe(bars[last].high);

    const label = eng.drawings.find((d) => d.type === 'label')!;
    expect(label.props.text).toBe('hi'); // named text must not be swallowed into opts
    expect(typeof label.props.x).toBe('number');

    const ip = await run(src, 'interp'); // both backends must agree
    expect(JSON.stringify(ip.drawings)).toBe(JSON.stringify(eng.drawings));
  });

  it('folds POSITIONAL styling args past the coords into opts (box.new(l,t,r,b, na, bgcolor=))', async () => {
    // Regression (LuxAlgo "Liquidity Structure & Order Flow"): `box.new(l, t, r, b, na, bgcolor=c)`
    // passes `na` as the 5th POSITIONAL (Pine's border_color). The runtime takes only
    // (l,t,r,b,opts), so the extra positional was swallowed as `opts` (→ `...na`) and the real
    // bgcolor was dropped — every heatmap box rendered as the default blue outline.
    const src = `//@version=6
indicator("d", overlay=true)
if barstate.islast
    box.new(bar_index - 2, high, bar_index, low, na, bgcolor = color.new(color.green, 25))
plot(close)
`;
    const eng = await run(src);
    const box = eng.drawings.find((d) => d.type === 'box')!;
    expect(typeof box.props.left).toBe('number');
    expect(box.props.bgcolor).toMatch(/^#[0-9A-F]{8}$/); // the named bgcolor survives
    expect(isNa(box.props.border_color)).toBe(true);      // 5th positional na → border_color
    expect('__na' in box.props).toBe(false);              // not spread into the box itself
    const ip = await run(src, 'interp');
    expect(JSON.stringify(ip.drawings)).toBe(JSON.stringify(eng.drawings));
  });

  it('bundles NAMED args of a method call into opts (table.cell(c, r, txt, text_color=, bgcolor=))', async () => {
    // Regression (same script's dashboard): method calls flattened named args to positionals,
    // so `t.cell(col, row, txt, text_color=c, bgcolor=b)` landed the text_color STRING in the
    // runtime's `opts` slot and spread it character-by-character ({0:'#',1:'D',…}).
    const src = `//@version=6
indicator("d", overlay=true)
var t = table.new(position.top_right, 1, 1)
if barstate.islast
    t.cell(0, 0, "POC", text_color = color.gray, text_halign = text.align_left, bgcolor = color.new(color.black, 0))
plot(close)
`;
    const eng = await run(src);
    const table = eng.drawings.find((d) => d.type === 'table')!;
    const cell = (table.props.cells as any)['0,0'];
    expect(cell.text).toBe('POC');
    expect(cell.text_color).toMatch(/^#[0-9A-F]{8}$/); // a real color string, not spread chars
    expect(cell.text_halign).toBe('left');
    expect(cell.bgcolor).toMatch(/^#[0-9A-F]{8}$/);
    const ip = await run(src, 'interp');
    expect(JSON.stringify(ip.drawings)).toBe(JSON.stringify(eng.drawings));
  });

  it('label.new(x, y, …named opts) with NO positional text keeps xloc/style/color', async () => {
    // Regression (LuxAlgo SMC "Strong/Weak High/Low"): when `text` is omitted but other
    // params are named, the opts bag must land in the runtime's trailing `opts` slot —
    // not the skipped `text` positional. Otherwise xloc/style/color are lost, leaving the
    // label at a default bar_index xloc so set_point reads the na index → unrendered.
    const src = `//@version=6
indicator("d", overlay=true)
var label lb = label.new(na, na, color=color.orange, textcolor=color.red, xloc=xloc.bar_time, style=label.style_label_down, size=size.tiny)
if barstate.islast
    label.set_point(lb, chart.point.new(time, na, high))
    label.set_text(lb, "Strong High")
plot(close)
`;
    const eng = await run(src);
    const lb = eng.drawings.find((d) => d.type === 'label')!;
    expect(lb.props.xloc).toBe('bar_time'); // not swallowed into `text`
    expect(lb.props.style).toBe('label_down');
    expect(lb.props.size).toBe('tiny');
    expect(lb.props.text).toBe('Strong High');
    expect(typeof lb.props.x).toBe('number'); // set_point resolved x via point.time, not the na index
    expect(lb.props.x).toBe(bars[bars.length - 1].time);
    expect(lb.props.y).toBe(bars[bars.length - 1].high);

    const ip = await run(src, 'interp'); // both backends must agree
    expect(JSON.stringify(ip.drawings)).toBe(JSON.stringify(eng.drawings));
  });
});

describe('drawing objects roll back on realtime ticks', () => {
  it('a per-bar line.new does not permanently accumulate across ticks; ids are stable', async () => {
    const c = compile('//@version=6\nindicator("d")\nline.new(bar_index, low, bar_index, high)\nplot(close)\n');
    const eng = new Engine(c, new ArrayFeed(bars));
    await eng.run({ symbol: 'T', timeframe: '1' });
    expect(eng.drawings.length).toBe(bars.length); // one per historical bar

    const t = bars.length;
    eng.tick({ time: t * 60000, open: 1, high: 9, low: 0, close: 5, volume: 1 }, false);
    expect(eng.drawings.length).toBe(bars.length + 1);
    const idAfterFirst = eng.drawings[eng.drawings.length - 1].id;
    // second update: rollback then replay → still N+1, same id (counter rolled back)
    eng.tick({ time: t * 60000, open: 1, high: 12, low: 0, close: 8, volume: 1 }, false);
    expect(eng.drawings.length).toBe(bars.length + 1);
    expect(eng.drawings[eng.drawings.length - 1].id).toBe(idAfterFirst);
    expect(eng.drawings[eng.drawings.length - 1].props.y2).toBe(12); // repainted to the new tick's high
  });
});
