# Changelog

To update a project, run `npx context-cube@latest` in it, then commit `context-cube/` so teammates get the same version.

## 0.2.0 (2026-09-26)

- **Old text stays as written.** Text moved in from your files, and closed history entries, can't be rewritten by an agent. `cube write <id> Z4 --append` adds a dated note below them instead, and the cube-updater helper now does that after commits instead of rewriting a box's detail. A person can change one on purpose with `cube replace` or remove one with `cube delete --reason`; both ask you to confirm in Claude Code and are logged. `cube check` compares this text with your archived originals and flags any that changed some other way.
- **History summaries stick to what the entry says.** They give a reason only when the entry states one, and keep the reason when an entry records a failure, a revert, or something not to try again. Cubes built earlier keep their summaries; fix one with `cube edit <id> --summary "..."`.
- **`cube related` says how it found each box:** the code name it matched, the commit that changed the file, or the box it was reached through.
- **Team merges keep both sides' bookkeeping.** Before, when two branches both changed a box's state file, the merge kept only the newer one, so an invariant approval made on one branch could be lost and the pre-commit check would then block commits.
- **Updating works.** Running setup again on a project now updates the project's copy of the tool (`context-cube/.tool/cube.mjs`); before, it reinstalled hooks but kept the old copy. An older version refuses to run against a project set up with a newer one, and won't replace its copy.

## 0.1.0 (2026-09-26)

First release.
