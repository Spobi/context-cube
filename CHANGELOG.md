# Changelog

To update a project, run `npx context-cube@latest` in it, then commit `context-cube/` so teammates get the same version.

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
