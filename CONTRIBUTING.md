# Contributing

Thanks for helping. The most useful thing you can do is run Context Cube on your own project and tell us what broke.

## The standard

When two designs would both work, pick the one that serves this better: **the agent sees every fact that could change its decision, sees as little else as possible, and can prove how it got there.** Two rules follow from it:

- Text moved in from a project's files, and closed history entries, are never rewritten by the tool or an agent. They can only be added to, with a date. AI may write routing text around them (names, summaries, read-when lines), but it doesn't change the text itself.
- Plain files, links, and paths known to code beat a cleverer retrieval layer (embeddings, a database, a server) until `cube bench` shows otherwise.

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

Setup looks for Codex and the Claude desktop app on the machine and around the running process. The tests pin what they see (`CUBE_CODEX=0`, `CUBE_CLAUDE_DESKTOP=0`, and the agents' session variables, in `vitest.config.ts`), so they pass the same on any machine and in any agent.

## Rules for fixtures

Test projects in `tests/fixtures/` are synthetic. Never copy a real project's files or content into this repo.

## Style

Match the code around you. Plain words in anything a person reads (CLI output, prompts, docs). Figures about tokens are estimates and say so; the stats never claim "savings".
