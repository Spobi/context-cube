---
id: Y01.X003
name: offline-queue
summary: Edits made offline wait in a queue and replay in order.
read_when: Before modifying the offline edit queue or replay logic
links:
  - to: Y03.X001
    name: offline-replay-queue
    rel: touches
    note: implemented offline replay queue
  - to: Y02.X001
    name: ordered-edit-replay
    rel: touches
    note: implements edits-replay-in-order invariant
status: ok
source: CLAUDE.md L11-L13, "2026-08-02 — Offline queue"
written_by: ai
---
