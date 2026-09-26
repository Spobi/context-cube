# The Context Cube format

Version 1. This document is the whole format, so any tool can read or write a cube without using this implementation.

A cube is a project memory made of plain markdown files in a folder named `context-cube/` at the project root (the git root, or the project folder when there is no git). Agents read it top-down: a list of rows first, then one row's index, then only the drawers a task needs.

## Coordinates

| Axis | Form | Meaning |
|---|---|---|
| Row (Y) | `Y` + 2 digits, `Y00`–`Y99` | One area of the project. `Y00` is always the rules row. |
| Box (X) | `X` + 3 digits, `X000`–`X999` | One item in a row. `X000` is the row's root. When a row passes 999, every box number in it is padded to 4 digits. |
| Drawer (Z) | `Z` + 1 digit, `Z0`–`Z4` | One kind of content, the same in every box. |

- A box id is `Y05.X003`; a drawer id is `Y05.X003.Z1`. Numbers compare numerically: `X001` and `X0001` are the same box.
- Every row and box also has a **name**: 1–5 lowercase words joined by hyphens. The coordinate is the identity; the name is a label and may change.
- Numbers are assigned by the tool, in order, and never reused. Deleted or moved numbers are listed in `.state/retired.txt`. Gaps are normal.
- History rows number forward in time: the oldest entry is `X001`.

## Folder layout

```
context-cube/
  CUBE.md                    generated: reading protocol + the row list
  cube.config.json           settings
  recipe.json                how the project's source files are structured (optional)
  Y00-rules/
    ROW.md                   generated row index (page 1)
    ROW-p2.md                generated, when the index is paged
    X000-root/Z0-overview.md
    X001-some-rule/Z0-overview.md
  Y01-history/
    X075-build-1-0-9/
      Z0-overview.md
      fragments/             additions to an open history entry, one file each
  .state/                    tool-owned, committed
    boxes/Y05.X003.json      per box: checksums, code fingerprints, sources
    retired.txt              id<TAB>date<TAB>reason, one per line
    aliases.txt              alias<TAB>coordinate, one per line
    approvals.log            one JSON line per invariant change
    pending/                 proposed invariant edits awaiting approval
    archive/                 original source files, moved here word for word once the cube holds them
  .tool/cube.mjs             the tool itself, so hooks and agents can run it
  .logs/                     per person, not committed
  .ignore                    keeps .state/, .tool/, and .logs/ out of ripgrep-based code searches
```

- Row folders are `Y<nn>-<name>`; box folders are `X<nnn>-<name>`. The root box folder is always `X000-root`.
- Drawer files are always `Z0-overview.md`, `Z1-invariants.md`, `Z2-code.md`, `Z3-history.md`, `Z4-detail.md`. Only Z0 is required.

## Drawers

| Drawer | Contains |
|---|---|
| Z0 Overview | A header block (below), then what this is in at most ~80 words |
| Z1 Invariants | Rules that must hold, and why, or links to where they live |
| Z2 Code | Files and code names this box is about, one line each |
| Z3 History | Links to relevant history entries, one line each |
| Z4 Detail | The full explanation or the full original text |

What one box is depends on the row type:

| Row type | One box is | Notes |
|---|---|---|
| `rules` | one instruction | Z0's body is the rule as written. Every rule is copied into the always-loaded block, unless its header has `paths`: then it loads only with matching files. |
| `history` | one entry (a build, release, PR, day, commit, or session) | Z4 is the full entry, word for word. Z2 lists files and commits changed. |
| `invariants` | one topic | Z1 is the invariant text, word for word. Changing it needs a person's approval. |
| `feature` | one component of a user-facing feature | |
| `system` | one part of a cross-cutting system | |
| `catalog` | one item in a list (an event, a flag, a table) | |
| `custom` | anything | |

## The header block

Every Z0 begins with YAML between `---` lines:

```yaml
---
id: Y01.X071
name: take-out-resolution-lift
summary: One line saying what this is.
read_when: When an agent should open this box. Required.
links:
  - to: Y05.X004
    name: video-quality          # the target's current name; kept in sync by the tool
    rel: touches                 # touches | governed-by | implements | see-also
    note: why the link matters
scope: project-wide              # optional: what it covers (an invariant's scope; "project-wide" for history)
paths: ["src/ui/**"]             # rules only, optional: the rule loads with these files instead of every session
status: ok                       # ok | stale | needs-review | pending | open
source: HISTORY.md L331-L352     # where migrated text came from
written_by: ai                   # ai | person | migrated
---
```

Statuses: `stale` means code in Z2 changed since the box was last checked; `needs-review` means a code name it mentions no longer exists; `pending` is a new invariant waiting for a person's approval; `open` is the one history entry still collecting additions. A rule whose `scope` starts with `superseded` is kept word for word but no longer loaded.

- **Stale means check, never delete.** A changed file says something changed, not that the box is wrong. Tools mark the box and tell agents to check it against the code; they never rewrite or drop its text because of the mark. An invariant stays in force while stale: the check is whether the code still follows it.
- **Pending means candidate, not rule.** A pending invariant is shown to agents, labeled as not approved, but nothing enforces it: it gets no path rule, it doesn't count toward "possible misses", and backlinks to it are labeled. Approval makes it a rule.
- **The read-when line is a routing instruction.** It decides whether an agent opens the box, so it names the changes, files, or symptoms that need the box ("Before changing replay order or reconnect handling in src/sync/queue.ts, or when edits arrive out of order"), not a topic ("Working on sync"). `cube check` warns about vague ones.

Root boxes (`X000`) add `row_type` (one of the row types above) and `conventions` (a list of row-wide conventions, such as "newest first").

