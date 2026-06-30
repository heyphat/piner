# Contributing to Piner

Thanks for your interest in contributing! Piner is a clean-room Pine Script v6
engine, and we welcome bug reports, fixes, new built-in coverage, and docs.

## Clean-room policy (important)

Piner is implemented **only** from public TradingView Pine Script v6
documentation. To keep the project clean:

- **Do not** copy, paste, or paraphrase code from any third-party Pine engine,
  especially AGPL/GPL-licensed projects.
- When implementing a built-in, cite the public Pine v6 manual behaviour in your
  PR description (and ideally in `docs/`), not another engine's source.

By contributing, you certify that your contribution is your own original work
and is offered under the project's AGPL-3.0 license.

## Development setup

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
git clone https://github.com/heyphat/piner.git
cd piner
bun install
```

## The two-backend invariant

Piner compiles each script to **both** generated JS and an AST interpreter, and
cross-checks them for **byte-for-byte identical output**. Any change to language
semantics must keep both backends in agreement — the test suite enforces this.
If you touch codegen, update the interpreter (and vice versa) in the same PR.

## Workflow

```bash
bun test          # full suite (includes parity + the two-backend cross-check)
bun run typecheck # tsc --noEmit
bun run build     # ESM + CJS + d.ts into dist/
```

1. Fork and branch off `main` (`fix/...`, `feat/...`).
2. Add or update tests for any behaviour change. Bug fixes need a regression test.
3. Make sure `bun test`, `bun run typecheck`, and `bun run build` all pass.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for messages
   (`feat(ta): ...`, `fix(parser): ...`, `docs: ...`) — the changelog depends on it.
5. Open a PR describing **what** changed and the **Pine v6 doc behaviour** it matches.

## Reporting bugs

Open an issue with a **minimal Pine v6 snippet** that reproduces the problem,
the expected output (per the TradingView manual), and what Piner produced.

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0](./LICENSE).
