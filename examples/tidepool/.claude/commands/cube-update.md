---
description: Update the project's Context Cube for the work in this session.
---
Update the project memory (Context Cube) for the work done in this session.

1. Run `node context-cube/.tool/cube.mjs update-plan` to see which boxes are linked to what changed and which commands to use.
2. Write a short note (2–4 sentences): what changed and why.
3. Hand the note and the plan to the cube-updater agent (subagent_type "cube-updater"). It runs on a cheap model and does the mechanical updates.
4. If the helper reports a possible new invariant, propose it with `node context-cube/.tool/cube.mjs propose new ...`; a person approves it.
