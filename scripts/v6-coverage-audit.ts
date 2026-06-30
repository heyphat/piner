import { readFileSync, writeFileSync } from 'fs';
import { ExecutionContext } from '../src/index.js';
import { Ta } from '../src/runtime/builtins/ta.js';
import { KEYWORDS, MULTI_OPS, SINGLE_OPS, PUNCT } from '../src/lexer/token.js';
import { NS_RUNTIME } from '../src/codegen/intrinsics.js';
import { historicalBarState } from '../src/runtime/barstate.js';

const DOC = '/Users/phat/phat.vn/fractal-chart/pinescriptv6/pinescriptv6_complete_reference.md';
const md = readFileSync(DOC, 'utf8').split('\n');

// 1) split into sections by single-# headers; collect ## entries per section.
const SECTIONS = ['Variables', 'Constants', 'Functions', 'Keywords', 'Types', 'Operators', 'Annotations'];
const entries: Record<string, string[]> = {};
let cur = '';
for (const line of md) {
  const h1 = /^# (\w+)/.exec(line);
  if (h1 && SECTIONS.includes(h1[1])) { cur = h1[1]; entries[cur] = []; continue; }
  const h2 = /^## (.+)$/.exec(line);
  if (h2 && cur) entries[cur].push(h2[1].trim());
}

// 2) piner inventories
const ctx: any = new ExecutionContext();
ctx.bar = historicalBarState(true, true); // populate barstate.* for probing
const taM = new Set(Object.getOwnPropertyNames(Ta.prototype).filter((n) => n !== 'constructor' && !n.startsWith('_')));
const LEAVES = new Set(['open','high','low','close','volume','time','hl2','hlc3','ohlc4','hlcc4','time_close','bar_index','last_bar_index','last_bar_time','timenow','time_tradingday','year','month','dayofmonth','dayofweek','hour','minute','second','weekofyear','na']);
// Covered via compile-time constant folding (`dayofweek.<day>`, analyze) or a
// codegen/interpreter member special-case (the two bare strategy trade-collection
// stats) — neither is reachable by runtime namespace probing, so list explicitly.
const FOLD_COVERED = new Set([
  'dayofweek.sunday','dayofweek.monday','dayofweek.tuesday','dayofweek.wednesday',
  'dayofweek.thursday','dayofweek.friday','dayofweek.saturday',
  'strategy.closedtrades.first_index','strategy.opentrades.capital_held',
]);
const keys = (o: any) => o && typeof o === 'object' ? new Set(Object.keys(o)) : new Set<string>();
const fnNs: Record<string, Set<string>> = { ta: taM, math: keys(ctx.math), str: keys(ctx.str), color: keys(ctx.color), array: keys(ctx.array), map: keys(ctx.map), matrix: keys(ctx.matrix), input: keys(ctx.input), line: keys(ctx.line), label: keys(ctx.label), box: keys(ctx.box), table: keys(ctx.table), linefill: keys(ctx.linefill), polyline: keys(ctx.polyline), strategy: new Set([...keys(ctx.strategy), 'tradeField']), request: new Set([...keys(ctx.request), 'security']), ticker: keys(ctx.ticker), log: keys(ctx.log), timeframe: keys(ctx.timeframe), chart: new Set(['point']), syminfo: new Set(['prefix','ticker']), runtime: keys(ctx.runtime) };
const GLOBAL_FN_OK = new Set(['indicator','strategy','library','plot','plotshape','plotchar','plotarrow','plotcandle','plotbar','hline','fill','bgcolor','barcolor','nz','na','fixnan','alert','alertcondition','int','float','bool','string','color','timestamp','time','time_close','input','year','month','dayofmonth','dayofweek','hour','minute','second','weekofyear','max_bars_back','line','label','box','table','linefill','polyline']);
const TYPES_OK = new Set(['array','bool','box','chart.point','color','const','float','int','label','line','linefill','map','matrix','polyline','series','simple','string','table']);

// probe a dotted variable/constant against a piner namespace object
function nsHas(full: string): boolean {
  if (FOLD_COVERED.has(full)) return true; // constant-folded / member special-case
  const parts = full.split('.');
  const rt = NS_RUNTIME[parts[0]] ?? parts[0];
  let obj: any = ctx[rt];
  for (let i = 1; i < parts.length; i++) {
    // a callable namespace (e.g. `alert`) is a function carrying const properties
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
    if (!(parts[i] in obj)) return false;
    obj = obj[parts[i]];
  }
  return obj !== undefined;
}

const covered: Record<string, string[]> = {};
const gaps: Record<string, string[]> = {};
const note: Record<string, string> = {};
const mark = (sec: string, name: string, ok: boolean) => { (ok ? (covered[sec] ??= []) : (gaps[sec] ??= [])).push(name); };

