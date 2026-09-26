---
id: Y01.X000
name: history
summary: What changed and why, one entry per day, newest first.
read_when: Debugging, revisiting a decision, or changing something that was changed before.
row_type: history
conventions:
  - One entry per day. The oldest entry is X001; the newest has the highest number.
  - The row index lists entries newest first.
  - Z0 summarizes an entry and links to every row it touched; Z4 holds the full entry, word for word.
  - One entry is open at a time; add to it with `node context-cube/.tool/cube.mjs history add`.
links: []
status: ok
written_by: person
---
The project's timeline. Entries are never rewritten; corrections go in later entries.
