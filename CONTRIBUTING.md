# Contributing

Thanks for helping. The most useful thing you can do is run Context Cube on your own project and tell us what broke.

## Setup

```sh
npm install
npm test          # builds the bundle, then runs every test; no AI calls
npm run typecheck
npm run build     # writes dist/cube.mjs, the single-file CLI
```

Node 20 or newer. The CLI is TypeScript in `src/`, bundled by esbuild into one dependency-free file, which the tool copies into each project as `context-cube/.tool/cube.mjs`.

## How the code is laid out

- `src/core/` knows nothing about any AI agent: the format, the build pipeline, checks, stats, git.
- `src/adapters/` holds everything agent-specific. `claude-code/` is the full adapter; `generic/` only writes an AGENTS.md block. A new agent is a new adapter implementing `src/adapters/types.ts`.
- `src/ai/` is the AI runner: one prompt file (`prompts/`) and one schema (`schemas/`) per step. The AI decides; code writes the files.
- `docs/FORMAT.md` is the format. Change it when the format changes.

## Tests and AI

Tests never call a model. AI steps replay answers recorded from live runs in `tests/fixtures/recorded/`, keyed by the exact prompt. If you change a prompt, or anything that feeds one, record new answers by running the build tests once with `CUBE_TEST_RECORD=1`:

```sh
npm run build
CUBE_TEST_RECORD=1 npx vitest run tests/e2e --no-file-parallelism --testTimeout=1800000
```

Recorded answers are replayed and only missing ones are made live, one test file at a time so the same answer isn't paid for twice. That uses your own plan's usage. Live answers differ from the old ones, so a test that checks a detail the AI wrote may need updating.

To record answers for a project of your own, set both `CUBE_AI_REPLAY` and `CUBE_AI_RECORD` to the recordings folder and run `node /path/to/dist/cube.mjs build --yes` in a copy of it.

To find recordings no test uses any more, run the tests with `CUBE_AI_TRACK=/tmp/used.txt npm test`; the file lists every recording that was replayed.

`cube ai test` runs a trivial step live at each tier, to check the runner end to end.

## Rules for fixtures

Test projects in `tests/fixtures/` are synthetic. Never copy a real project's files or content into this repo.

## Style

Match the code around you. Plain words in anything a person reads (CLI output, prompts, docs). Figures about tokens are estimates and say so; the stats never claim "savings".