Sizes, fingerprints, and checksums are never in the header; they live in `.state/`.

## Links

- **Header links** are the graph: a target, the target's name, a relationship, and a note saying why an agent would follow it. Keep them few: every link is a possible read. `cube check` warns about a link without a note, and about a box with more than `limits.links` links (default 8). History entries are exempt: their links record what they touched.
- **Inline references** in any drawer's text look like `[[Y05.X004]]`, `[[Y05.X004.Z1]]`, or `[[Y05]]`.
- **Aliases** map legacy references ("§21", "1.0.8 (10)") and old coordinates to current ones.
- **Generated sections** hold backlinks. They sit at the end of a drawer between `<!-- cube:generated:start -->` and `<!-- cube:generated:end -->`, preceded by one blank line that belongs to the section. Only the tool writes them:
  - Z1 of a box outside the invariants rows lists the invariants boxes its header links to.
  - Z3 of a box outside the history rows lists the history entries whose headers link to it.
  - Z2 lists the code files and names the box's text mentions (found by code search), or for a history entry, the commits whose message names it.
  - Z1 of a pending invariant carries a label saying it's a candidate, not a rule.
  - Z4 of a closed history entry ends with a note that it is a past record: where it disagrees with an invariant or the current code, those are current.

## Migrated text

Text moved from existing files is kept word for word: history entries in Z4, invariants in Z1, rules as the Z0 body, other notes in Z4. Text between entries (a file's introduction, section headings above a list) goes to the row root's Z4, each piece wrapped as `<!-- cube:from FILE Lx-Ly -->` … `<!-- cube:end-from -->`. Each box's `.state/boxes/<id>.json` records which lines of which file it holds, so the pieces can be put back together to reproduce each original file exactly.

## Archived sources

Once a cube holds a source file's text word for word, the original may be archived: it moves, byte for byte, to `.state/archive/<path>` (without the always-loaded block, if the file held one), and a placeholder takes its place, between `<!-- context-cube:archived:start -->` and `<!-- context-cube:archived:end -->`, saying where the content went. An agent instruction file keeps the always-loaded block after its placeholder.

- A tool reading a source reads `.state/archive/<path>` when it exists, and otherwise the file in place without the placeholder and the always-loaded block. So coverage and rebuilds see the same text before and after archiving.
- Agents don't read the archive: `.ignore` keeps it out of code search, and an agent adapter should deny reading it.
- Restoring moves the original back (keeping the always-loaded block) and removes it from the archive. Text found in a placeholder file outside its markers was added after archiving and isn't in the cube; a tool reports it and doesn't overwrite it.

## Open history entries

One history entry at a time has `status: open`. Additions go in its `fragments/` folder, one file each, named by time and person (`2026-09-24T1512-jordan.md`), so two people never edit the same file. The open entry's Z4 is a generated section built from its fragments; closing the entry makes them its Z4 for good.

## Invariant changes

Edits and deletions of approved invariant text wait in `.state/pending/<id>.json` until a person approves them. `.state/approvals.log` has one JSON line per decision: the change, who approved or rejected it, when, why, and whether a person reviewed it. Each box's state holds a checksum of its approved Z1, so a change made any other way can be detected.

## Merging

`context-cube/.gitattributes` keeps both sides' lines for the append-only files, and routes generated files, drawer files, and box state through merge drivers named `cube-generated`, `cube-drawer`, and `cube-state`; a tool registers them in each clone. After a merge, duplicate numbers are resolved by renumbering the more recently added box and rewriting links that name it.

## Generated files

- **CUBE.md**: the reading protocol and the row list (id, name, type, root summary, when to open the row, box count, approximate size).
- **Row indexes** (`ROW.md`, `ROW-p2.md`, …): the root's summary and conventions, then one entry per box: id, name, summary, read-when line, the drawers present with approximate token sizes, link count, and status when not `ok`. History rows list newest first. Pages split at a token budget (default ~3,000 tokens); page 1 lists the other pages and the range each covers.
- **The always-loaded block**: written into the agent's instruction file at the project root (CLAUDE.md for Claude Code, AGENTS.md for others) between `<!-- context-cube:start -->` and `<!-- context-cube:end -->`. Nothing outside the markers is changed. It holds a short protocol, every rule without `paths`, and the row list. It is read at the start of every session, so it has a ceiling (`limits.blockTokens`, default ~3,000 tokens): above it, each row keeps only its name and when to open it, and `cube check` warns if it's still over, naming rules that could load with their files instead.
- **Path rules**: files an agent loads when it works with certain files (in Claude Code, `.claude/rules/cube-*.md` with `paths:`). One per box that has code in Z2 and approved invariants (its own, or linked), naming the invariants to open first; and one per rule with `paths`.

## Reading protocol

1. Follow every rule in the rules row (already loaded; a rule scoped to certain files loads when you work with them).
2. Use the row list to decide which rows could matter for the task.
3. Open the row index of each one. Start with page 1; open other pages only if needed.
4. Open drawers only as each box's read-when line says. Before editing a file, open Z1 for every invariant linked to it (`cube related <file>` lists them, with the boxes and history linked to the file).
5. Follow a link only when its note answers a question your task raises. Everything opened stays in the agent's context for the rest of the session.
6. History entries are past records. Where one disagrees with an invariant or the current code, the invariant and the code are current. Invariants marked as candidates aren't approved yet and aren't rules.
7. To search the memory, use `cube find <words>`, not a search of the whole project.
8. Create rows, boxes, and history entries only with the tool. Never pick coordinates yourself.
9. Never edit invariant text directly. Propose the change; a person approves it.

## Token estimates

All sizes are estimates: characters ÷ `tokens.charsPerToken` (default 4), rounded up.
