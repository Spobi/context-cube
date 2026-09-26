---
id: Y01.X003
name: offline-queue
summary: Edits made offline wait in a queue and replay in order when the device reconnects.
read_when: Before changing offline edit storage or replay logic, or when edits are skipped or applied out of order
links:
  - to: Y03.X001
    name: offline-replay-queue
    rel: touches
    note: implemented the offline replay queue
  - to: Y02.X001
    name: ordered-edit-replay
    rel: touches
    note: implements the invariant that edits replay in order
status: ok
source: CLAUDE.md L11-L13, "2026-08-02 — Offline queue"
written_by: ai
---