for (const e of entries.Functions ?? []) {
  const cleaned = e.replace(/<[^>]*>/g, '');
  const m = /^([a-z_][\w.]*)\(\)?/.exec(cleaned); if (!m) { mark('Functions', e, false); continue; }
  const full = m[1]; const parts = full.split('.');
  if (parts.length === 1) mark('Functions', full, GLOBAL_FN_OK.has(parts[0]) || !!fnNs[parts[0]]);
  else { const ns = parts[0], fn = parts.slice(1).join('.'); const impl = fnNs[ns];
    const extra = (ns === 'math' && fn === 'sum') || (ns === 'strategy' && (fn === 'convert_to_account' || fn === 'convert_to_symbol'));
    mark('Functions', full, extra || (!!impl && (impl.has(fn) || impl.has(parts[1])))); }
}
for (const e of entries.Variables ?? []) {
  const name = e.replace(/\s.*$/, '');
  mark('Variables', name, name.includes('.') ? nsHas(name) : LEAVES.has(name));
}
for (const e of entries.Constants ?? []) {
  const name = e.replace(/\s.*$/, '');
  mark('Constants', name, name.includes('.') ? nsHas(name) : (name === 'true' || name === 'false'));
}
for (const e of entries.Types ?? []) mark('Types', e, TYPES_OK.has(e));
for (const e of entries.Keywords ?? []) { const k = e.replace('...', ' '); mark('Keywords', e, e.split(/\.\.\.|\s/).every((w) => KEYWORDS.has(w))); }
const OPS = new Set([...MULTI_OPS, ...SINGLE_OPS, ...PUNCT, '?:', '[]']);
for (const e of entries.Operators ?? []) mark('Operators', e, OPS.has(e) || e === '?:' || e === '[]');
for (const e of entries.Annotations ?? []) mark('Annotations', e, true); // parsed as comments (no-op); @version honored
note.Annotations = 'piner treats `//@…` as comments (ignored, no error); `//@version` is honored. Annotations carry no execution semantics, so this is functionally complete.';


const DEFER: [RegExp, string][] = [
  [/^strategy\.risk\./, 'risk-limit controls (need broker halt logic)'],
  [/^(ask|bid)$/, 'tick-level bid/ask (no L1 quote feed)'],
  [/^syminfo\.(industry|sector|recommendations|target_price|shares_outstanding|expiration_date|current_contract|main_tickerid)/, 'live exchange/fundamental metadata (no data feed)'],
  [/^(dividends|earnings)\.future_/, 'forward fundamental data (no feed)'],
  [/^session\.(ismarket|ispremarket|ispostmarket)/, 'session state (no session model)'],
];
function disp(name: string): { fill: boolean; why: string } {
  for (const [re, why] of DEFER) if (re.test(name)) return { fill: false, why };
  return { fill: true, why: '' };
}

// 3) emit report
const lines: string[] = [];
let totDoc = 0, totCov = 0;
let totFill = 0;
for (const sec of SECTIONS) {
  const c = covered[sec] ?? [], g = gaps[sec] ?? [];
  const tot = c.length + g.length; totDoc += tot; totCov += c.length;
  const fillable = g.filter((x) => disp(x).fill), deferred = g.filter((x) => !disp(x).fill);
  totFill += fillable.length;
  lines.push(`\n## ${sec} — ${c.length}/${tot} covered${g.length ? ` · **${fillable.length} fillable, ${deferred.length} deferred**` : ' ✅'}`);
  if (note[sec]) lines.push(`\n${note[sec]}`);
  if (fillable.length) lines.push(`\n**Fillable now:** ${fillable.map((x) => '`' + x + '`').join(', ')}`);
  if (deferred.length) {
    const byWhy = new Map<string, string[]>();
    for (const x of deferred) { const w = disp(x).why; (byWhy.get(w) ?? byWhy.set(w, []).get(w))!.push(x); }
    for (const [w, xs] of byWhy) lines.push(`\n**Deferred** (${w}): ${xs.map((x) => '`' + x + '`').join(', ')}`);
  }
}
lines.push(`\n---\n\n**${totFill} fillable gaps** (no external data/infra needed) across Variables/Constants/Functions; the rest need a data feed or a larger subsystem.`);
console.log(`TOTAL: ${totCov}/${totDoc} documented entries covered (${(totCov / totDoc * 100).toFixed(1)}%)`);
console.log(lines.join('\n'));
const header = '# Pine Script v6 — coverage gap report (piner vs the reference manual)\n\n' +
  'Auto-generated by `scripts/v6-coverage-audit.ts` (`bun scripts/v6-coverage-audit.ts`): a name-by-name diff of every documented `##` entry in the\n' +
  'bundled v6 reference manual against piner\'s implemented surface, grouped by the manual\'s 7 top-level\n' +
  'sections (Types, Variables, Constants, Functions, Keywords, Operators, Annotations).\n\n' +
  '> The bundled manual is an older v6 snapshot (no `type_footprint`); features TradingView added since\n' +
  '> are not visible here. See coverage-and-compatibility.md §3.1.\n\n' +
  '**' + totCov + '/' + totDoc + ' documented entries covered (' + (totCov/totDoc*100).toFixed(1) + '%).**\n';
writeFileSync(new URL('../docs/v6-coverage-gap.md', import.meta.url), header + lines.join('\n') + '\n');
