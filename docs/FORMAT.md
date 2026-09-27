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
    boxes/Y05.X003.json      per box: checksums, code fingerprints, sources, record marks
    retired.txt              id<TAB>date<TAB>reason, one per line
    aliases.txt              alias<TAB>coordinate, one per line
    approvals.log            one JSON line per invariant change, and per record a person replaced or deleted
    pending/                 proposed invariant edits awaiting approval
    archive/                 original source files, moved here word for word once the cube holds them
      .records/              records a person deleted (deleted/<id>-<name>/) or replaced (replaced/<id>/Z4-<time>.md)
  .tool/cube.mjs             the tool itself, so hooks and agents can run it; its second line declares its version
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
    rel: touches                 # touches | governed-by | implements | see-also | superseded-by
    note: why the link matters
scope: project-wide              # optional: what it covers (an invariant's scope; "project-wide" for history)
paths: ["src/ui/**"]             # rules only, optional: the rule loads with these files instead of every session
status: ok                       # ok | stale | needs-review | pending | open | superseded
source: HISTORY.md L331-L352     # where migrated text came from
written_by: ai                   # ai | person | migrated
---
```

Statuses: `stale` means code in Z2 changed since the box was last checked; `needs-review` means a code name it mentions no longer exists; `pending` is a new invariant waiting for a person's approval; `open` is the one history entry still collecting additions; `superseded` means a later decision replaced what a note, plan, or review says (it has a `superseded-by` link to what replaced it, when known, and a dated note at the end of Z4 saying what's true now). A rule whose `scope` starts with `superseded` is kept word for word but no longer loaded.

- **Superseded means replaced, never deleted.** The text stays as written. A superseded box routes nothing: it passes no invariants on to the files it names, it's listed last, and tools that check code leave its status alone. History entries and invariants aren't superseded (history is already a past record; an invariant changes by approval).

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

## Records

Migrated text, and the Z4 of every closed history entry, are **records**: what was actually written, including old details a summary would drop (why an approach failed, what not to try again). Invariant Z1 is handled by its own approval flow instead.

- Each record drawer has a **mark** in its box's state: `records: {"Z4": {"sha": …, "chars": …, "at": …}}`, the checksum and length of the text kept as the record. The drawer's own text must start with that text. A drawer is a record because it has a mark, so it stays one when its box moves to another row or its file goes missing. A tool gives a drawer its mark when it becomes a record: when migrated text is placed, and when a history entry closes.
- A record is never rewritten by an agent. Additions go below it under a dated label, `**Added YYYY-MM-DD:**`, and before any generated section. Adding changes nothing above the label, and leaves the mark alone. A migrated piece stored bare, as its drawer's only piece, is found at the start of the drawer; a piece wrapped in `cube:from` markers is found by its markers, whatever the state says. Where a later note disagrees with the text above it, the latest note is current.
- A person may replace a record on purpose, or delete a box that holds one. Each is logged in `.state/approvals.log` (`kind` `replace-record` or `delete-record`, with who, when, why, the source lines, and `kept`). The text taken out is kept first: a replaced drawer's text in `.state/archive/.records/replaced/<id>/Z<n>-<time>.md`, a deleted box's folder (with its state as `box-state.json`) in `.state/archive/.records/deleted/<id>-<name>/`. A replacement gives the drawer a new mark with `"replaced": true`.
- A check reports a record whose kept text is no longer at the start of its drawer, a record drawer whose file is gone, and a box that held a record whose folder is gone though its state remains (removed without the tool). It also compares each migrated piece from an archived source with the archive, unless a person replaced the drawer. Sources that aren't archived aren't compared, since their files may have changed.
- An agent adapter should block direct edits of a record's file and ask a person before a replacement or a deletion.

## Archived sources

Once a cube holds a source file's text word for word, the original may be archived: it moves, byte for byte, to `.state/archive/<path>` (without the always-loaded block, if the file held one), and a placeholder takes its place, between `<!-- context-cube:archived:start -->` and `<!-- context-cube:archived:end -->`, saying where the content went. An agent instruction file keeps the always-loaded block after its placeholder.

- A tool reading a source reads `.state/archive/<path>` when it exists, and otherwise the file in place without the placeholder and the always-loaded block. So coverage and rebuilds see the same text before and after archiving.
- Agents don't read the archive: `.ignore` keeps it out of code search, and an agent adapter should deny reading it.
- The archive's `.records/` folder isn't a source file's path: it holds records a person replaced or deleted (see Records), and a tool doesn't list or restore it as a source.
- Restoring moves the original back (keeping the always-loaded block) and removes it from the archive. Text found in a placeholder file outside its markers was added after archiving and isn't in the cube; a tool reports it and doesn't overwrite it.

## History dates

A history entry's date (in its state, shown in its past-record note) comes from, in order: the entry's own text (a date in its first line), the first commit whose message names the entry's key (such as "1.0.8 (6)"), the commit where the entry's first line first appeared in the project's markdown (it may have moved between files since), and only then the date of the entry before it in its file. The state's `dateFrom` says which (`text`, `commits`, `file`, `inferred`).

## Open history entries

One history entry at a time has `status: open`. Additions go in its `fragments/` folder, one file each, named by time and person (`2026-09-24T1512-jordan.md`; a second one in the same minute, `2026-09-24T1512.02-jordan.md`), so two people never edit the same file, and the names sort in the order they were written. The open entry's Z4 is a generated section built from its fragments; closing the entry makes them its Z4 for good.

## Invariant changes

Edits and deletions of approved invariant text wait in `.state/pending/<id>.json` until a person approves them. `.state/approvals.log` has one JSON line per decision: the change, who approved or rejected it, when, why, and whether a person reviewed it. Each box's state holds a checksum of its approved Z1, so a change made any other way can be detected.

## Merging

`context-cube/.gitattributes` keeps both sides' lines for the append-only files, and routes generated files, drawer files, and box state through merge drivers named `cube-generated`, `cube-drawer`, and `cube-state`; a tool registers them in each clone (Claude Code's adapter does it at the first session in a clone, so a teammate who only pulled has them). Box state merges field by field against the common ancestor: a field only one side changed keeps that change, nested objects merge the same way, and where both sides changed a field, the side with the later `updated` wins. A record's mark is taken whole from one side, never mixed. A drawer that one side only added to at the end (a dated note) gets that addition after the other side's text, even where a line-based merge would call it a conflict; when both sides only added, ours comes first. After a merge, duplicate numbers are resolved by renumbering the more recently added box and rewriting links that name it. The two boxes shared one state file, so a record mark that doesn't fit its box's text is dropped and set again from that text.

## Generated files

- **CUBE.md**: the reading protocol and the row list (id, name, type, root summary, when to open the row, box count, approximate size).
- **Row indexes** (`ROW.md`, `ROW-p2.md`, …): the root's summary and conventions, then one entry per box: id, name, summary, read-when line, the drawers present with approximate token sizes, link count, and status when not `ok`. History rows list newest first. Pages split at a token budget (default ~3,000 tokens); page 1 lists the other pages and the range each covers.
- **The always-loaded block**: written into the agent's instruction file at the project root (CLAUDE.md for Claude Code, AGENTS.md for others) between `<!-- context-cube:start -->` and `<!-- context-cube:end -->`. Nothing outside the markers is changed. It holds a short protocol, every rule without `paths`, and the row list. It is read at the start of every session, so it has a ceiling (`limits.blockTokens`, default ~3,000 tokens): above it, each row keeps only its name and when to open it, and `cube check` warns if it's still over, naming rules that could load with their files instead.
- **Path rules**: files an agent loads when it works with certain files (in Claude Code, `.claude/rules/cube-*.md` with `paths:`). One per approved invariant, listing the files it governs, in one line naming the invariant and where its Z1 is; and one per rule with `paths`. An invariant governs a file when its own text clearly names the file or its code, or when a current box that clearly does links to it (`governed-by`). "Clearly" is a weight: the file's path counts 3, a specific code name (`clockHandshake`, `peer_caps`) 2, a plain word (`decline`) 1, and a link needs 2. Only invariants get path rules; a note's summary never loads as one.

## Code links

Z2's code links come from code search, with no AI. A name the box's text mentions (in backticks, or shaped like code: `camelCase`, `snake_case`) links the box to the files that use it, if at most 8 files do. Comments, URLs, and import lines don't count as use, so a word in a comment ("out-of-band") or a URL ("apps.apple.com") links nothing. A plain word (`band`, `Calling`) counts only where the code clearly uses it as code: declares it, calls or labels it, reaches it as a member (`.subscribed`), or has it as a whole quoted string. Whether a name still exists, for `needs-review`, looks at comments too.

## Reading protocol

1. Follow every rule in the rules row (already loaded; a rule scoped to certain files loads when you work with them).
2. Use the row list to decide which rows could matter for the task.
3. Open the row index of each one. Start with page 1; open other pages only if needed.
4. Open drawers only as each box's read-when line says. Before editing a file, open Z1 for every invariant linked to it (`cube related <file>` lists them, with the boxes and history linked to the file).
5. Follow a link only when its note answers a question your task raises. Everything opened stays in the agent's context for the rest of the session.
6. History entries are past records. Where one disagrees with an invariant or the current code, the invariant and the code are current. Invariants marked as candidates aren't approved yet and aren't rules.
7. Notes moved in from plans, reviews, and handoffs (a row index marks a box whose source file's name says so as "dated") say what was meant or found when they were written; history after them and the code say what shipped. A box marked superseded was replaced, and its last note says what's current. An agent that finds a note later history or the code contradicts marks it superseded.
8. To search the memory, use `cube find <words>`, not a search of the whole project.
9. Create rows, boxes, and history entries only with the tool. Never pick coordinates yourself.
10. Never edit invariant text directly. Propose the change; a person approves it.
11. Text moved in from the original files, and closed history entries, are records: add to them (`cube write <id> Z4 --append`); never rewrite or shorten them. Notes added later are dated and come after the text; where one disagrees with the text above it, the latest note is current.

## Token estimates

All sizes are estimates: characters ÷ `tokens.charsPerToken` (default 4), rounded up.
