# Changelog

To update a project, run `npx context-cube@latest` in it, then commit `context-cube/` so teammates get the same version.

## 0.3.5 (2026-09-28)

- **Invariants are read before the edits they're about.** The one-line path rules only remind: on Quickie, an agent opened `CallManager.swift`, got 19 of them, and changed four call-engine files without opening one. `cube stats` counted 5 possible misses. Now the guard checks each edit (Claude Code's edit tools, Codex's patches). An edit near code an invariant is about is held back until the agent has opened that invariant in this session, with a list of what to read and about how many tokens it is. "Near" is what already made a box stale in 0.3.3: a changed line, or the lines around it, names the invariant's code, or the edit is inside a function or type it names. A write that replaces a whole file needs every invariant that governs it. Replayed on the commit behind that session, the check asks for 11 of the 23 invariants that govern the files it changed (about 14,000 tokens). An edit to `connectSignaling` needs 3 of the 20 on `CallManager.swift`.
- **Every invariant, where you choose.** `cube config set invariants.readAllFor "<globs>"` makes the check ask for all the invariants that govern those files before any edit there, for code where every rule matters on every change (Quickie's call path, say). `invariants.readFirst` is `near` (the default), `all`, or `off`; with `off`, it still covers the `readAllFor` files.
- **Compacting the context counts.** Invariants opened before Claude Code compacts the conversation have to be opened again before the next edit near them.
- **It can't stop the work.** One invariant holds edits back at most twice a session; after that, the edit goes ahead and `cube stats` counts a possible miss. Where the check ran, stats count its misses instead of "every invariant that governs the file". The guard keeps what the agent opened in an append-only file per session, so reading several invariants at once loses none. The check waits until the guard has seen the session's reads, so a project whose hooks predate it isn't held up. Edits made through shell commands aren't checked.
- In Claude Code, the guard's hooks now also run after reads and at session start. Run setup again (or `cube install`) to update the hooks.

## 0.3.4 (2026-09-28)

- **Questions pop up in Claude Code.** When Claude runs setup, a question that needs you used to come back as text, and Claude typed it into the chat. Now it comes ready for Claude Code's question box (AskUserQuestion): a short header, the answers to pick with what each one does, and "Other" to type your own. Questions answered by typing offer common answers to pick (11:30pm for the start time, "All look right" for the spot check, fewer or more rows), with "Other" for anything else. The tool marks an answer "(Recommended)" only where it advises one, never one that spends usage. Codex and other agents get the question as before.
- **Proposed invariant changes are asked about right away.** `propose` (and `new-box` in the invariants row) used to print only the command a person could run, so a proposal could sit unnoticed until someone ran `cube pending`. In Claude Code, it now ends by asking you in the question box: Approve, Reject, or Decide later, with the proposed text and why beside the choices. `cube pending` asks about up to four at a time, weakenings first, then oldest first.
- **Approving still takes your yes on the command.** Picking Approve runs `cube approve`, and Claude Code asks you to confirm it, even in auto mode. That confirmation is the approval: the question box's answer passes through the agent, but the confirmation can't. The confirmation now names what it approves ("Approving the new invariant Y02.X033 "…" (P-…) needs a person to confirm.").
- **Changes still waiting come up once a session.** The session-start notice lists pending invariant changes and has the agent offer, once, at a break in the work, to go through them. Setup's summary says how many candidates the build drafted for your review.

## 0.3.3 (2026-09-27)

- **Invariants load on the files they're about, not on every file near them.** An invariant used to govern every file of every box that linked to it, so on Quickie the deaf-channel invariant loaded as "a rule that must never be broken" on 81 files, `Theme.swift` and `StatsService.swift` among them, and opening `CallManager.swift` loaded 21 rules. Now an invariant governs only the files its own text points to, at most 12 of them, clearest first; only an invariant whose text names no code borrows the files of the boxes that link to it. `cube related` and Codex's rule notices follow the same rule. On Quickie, the deaf-channel invariant's path rule went from 81 files to 8, and invariant-to-file pairs from 998 to 233.
- **Code links count a name where it's defined.** A code name found in up to 8 files linked a box to the first 3 of them, in whatever order the files were listed. Now a name found in 1 to 3 files links all of them, but counts fully only in the file that defines it (`func verifyEcho`, `struct AppInfo`) or in its only file; elsewhere it shows as "used at line N" and counts like a plain word. A name found in more files links only the file that defines it. So one mention of a shared type or a platform API (`timeoutInterval`) no longer ties a box to every file that uses it.
- **A box is stale only when a change is near what it mentions.** Staleness compared whole files, so any edit anywhere in a file flagged every box linked to it: Quickie's friend-request commit changed 6 files and flagged 40 boxes. Now git finds the version of the file the box last saw, and the box is flagged only if the change is in, or a few lines from, a line naming its code, or inside a function or type it names ("changed near `verifyEcho`"). The same commit now flags 6. A plain word counts only on a changed line. Without git, or when git doesn't have that version, any change still counts. A commit's update plan lists boxes the same way.
- **`cube status` only reports.** The session notice tells agents to run it, and it wrote stale marks into about 100 files that then rode along in the next commit. Now it changes nothing unless you pass `--mark`, which also sets boxes back to ok when what made them stale is gone. `cube links` keeps the fingerprints of files already linked, so re-linking no longer marks every box as checked.
- **A possible miss means the invariant wasn't opened.** `cube stats` counted an invariant as seen when its one-line path rule loaded, but in Claude Code a file is read before it's edited and reading it loads the rule, so nothing could count as a miss. Now a miss is an invariant whose text wasn't opened before the first edit of a file it governs.
- **A plain word that's gone from the code no longer flags a box for review.** It may only ever have been prose.

To bring an existing cube's links up to date, run setup again (`npx context-cube@latest`) or `node context-cube/.tool/cube.mjs links` after updating, and commit the result.

## 0.3.2 (2026-09-27)

- **The guard judges writers where commands start.** It looked for the name of a writing command (`rm`, `mv`, `install`, …) anywhere in a command that named a protected path, so `find context-cube/.state/install …` (a folder named `install`) or `grep "rm" context-cube/.state` was blocked as a write. Now it checks the program each command runs, including inside `sh -c`, `xargs`, and `find -exec`, and counts `find -delete`. A command too complex to read (a subshell, say) is still judged the old way. The guard also now covers the `.state` and `.tool` folders named without a trailing slash (`rm -rf context-cube/.state` got through before).
- **Code search leaves agents' settings out.** `.claude/`, `.codex/`, `.agents/` and the like hold agent configuration, not project code, but a box could be linked to `.claude/settings.json` by a word like "permissions", and then every commit that changed the settings named that box in its update plan. Running setup again (or `cube links`) re-links an existing cube without them; until then, update plans ignore them.

## 0.3.1 (2026-09-27)

- **Running setup again offers the rule rewrites a build couldn't ask about.** A build run without a terminal and without `--yes` archived the original files but left rules like "Update `HISTORY.md`" as they were, so agents got that rule and a placeholder in `HISTORY.md` saying to add to the cube instead. Now updating an existing cube finds rules that still point at archived files and offers to rewrite them to point at the cube (the original words are kept, no longer loaded). It needs your yes, as before.

## 0.3.0 (2026-09-27)

- **Codex reads the cube.** Codex gets the always-loaded block in `AGENTS.md` and its own hooks in `.codex/hooks.json`: the guard (it reads which files an `apply_patch` changes, so invariant text and the cube's bookkeeping are protected as in Claude Code), the session notice, and update requests. Codex has no path-scoped rule files, so the guard tells the agent which invariants govern a file before it edits it or after it prints it through the shell. Commands that need a person get Codex command rules (`.codex/rules/context-cube.rules`) that make Codex ask, since its hooks can't; the guard blocks such a command written so the rules could miss it. A `cube-updater` custom agent and a `cube-update` skill do the updates. Setup includes Codex when it runs in a Codex session, when the project has `.codex/`, or when you say yes; `cube install --agent codex` adds it to an existing cube, and `cube uninstall --agent codex` removes it. Codex runs a project's hooks only after each person trusts its `.codex/` folder (`/hooks`). Building a cube from existing files still needs Claude Code.
- **Setup works in the Claude desktop app, with no terminal.** Ask Claude in a desktop session to run it. It finds Claude Code without a `claude` command: the one running the session, or the app's own copy. Questions that need your say stop the command one at a time and come to you through Claude, which runs it again with `--answer <question>=<answer>`; the long part of the build runs in a background process (`cube build-status` shows how it's going and any question waiting; `--stop` stops it). A later start picked this way is kept until it begins.
- **Without a terminal, nothing is spent without a yes.** Before, a run with no terminal (an agent running setup, say) took every default: it read the files with AI, accepted the estimate, and built the whole cube, rows and all, with nobody saying yes. Now it stops at those questions, as above, and at first rules the build drafted, which would load into every session. `--yes` still accepts every default.
- A project with `.claude/` or `CLAUDE.md` gets the Claude Code hooks and block even where the `claude` command isn't installed, instead of a plain AGENTS.md block.
- A person-only command blocked in a desktop app session says to run it in the app's terminal pane, since the desktop app has no `!` prefix.
- `cube check` warns when `AGENTS.md` is too long for Codex to reach the cube's block (Codex reads its first 32 KB by default).

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
