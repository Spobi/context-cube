---
paths:
  - "src/sync/tombstones.ts"
---
Context Cube: Y03.X002 tombstone-retention covers this file.
src/sync/tombstones.ts `TOMBSTONE_DAYS`: how long delete markers are kept (30 days, fixed by invariant §3) so other devices learn about deletions.

It is governed by invariants. Before editing this file, open their Z1:
- Y02.X003: context-cube/Y02-invariants/X003-thirty-day-tombstone-retention/Z1-invariants.md

More: context-cube/Y03-sync-engine/X002-tombstone-retention/ · Everything linked to this file: node context-cube/.tool/cube.mjs related <file>
