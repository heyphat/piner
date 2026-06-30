# Third-party Pine Script corpus (compatibility testing)

These `.pine` files are **vendored verbatim** from public GitHub repositories purely as a
real-world test corpus for piner. They are NOT piner's own code and retain their original
authors' licenses. `test/corpus.test.ts` runs each one through piner and classifies it by the
first stage it fails at (parse / sema / runtime / divergence / pass) — a gap backlog, not a
pass/fail gate.

**Version policy:** piner targets Pine Script **v5 and v6**. v4-and-older is a deprecated,
divergent dialect (`study()`, `input(type=…)`, un-namespaced builtins, bare color/style
globals) and is **out of scope** — the harness reads `//@version` and buckets anything `<5` as
`legacy` (excluded from the backlog, not counted as a gap). Several `everget-*` files are v3/v4
and so sit in that bucket; they're kept as boundary examples (and to exercise version
detection), not as gaps to fix.

## Provenance

| Prefix | Source repo | What |
|---|---|---|
| `everget-*` | [everget/tradingview-pinescript-indicators](https://github.com/everget/tradingview-pinescript-indicators) | A broad sample (1–2 per category) of community indicators — bands, oscillators, moving averages, volume, volatility, trailing stops, stats, utils. Stresses parser + runtime breadth. |
| `fm-*` | [Opus-Aether-AI/pine-transpiler](https://github.com/Opus-Aether-AI/pine-transpiler) | A peer Pine→JS transpiler's `fixtures/feature-matrix/` — each isolates one feature (request.security, map/matrix, methods, library import, source input, strategy, table merge, varip, …) plus `ict-killzones` / `trivial-sma`. |

## Refreshing / extending

Add more scripts by dropping `.pine` files here (any name) — the harness globs the directory.
To re-vendor or pull more from a source repo:

```sh
gh api "repos/<owner>/<repo>/contents/<path>.pine?ref=<branch>" \
  -H "Accept: application/vnd.github.raw" > test/pinescripts/corpus/<prefix>-<name>.pine
```

Larger candidate sources (see the search notes): `f13end/tradingview-custom-indicators` (115),
`LuxAlgo/PineTS` (compatibility suite w/ expected outputs vs TradingView),
`pAulseperformance/awesome-pinescript` (curated index).
