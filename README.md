# Context Cube

Context Cube turns a project's AI memory files (CLAUDE.md, a long HISTORY.md, an INVARIANTS.md, design notes) into a structured memory that AI coding agents read top-down: short summaries first, detail only when a task needs it.

## Why

Memory files grow until they hurt. A 5,000-line history file is either read in full at the start of every session, which spends a large share of the agent's context, or, more often, only its top is read and the older knowledge that matters gets missed.

Context Cube keeps all of it, word for word, but arranges it so an agent reads a one-line list of areas, opens the one or two areas its task touches, reads their summaries, and opens only the entries it needs. Rules that must never be broken find the agent on their own when it opens the code they govern.

## Quickstart (two minutes)

You need Node 20 or newer and [Claude Code](https://code.claude.com), logged in. In your project's folder, run:

```sh
npx context-cube
```

Until it's published to npm, run it straight from GitHub: `npx github:Spobi/context-cube`.

The setup:

1. looks for files that hold project memory and tells you, in plain words, what it found;
2. tells you roughly how much of your Claude plan's usage the AI steps will take, and waits for your yes;
3. shows the areas (rows) it proposes, for you to accept, redo, or edit;
4. builds the cube in `context-cube/`, and proves every line of your original files landed in it, word for word;
5. archives your original files (they move, unchanged, into a folder your agent doesn't read, since their content now lives in the cube; one command puts any back), asks before rewriting any of your rules, and finishes with a short summary of what happens from now on.

If your plan hits a usage limit partway, run the same command again after it resets; the build picks up where it stopped. Run it again later on a project that already has a cube, and it offers to update it instead of rebuilding.

A new project with no memory files yet gets an empty cube (rules, history, invariants) and a few questions to write its first rules. A project with code and git history but no memory files gets its history built from its commits and a set of candidate invariants, drafted from reverted and fix commits and code comments, for you to approve.

## What it makes

```
context-cube/
  CUBE.md                     how to read the cube, and the list of rows
  Y00-rules/                  instructions that always apply
  Y01-history/                what changed and why, oldest first (listed newest first)
  Y02-invariants/             rules that must never be broken
  Y03-…/                      your features, systems, and catalogs
    ROW.md                    the row index: one short entry per box
    X001-some-box/
      Z0-overview.md          what it is, and when to read it
      Z1-invariants.md        rules that hold for it
      Z2-code.md              the code it's about
      Z3-history.md           history entries that touched it
      Z4-detail.md            the full text
```

Every row (Y) holds boxes (X), and every box has the same five drawers (Z). Ids like `Y02.X007` never change or get reused. Your agent's instruction file (CLAUDE.md, or AGENTS.md for other agents) gets a short block with the rules and the list of rows; nothing else in that file is touched.

The whole format is in [docs/FORMAT.md](docs/FORMAT.md), so any tool can read or write a cube.

## Day to day

- **Reading:** every session starts with the rules and the row list. The agent opens rows and boxes as its task needs them. When it opens a file that invariants govern, a rule file loads and tells it which invariants to read first.
- **Routing without guesswork:** `node context-cube/.tool/cube.mjs related <file or code name>` lists, with no AI, the invariants to read before editing it, the boxes about it, and the history that touched it. `find <words>` searches the cube's text. The cube's own bookkeeping is kept out of ordinary code searches.
- **A ceiling on what loads every session:** the block in CLAUDE.md has a size limit (about 3,000 tokens by default). As the cube grows, the row list gets shorter, and `cube check` suggests rules that are only about certain files so they can load with those files instead (`cube edit <rule id> --paths "src/ui/**"`).
- **Updating:** after each commit, the agent is told which boxes are linked to what changed. It writes a short note, and a helper on a cheaper model files it in the open history entry and fixes what's out of date. You can also run `/cube-update` in Claude Code.
- **Staleness:** `node context-cube/.tool/cube.mjs status` finds boxes whose code changed, or whose code names no longer exist, without using any AI. A short notice at the start of each session lists those linked to recent work. Stale means "check this against the code," never "delete it": the text stays until someone decides it's wrong, and an invariant stays in force.
- **Past and present:** history entries are marked as past records. Where an old entry disagrees with an invariant or the current code, the agent is told the invariant and the code win.
- **Stats:** `node context-cube/.tool/cube.mjs stats` puts quality first: possible misses (code edited without reading the invariants that govern it) and boxes opened but possibly unused (nothing they name came up again, a sign their read-when line is too broad). Then it compares what the agent read with what reading the same areas in full would have taken, as a conservative estimate and an upper bound.

Inside a project, the agent runs the cube's commands with `node context-cube/.tool/cube.mjs <command>`; `--help` lists them. The tool copies itself into `context-cube/.tool/` so hooks and teammates need only Node.

## Your original files

Once the cube holds a file's text word for word, setup archives the original, so your agent doesn't read the same things twice. It doesn't ask, since nothing is lost and one command puts any file back; it tells you where the files went. Each original moves, unchanged, into `context-cube/.state/archive/`, and a short placeholder takes its place saying where the content went. Your agent is kept out of the archive: code search skips it, and in Claude Code reading it is denied. For CLAUDE.md or AGENTS.md, the placeholder is a short pointer, and the cube's always-loaded block stays in the file.

- **Get a file back:** `node context-cube/.tool/cube.mjs restore HISTORY.md` puts the original back exactly as it was (`--all` for every file). To look at an original without putting it back, `restore HISTORY.md --to ~/Desktop/originals` copies it there. Claude Code asks you before running a restore.
- **Archive again:** `node context-cube/.tool/cube.mjs archive` archives every original the cube was built from that isn't archived (for example, one you restored). It refuses a file whose current text the cube doesn't hold, so nothing can be hidden by accident.
- **Text added to an archived file** (say, a teammate on an older branch added to HISTORY.md) isn't in the cube; `cube check` points it out, and `restore` won't overwrite it.
- **Rebuilding from scratch:** run `uninstall`, then `restore --all`, then move `context-cube/` out of the way and run `npx context-cube` again. Don't delete `context-cube/` without restoring first: the archived originals live inside it.

A new project with no memory files has nothing to archive.

## Invariants need a person's approval

Invariant text can't be edited directly: the agent proposes a change (`propose edit`, `propose delete`, `propose new`), and a person approves it (`approve`) or rejects it (`reject`). Changes that weaken or remove a rule are flagged. A proposed new invariant (including the candidates a build drafts from git history) is visible to agents but labeled as a candidate, and nothing enforces it until a person approves it, so a wrong guess can't quietly become a rule. Every decision goes into `.state/approvals.log` with who, when, and why. Three layers enforce this: a hook that blocks direct edits and names the command to use instead, a git pre-commit check that catches edits made any other way, and `cube check`.

To turn approvals off, ask your agent to; it runs `cube config set invariants.approval auto`, and Claude Code asks you to confirm.

**To also require a GitHub review for invariant changes,** add a CODEOWNERS file and turn on "Require review from Code Owners" in your branch protection settings:

```
# .github/CODEOWNERS
/context-cube/Y02-invariants/  @your-github-user
/context-cube/.state/approvals.log  @your-github-user
```

## Teams

Commit `context-cube/` like any other folder (its `.logs/` stays on each person's machine). Merges are handled for you: generated files never block a merge, history additions go in separate files so two people never edit the same one, and if two branches both create box `Y05.X016`, the newer one is renumbered after the merge and every link to it is rewritten. GitHub isn't required; a local git repo works, and without git the cube still works as plain files.

## Other agents

Claude Code is supported first. For other agents, the cube writes an AGENTS.md block and works as plain files, without automatic logging, updating, or enforcement. The core knows nothing about any particular agent; support for another one is a small adapter.

## Privacy

Everything stays on your machine: the cube is plain files in your repo, and logs and stats are never sent anywhere. The only network use is your agent's own AI calls during the build and updates.

## Results

The A/B experiment (`cube bench`) runs the same tasks in two copies of a real project, one with its original memory files and one with the cube, and a person scores the changes blind, including a yes/no for each invariant a task must keep. Besides cost and scores, the report measures retrieval, so it can say why a copy did better or worse: whether the agent read each required invariant before its first edit, how many reads it took to find it, how much memory it read before editing, and how many boxes it opened for nothing. Results will be written up here once it has run.

## License

MIT. See [LICENSE](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
