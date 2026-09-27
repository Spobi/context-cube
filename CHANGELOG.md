# Changelog

To update a project, run `npx context-cube@latest` in it, then commit `context-cube/` so teammates get the same version.

## 0.2.6 (2026-09-26)

- **A teammate who pulls gets a working cube.** The cube's hooks now go in the shared, committed `.claude/settings.json` by default (`--personal` keeps them in your own settings; the read logger stays personal), and the first session in any clone registers the merge drivers and git hooks it needs, so merges renumber duplicate boxes and rebuild generated files there too. A hooks folder the project tracks (husky and the like) is left alone. Running setup again on a cube whose hooks are personal offers to share them, and moves them rather than running them twice.
- Setup's `--shared` (and now `--personal`) reach a build from existing files; before, only a fresh cube used them.

## 0.2.5 (2026-09-26)

- **The guard lets read-only commands through.** It treated any `>` in a command that named a protected file as a write, so `2>/dev/null`, `2>&1`, or output sent to `/tmp` blocked a plain read, and so did any `python3`. Now a redirect counts only when it points at a protected file, `cp` only when it copies into one, and a script only when it looks like it writes.
- **Nothing becomes an always-loaded rule without a person's say.** The build now asks about rules that are headed sections or long entries of a document that isn't agent instructions (a plan's sections, a runbook) even under the ceiling, and `cube new-box` in the rules row refuses a rule that would put the block over its ceiling (a person can raise it with `cube config set limits.blockTokens`).
- **`cube move` asks for a new read-when** (`--read-when`) when a rule, read "Always.", leaves the rules row, instead of leaving it to be fixed after.
- **`cube check` flags numbers in an AI-written summary that its box's text doesn't have** (a figure from a neighboring entry, a misread migration number).
- **History entries without their own date get one from git:** the first commit whose message names the entry, or else when its first line first appeared in the project's markdown. Before, they took a neighboring entry's date. Existing cubes get the new dates the next time code links are refreshed (`cube links`, or running setup again).

## 0.2.4 (2026-09-26)

- **`cube check` no longer calls an old alias broken when its box moved.** An alias like "4.1" pointing at a box that `cube move` renumbered still resolved (aliases chain), but the check looked only one step and warned.
- **Moving a rule out of the rules row points out its "Always." read-when line,** which in any other row would send agents to the box on every task; `cube check` warns about it too.

## 0.2.3 (2026-09-26)

- **A build catches up with files you edited while it was paused or waiting.** Before, adding a section to a file between a usage-limit pause and the rerun (or during the day, before a build set for the night) made the final coverage check fail, and setup stopped. Now new entries are brought in as boxes, like the rest, and everything after them in the file moves down to match, so the file still recombines exactly and is archived. A new entry that lands between the blank lines closing an entry is handled too. Other changes (text edited or removed, or lines added inside an entry) are reported: the cube keeps that file as the build read it, and the file stays in place, not archived.

## 0.2.2 (2026-09-26)

From reviewing the first real cube (a large iOS app), and the build that made it:

- **Running setup again after a usage limit finishes the build.** Before, once boxes were placed, a second run took the cube as finished and only "updated" it: it installed the always-loaded block and hooks around a half-built cube, and never rewrote the rules that point at the original files or archived them, so the old files and the cube both stayed in use.
- **The estimate is calibrated on a real build.** It said ~900,000 tokens for a build that used about 2 million. Most of the cost is fixed per AI call (the list of boxes a summary may link to, and output read back), which the estimate now counts; it came within about 10% of each step. It also counts entries from headings, no longer counts a file with several kinds of content once per kind, and drops a "row roots and link notes" line that no AI step matched.
- **Code search ignores prose.** Comments, URLs, and import lines no longer count as code, so a box isn't tied to a file by a word in a comment ("out-of-band", "head-of-line") or a URL ("apps.apple.com"). A plain word (`band`, `Calling`) counts only where the code uses it as code. Updating a cube re-links its boxes this way, keeping each file's fingerprint so changes still show as stale.
- **Path rules name only invariants, one line each.** Before, any box with code and an invariant link got a rule that quoted its own summary, so an old plan's "this must stay" loaded with a file whose code was gone; a central file loaded dozens of them. Now each approved invariant has one rule listing the files it clearly governs (by the file's name, a specific code name, or a box that clearly covers the file).
- **`cube related` puts the clearest links first** and lists links made by only a plain word or two apart.
- **Superseded notes.** `cube supersede <id> --by <entry> --note "..."` marks a note, plan, or review that a later decision replaced: its text stays, a dated note says what's current, it's labeled in the row index and in `related`, and it no longer points agents at invariants. Agents are told to mark one when they find it. The row index also marks boxes from files named like plans, reviews, or handoffs as "dated".
- **Rules from plans and runbooks.** When the rules would go over the always-loaded ceiling, the build offers to file the ones from files that aren't agent instructions with the notes, in the rows they're about. `cube check` names such rules in an existing cube.
- **Rewritten rules say what replaces updating a file** (`cube history add`, `cube propose`), and "**Read `HISTORY.md`** (repo root)" no longer keeps its "(repo root)".
- **`cube check` warns when `context-cube/` isn't committed** to git, and setup's summary says to commit it now.

