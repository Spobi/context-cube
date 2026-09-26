---
id: Y03.X002
name: tombstone-retention
summary: "src/sync/tombstones.ts `TOMBSTONE_DAYS`: how long delete markers are kept (30 days, fixed by invariant §3) so other devices learn about deletions."
read_when: Changing tombstone lifetime, delete propagation, or cleanup of old tombstones.
links:
  - to: Y02.X003
    name: thirty-day-tombstone-retention
    rel: governed-by
    note: TOMBSTONE_DAYS must stay fixed at 30 per this invariant, changed only after checking offline-gap analytics
status: ok
written_by: ai
---
