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
2. tells you roughly how much of your Claude plan's usage the AI steps will take, split by model, and waits for your yes (or for a later start time, if you'd rather it ran overnight);
3. shows the areas (rows) it proposes, for you to accept, redo, or edit (and, if rules from files that aren't agent instructions, like a plan or a runbook, would crowd every session, offers to file those with the notes instead);
4. builds the cube in `context-cube/`, and proves every line of your original files landed in it, word for word;
5. archives your original files (they move, unchanged, into a folder your agent doesn't read, since their content now lives in the cube; one command puts any back), asks before rewriting any of your rules, and finishes with a short summary of what happens from now on.

If your plan hits a usage limit partway, run the same command again after it resets; the build picks up where it stopped. Keep working in the meantime: new entries added to a file since the build read it (a new history section, say) are brought in when it continues; any other change to a file leaves that file as the build read it, and out of the archive. Run it again later on a project that already has a cube, and it offers to update it instead of rebuilding.

### How much usage it takes, and running it overnight

Before it spends anything beyond a small first look at your files, setup shows its estimate by model, since a token of Haiku uses up a plan's limits more slowly than a token of Opus:

```
The AI steps will use roughly 1,800,000 tokens of your plan's usage (an estimate). By model:
  Haiku (smallest)   ~1,100,000  history summaries
  Sonnet (mid-size)    ~650,000  recipe, invariant labels, other overviews
  Opus (largest)        ~64,000  row structure
```

That's a large project: 20 files with 7,600 lines of history and 2,150 of invariants. Most of it goes to Haiku and Sonnet; on the default preset only the row proposal uses Opus, and `--preset economy` uses no Opus at all. The estimate is calibrated on a real build like that one, where it came within about 10% of each step's actual use. Much of the cost is fixed per AI call (several thousand tokens each, whatever the text), so a small project costs relatively more per line than a big one.

If that's more than you want to spend now, answer `later` and give a time, such as just after your usage resets (`/usage` in Claude Code shows when). The steps before your row review run right away, since you review the rows; everything after them, which is most of the usage, starts on its own at that time. You can also pass the time up front: `npx context-cube --at 23:30` (or `cube build --at 11:30pm`).

- The terminal waits until then, so leave it open and leave the computer on and plugged in, with the lid open: nothing runs while the computer sleeps. On a Mac, it's kept from going to sleep on its own while it waits and works.
- A question that comes up while you're away gets its default answer, printed in the terminal. The spot check at the end waits for you.
- If your plan hits its limit overnight, it waits for the reset and keeps going, but starts nothing new more than 8 hours after the time you picked. If the computer slept through the start time and wakes more than an hour late, it asks before starting.
- Ctrl+C cancels. The build keeps its place, so running the command again finishes it (now, or with `--at` to wait again).

Nothing is added to your system's scheduler; the waiting is done by the command itself.

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
- **Routing without guesswork:** `node context-cube/.tool/cube.mjs related <file or code name>` lists, with no AI, the invariants to read before editing it, the boxes about it, and the history that touched it, each with how it was found (the code name it matched, the commit that changed the file, or the box it was reached through), most clearly linked first. Code search skips comments, URLs, and imports, and a plain word (`band`, `head`) counts only where the code uses it as code, so prose doesn't tie a box to a file; anything linked only by a plain word or two is listed apart. `find <words>` searches the cube's text. The cube's own bookkeeping is kept out of ordinary code searches.
- **A ceiling on what loads every session:** the block in CLAUDE.md has a size limit (about 3,000 tokens by default). As the cube grows, the row list gets shorter, and `cube check` suggests rules that are only about certain files so they can load with those files instead (`cube edit <rule id> --paths "src/ui/**"`), and names rules that came from files that aren't agent instructions, which are often plans or procedures (`cube move <id> <row>` files one with the row it's about). When an agent opens a file, a one-line rule loads for each invariant that governs it.
- **Updating:** after each commit, the agent is told which boxes are linked to what changed. It writes a short note, and a helper on a cheaper model files it in the open history entry and adds what changed, dated, to the boxes it made out of date, without rewriting what's there. You can also run `/cube-update` in Claude Code.
- **Staleness:** `node context-cube/.tool/cube.mjs status` finds boxes whose code changed, or whose code names no longer exist, without using any AI. A short notice at the start of each session lists those linked to recent work. Stale means "check this against the code," never "delete it": the text stays until someone decides it's wrong, and an invariant stays in force.
- **Past and present:** history entries are marked as past records. Where an old entry disagrees with an invariant or the current code, the agent is told the invariant and the code win. Notes moved in from plans, reviews, and handoffs are treated the same way: the row index marks a box from a file named like one as "dated", and the agent is told that history after it and the code say what shipped. When a later decision replaced what a note says, `cube supersede <id> --by <history entry> --note "<what's true now>"` marks it: the text stays, a dated note says what's current, and the box stops pointing agents at invariants. Agents are told to do this when they find one.
- **Stats:** `node context-cube/.tool/cube.mjs stats` puts quality first: possible misses (code edited without reading the invariants that govern it) and boxes opened but possibly unused (nothing they name came up again, a sign their read-when line is too broad). Then it compares what the agent read with what reading the same areas in full would have taken, as a conservative estimate and an upper bound.

Inside a project, the agent runs the cube's commands with `node context-cube/.tool/cube.mjs <command>`; `--help` lists them. The tool copies itself into `context-cube/.tool/` so hooks and teammates need only Node.

## Your original files

Once the cube holds a file's text word for word, setup archives the original, so your agent doesn't read the same things twice. It doesn't ask, since nothing is lost and one command puts any file back; it tells you where the files went. Each original moves, unchanged, into `context-cube/.state/archive/`, and a short placeholder takes its place saying where the content went. Your agent is kept out of the archive: code search skips it, and in Claude Code reading it is denied. For CLAUDE.md or AGENTS.md, the placeholder is a short pointer, and the cube's always-loaded block stays in the file.

- **Get a file back:** `node context-cube/.tool/cube.mjs restore HISTORY.md` puts the original back exactly as it was (`--all` for every file). To look at an original without putting it back, `restore HISTORY.md --to ~/Desktop/originals` copies it there. Claude Code asks you before running a restore.
- **Archive again:** `node context-cube/.tool/cube.mjs archive` archives every original the cube was built from that isn't archived (for example, one you restored). It refuses a file whose current text the cube doesn't hold, so nothing can be hidden by accident.
- **Text added to an archived file** (say, a teammate on an older branch added to HISTORY.md) isn't in the cube; `cube check` points it out, and `restore` won't overwrite it.
- **Rebuilding from scratch:** run `uninstall`, then `restore --all`, then move `context-cube/` out of the way and run `npx context-cube` again. Don't delete `context-cube/` without restoring first: the archived originals live inside it.

A new project with no memory files has nothing to archive.

## Old text stays as written

The text moved in from your files, and every closed history entry, is kept as it was written. The odd old details are the point: "we tried this a year ago and it failed because of X" is what a rewrite or a summary would shorten to "the previous approach failed." So agents never rewrite that text. When it's out of date, they add a dated note below it (`cube write <id> Z4 --append`) that says what's true now, and keep the box's one-line summary current, since that's what agents read first. Direct edits to its files are blocked.

A person can still change it on purpose. `cube replace <id> <drawer> @<file> --reason "..."` replaces the text (for example, to fold a pile of notes into one clean version), and `cube delete <id> --reason "..."` removes a box that holds it. Both ask you to confirm in Claude Code, both go in `.state/approvals.log`, and the text they take out is kept in `.state/archive/.records/`, where Claude doesn't read it but you can copy it back. `cube check` points out any of this text that changed some other way, including a file that went missing, and says where the earlier text can come from: your archived originals, or git if it was committed. If you edited it yourself and meant to, `cube replace <id> <drawer> --reason "..."` with no text records that.

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

Commit `context-cube/` like any other folder (its `.logs/` stays on each person's machine); `cube check` warns while it isn't committed, since until then the cube and any originals archived in it exist only on one machine. Merges are handled for you: generated files never block a merge, history additions go in separate files so two people never edit the same one, each box's bookkeeping merges field by field (so an approval on one branch survives another branch's later changes to the same box), and if two branches both create box `Y05.X016`, the newer one is renumbered after the merge and every link to it is rewritten. `context-cube/.tool/cube.mjs` is the program your hooks run, so review a change to it like any code change; it should only change when someone updates Context Cube. GitHub isn't required; a local git repo works, and without git the cube still works as plain files.

## Other agents

Claude Code is supported first. For other agents, the cube writes an AGENTS.md block and works as plain files, without automatic logging, updating, or enforcement. The core knows nothing about any particular agent; support for another one is a small adapter.

## Updating

Run `npx context-cube@latest` in the project (before it's on npm: `npx github:Spobi/context-cube`). It updates the project's copy of the tool, its hooks, and its rules, and leaves your cube's content as it is. Then commit `context-cube/` so teammates run the same version. The `@latest` matters: without it, npx may reuse a copy it cached earlier. An older version won't run against a project set up with a newer one; it says so and names the command to use instead. [CHANGELOG.md](CHANGELOG.md) lists what each version changed.

## Privacy

Everything stays on your machine: the cube is plain files in your repo, and logs and stats are never sent anywhere. The only network use is your agent's own AI calls during the build and updates. Context Cube doesn't check for new versions over the network; see Updating.

## Results

The A/B experiment (`cube bench`) runs the same tasks in two copies of a real project, one with its original memory files and one with the cube, and a person scores the changes blind, including a yes/no for each invariant a task must keep. Besides cost and scores, the report measures retrieval, so it can say why a copy did better or worse: whether the agent read each required invariant before its first edit, how many reads it took to find it, how much memory it read before editing, and how many boxes it opened for nothing. Results will be written up here once it has run.

## License

MIT. See [LICENSE](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
