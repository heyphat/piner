# Public Pine Script library corpus (import/export testing)

These `.pine` files are **real, third-party Pine Script libraries vendored verbatim** from public
sources, used purely as a real-world test corpus for piner's library `import`/`export` support.
They are NOT piner's own code and retain their original authors' rights.

`test/library-corpus.test.ts` loads every file here into an in-memory `LibraryRegistry`, compiles a
small consumer that `import`s and exercises each library, runs it on **both backends** (codegen JS
and the interpreter oracle), and asserts byte-for-byte agreement. It is a hard regression gate:
every vendored library must compile, run, and agree across backends.

## Why these are reusable

Pine libraries published on TradingView are, per TradingView's
[House Rules on Script Publishing](https://www.tradingview.com/support/solutions/43000590599),
considered **public-domain code**: "permission is not required from their author if you call their
functions or reuse their code in your open-source scripts." piner is open-source (AGPL-3.0), and
these fixtures reuse the code for compatibility testing with attribution below.

## Provenance & attribution

| File | Identity used | Author / source | Notes |
|---|---|---|---|
| `rayolf-rc-highest-lowest.pine` | `rayolf/rc_highest_lowest/1` | rayolf — [github.com/rayolf/pinescript_libraries](https://github.com/rayolf/pinescript_libraries/blob/main/rc_highest_lowest/rc_highest_lowest.txt) | Verbatim (indentation reconstructed — the raw file uses no blank lines). Highest/lowest over a bar range; tuple returns, `var` array state, legacy bare `array.new()`. No `//@version` header (kept as published). |
| `pinecoders-alltimehighlow.pine` | `PineCoders/AllTimeHighLow/1` | PineCoders — real publication shown verbatim in the official [Libraries doc](https://www.tradingview.com/pine-script-docs/concepts/libraries/) | Default series params (`float val = high`), `var` state, per-call-site independence. Top-level demo `plot()`s are ignored on import. |
| `tvdocs-point.pine` | `TradingViewDocs/Point/1` | TradingView — "User-defined types and objects" example from the official Libraries doc | Exported UDT with field defaults. Illustrative (not a standalone publication); identity is synthetic. |
| `tvdocs-signal.pine` | `TradingViewDocs/Signal/1` | TradingView — "Enum types" example from the official Libraries doc | Exported enum with titled members. Illustrative; identity is synthetic. |

The `test/pinescripts/corpus/` directory (indicators/strategies) documents the broader vendoring
policy; this directory is the **library** counterpart.

## Extending

Drop more real published-library `.pine` files here, then add a row to the `LIBRARIES` manifest in
`test/library-corpus.test.ts` giving each one an `identity` and a small `exercise` consumer that
imports and calls it. To pull source verbatim from a GitHub-hosted mirror:

```sh
curl -sL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> \
  > test/pinescripts/libraries/<author>-<name>.pine
```

Note: TradingView serves published library source only through its script-page code viewer / Pine
Editor (no clean raw-source API keyed by `Publisher/Lib/Version`), so genuinely-external fixtures
come from authors' own public mirrors (e.g. GitHub) or from the official documentation's examples.