- **The estimate is split by model.** Before the build spends usage, it shows how many tokens each model will take (Haiku, Sonnet, Opus) and which steps use it, then the same by step. On the default preset only the row proposal uses Opus. The first question, before classifying files, names the model too, and the summary at the end reports what was used by model.
- **Run the big part later.** At the estimate, answer `later` and give a time (or pass `--at 23:30` to setup or `cube build`). The steps before the row review run now; the rest starts on its own at that time, for example overnight after your plan's usage resets. The terminal waits (on a Mac, the computer is kept from sleeping on its own), questions while you're away get their defaults, and a usage limit overnight means waiting for the reset and carrying on, starting nothing new more than 8 hours after the chosen time.
- Usage limit messages worded "You've hit your limit · resets 4am" are recognized as limits, so the build pauses instead of retrying on a bigger model.
- After a usage limit, calls already in flight finish and are saved before the build pauses, instead of carrying on in the background.
- A build that resumes after a usage limit no longer makes its history-from-git entries a second time.
- `cube build --preset`, `--yes`, and `--at` now reach the build. Before, setup's options of the same names took them, so `cube build --preset max` built with the default preset.

## 0.2.1 (2026-09-26)

- **Every record is checked, not only text from archived files.** A history entry closed after setup was never checked, so it could be rewritten or its file removed without a warning. Now each record carries a mark in its box's state, set when it becomes a record, and `cube check` reports a record whose text changed, whose file is gone, or whose folder is gone. A record stays one when its box moves to another row or its file goes missing. Cubes from 0.2.0 get their marks the next time the tool indexes them.
- **Adding a note can't hide an earlier change.** Before, `write --append` re-recorded the whole drawer, so a note added after an unapproved rewrite made the warning go away. Now a note is a pure addition: the mark still covers the text above it, the warning stays until a person records or undoes the change, and the command says so.
- **Deleting or replacing a record keeps what it took out,** in `.state/archive/.records/` (Claude doesn't read the archive), and the message says where. Before, it said "git history still has its text," which isn't true in a project without git or for an entry not committed yet. An approved invariant deletion is kept the same way.
- **The delete guard checks every `cube delete` in a command,** wherever its options are. Before, it looked only at the first one, and a `--reason` that named another box could hide the one being deleted.
- **Merges keep notes without asking you.** A person's correction on one branch and a note added on another no longer produce a false warning, two notes added to the same box on two branches merge without a conflict, and two history entries closed on two branches (they share a number until the merge renumbers one) each keep their own mark.
- **Updates check the code once.** The update plan and the cube-updater now finish with one `cube ok` for every box, instead of one per box (each one re-reads the project's code).
- History fragments written by one person in the same minute now stay in the order they were written.

## 0.2.0 (2026-09-26)

- **Old text stays as written.** Text moved in from your files, and closed history entries, can't be rewritten by an agent. `cube write <id> Z4 --append` adds a dated note below them instead, and the cube-updater helper now does that after commits instead of rewriting a box's detail. A person can change one on purpose with `cube replace` or remove one with `cube delete --reason`; both ask you to confirm in Claude Code and are logged. `cube check` compares this text with your archived originals and flags any that changed some other way.
- **History summaries stick to what the entry says.** They give a reason only when the entry states one, and keep the reason when an entry records a failure, a revert, or something not to try again. Cubes built earlier keep their summaries; fix one with `cube edit <id> --summary "..."`.
- **`cube related` says how it found each box:** the code name it matched, the commit that changed the file, or the box it was reached through.
- **Team merges keep both sides' bookkeeping.** Before, when two branches both changed a box's state file, the merge kept only the newer one, so an invariant approval made on one branch could be lost and the pre-commit check would then block commits.
- **Updating works.** Running setup again on a project now updates the project's copy of the tool (`context-cube/.tool/cube.mjs`); before, it reinstalled hooks but kept the old copy. An older version refuses to run against a project set up with a newer one, and won't replace its copy.

## 0.1.0 (2026-09-26)

First release.
