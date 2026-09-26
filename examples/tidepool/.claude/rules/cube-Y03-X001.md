---
paths:
  - "src/sync/queue.ts"
---
Context Cube: Y03.X001 offline-replay-queue covers this file.
src/sync/queue.ts `replay`: holds edits made offline and replays them to the server in order once the device reconnects.

It is governed by invariants. Before editing this file, open their Z1:
- Y02.X001: context-cube/Y02-invariants/X001-ordered-edit-replay/Z1-invariants.md
- Y02.X004: context-cube/Y02-invariants/X004-monotonic-sequence-numbers/Z1-invariants.md

More: context-cube/Y03-sync-engine/X001-offline-replay-queue/ · Everything linked to this file: node context-cube/.tool/cube.mjs related <file>
