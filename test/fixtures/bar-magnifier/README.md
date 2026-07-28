# Bar Magnifier cross-engine fixtures

Deterministic black-box reference output for piner's experimental historical
`use_bar_magnifier` path, produced with
[PineForge](https://github.com/pineforge-4pass/pineforge-engine) on synthetic M1
feeds.

## Evidence boundary

**PineForge is not TradingView.** These fixtures are F-labeled differential
evidence from a second implementation: Pine-in, JSON-out, magnifier ON versus
OFF. They support a bounded release claim for already-live historical no-COOF
orders. They are never cited as TradingView-pinned behavior and do not establish
COOF, realtime, risk, margin, or complete TV parity.

**Clean-room.** Piner implementation inputs remain public TradingView Pine v6
documentation plus piner-owned invariants. Do not read/copy PineForge execution
source or semantics. Known PineForge divergences are excluded rather than
ported:

- a `strategy.exit` submitted while its `from_entry` position is flat has a
  different lifetime;
- scenario D fills a gapped stop at the stop level rather than the documented
  gap open.

## Layout

| path                            | what it is                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `proxy-validated-artifact.json` | reduced A/B/E rows asserted by piner; records the full 60-run artifact SHA-256            |
| `parity-artifact.json`          | legacy 30-run diagnostic snapshot retained for history; superseded as an assertion target |
| `summary.txt`                   | readable output from the current six-form, 60-run matrix                                  |
| `feeds/<scenario>.json`         | piner chart bars plus `BarMagnifierData`                                                  |
| `feeds/index.json`              | scenario metadata and inputs                                                              |
| `pineforge/*.m1.csv`            | exact PineForge M1 input feeds                                                            |
| `pineforge/*.chart.csv`         | corresponding 10-minute chart aggregation                                                 |
| `pineforge/probe-*.pine`        | six PineForge-compatible probe forms                                                      |
| `pineforge/gen_feeds.py`        | deterministic feed generator                                                              |

`feeds/<scenario>.json` injects through `engine.ctx.magnifierData` or
`PortfolioSleeveSpec.magnifierData`. Bar Magnifier data is deliberately not an
`EngineOptions` field.

## Scenarios

The chart timeframe is **10 minutes**, which maps to M1 intrabars. Each scenario
contains ten chart bars with ten M1 rows each.

| scenario                          | scenario-bar OHLC    | M1 path                              |
| --------------------------------- | -------------------- | ------------------------------------ |
| `A_tp_before_sl`                  | 98 / 106 / 94 / 99   | target 105 before stop 95            |
| `B_sl_before_tp`                  | 98 / 106 / 94 / 99   | stop 95 before target 105            |
| `C_tp_touched_before_limit_entry` | 102 / 106 / 99 / 101 | target printed before a priced entry |
| `D_subbar_gap_entry`              | 98 / 103 / 98 / 102  | stop entry jumped between M1 rows    |
| `E_short_tp_before_sl`            | 98 / 102 / 90 / 97   | short target 91 before stop 101      |

A and B are load-bearing: chart OHLC is identical and only M1 order differs.

## Probe forms

| form              | purpose                                           | evidence use                                                     |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `submit-once`     | priced entry and bracket submitted together       | diagnostic only; exposes PineForge flat-exit lifetime divergence |
| `reissue`         | priced entry/bracket re-stated while relevant     | diagnostic only                                                  |
| `prefilled`       | early market entry; bracket re-stated while open  | usable live-bracket ordering                                     |
| `prefilled-once`  | early market entry; bracket armed once while open | usable live-bracket persistence/order                            |
| `prefilled-limit` | early market entry; one live limit exit           | usable single-trigger/timestamp evidence                         |
| `prefilled-stop`  | early market entry; one live stop exit            | usable single-trigger/timestamp evidence                         |

## Proxy-validated rows

Piner asserts A/B/E for the three added forms on both JS and interpreter
backends, with magnifier ON and OFF controls. The original `prefilled` bracket
rows are asserted too.

| form                                         | A ON | B ON | E ON | OFF control                 |
| -------------------------------------------- | ---- | ---- | ---- | --------------------------- |
| live bracket (`prefilled`, `prefilled-once`) | 105  | 95   | 91   | A/B 95; E 101               |
| `prefilled-limit`                            | 105  | 105  | 91   | same price, chart timestamp |
| `prefilled-stop`                             | 95   | 95   | 101  | same price, chart timestamp |

ON fills carry the resolving M1 row's timestamp. OFF fills use the chart-bar
clock. C/D and the submit/reissue rows remain diagnostics and are not used to
infer piner semantics.

## Piner execution scope

Validated historical buckets now affect public fills when
`use_bar_magnifier=true` and `calc_on_order_fills=false`. Empty/no-data/cap
buckets fall back to chart OHLC; realtime uses chart fallback; COOF keeps its
existing audited chart scheduler and reports magnifier inactive. Magnifier-off
behavior is byte/economically unchanged. Isolated `PortfolioEngine` sleeves
share this path; shared-account portfolios reject requested injected magnifier
data until their cross-sleeve intrabar/account schedule is explicitly supported.

## Regenerating

The harness lives at `~/phat.vn/piner-sandbox/pineforge`:

```bash
cd ~/phat.vn/piner-sandbox/pineforge
colima start
python3 scripts/gen_feeds.py
./run.sh                     # 5 scenarios × 6 forms × ON/OFF = 60 runs
python3 scripts/summarize.py > out/summary.txt
```

The current compact full artifact SHA-256 is
`3ee5a6c943d9ab5ea9409a96cd47fc9fa81ff46b455b99805f8af2108af496eb`.
Two consecutive summarizations are byte-identical; release validation also
reruns the complete matrix when Docker is available.

## Expanded matrix

The artifact now covers **13 scenarios x 16 probe forms x ON/OFF = 352 runs**
(SHA-256 `3ee5a6c9…f496eb`). Beyond the original brackets the forms exercise
trailing stops, partial exits, OCA, pyramiding, stop-limit entries, slippage,
commission, multi-round-trips, reversals, and percent-of-equity sizing; the
scenarios add an intrabar tie (F), exact-touch triggers (G), an empty bucket
(H), a trail retrace (I), an exit-side gap (J), two round trips (K), and a
trailing order pair (L/M) with identical chart OHLC.

Additional rows that are **not** piner evidence, on top of those already listed
under `excluded`:

- **`prefilled-trail` with the magnifier ON.** PineForge exits every magnified
  trailing-stop run at the entry price; piner reproduces PineForge's own
  non-magnified answer. Oracle defect, not a piner divergence.
- **`H_empty_bucket` entirely.** PineForge derives its chart by aggregating the
  LTF feed, so removing M1 rows changes its chart rather than emptying a bucket.
  The two engines are not running the same chart. piner's fallback accounting is
  asserted directly in `test/bar-magnifier-pineforge-fixtures.test.ts`.
- **`stop-limit-entry` and `prefilled-oca`.** These disagree with the magnifier
  OFF as well, so the divergence is in base order semantics, not magnification.

One finding is genuinely open: `F_tie_same_subbar` / `prefilled-partial`
produces the same two trades in **opposite ledger order**, both stamped at the
same sub-bar. That is plan Q3/M2 (intrabar tie ordering) and needs TradingView
to settle.
