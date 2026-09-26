# Demo project

House notes stay here.

<!-- context-cube:start -->
## Project memory (Context Cube)
The rules below always apply. For everything else, pick rows from the list, open their row index, and open only the drawers your task needs. Full protocol: context-cube/CUBE.md
Before changing a file, `node context-cube/.tool/cube.mjs related <file>` lists the invariants, boxes, and history linked to it. To search the memory: `node context-cube/.tool/cube.mjs find <words>`.

### Rules
- Y00.X001 Read the invariants before touching timer or sync code.

### Rows
- Y01 history: What changed and why, one entry per build, newest first. Open when: Debugging, revisiting a decision, or changing something that was changed before. → context-cube/Y01-history/ROW.md
- Y02 invariants: Rules that must never be broken, by topic: what must hold, why, and what breaks otherwise. Open when: Before changing code that a box's Z2 lists, or anything the rules say needs the invariants. → context-cube/Y02-invariants/ROW.md
- Y03 sync: How two devices stay in step. Open when: Changing anything that both devices must agree on. → context-cube/Y03-sync/ROW.md
<!-- context-cube:end -->
