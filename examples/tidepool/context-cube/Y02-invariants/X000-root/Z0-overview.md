---
id: Y02.X000
name: invariants
summary: "Rules that must never be broken, by topic: what must hold, why, and what breaks otherwise."
read_when: Before changing code that a box's Z2 lists, or anything the rules say needs the invariants.
row_type: invariants
conventions:
  - One topic per box. Z1 holds the invariant text, word for word.
  - Never edit Z1 directly. Propose changes with `node context-cube/.tool/cube.mjs propose`; a person approves them.
  - Z2 lists the code the invariants govern; Z3 lists the history entries that created or changed them.
links: []
status: ok
written_by: person
---
Load-bearing rules. A future change could quietly break any of these.
