---
id: Y03.X001
name: offline-replay-queue
summary: "src/sync/queue.ts `replay`: holds edits made offline and replays them to the server in order once the device reconnects."
read_when: Changing replay order, queue contents, reconnect behavior, or how queued edits are sent.
links:
  - to: Y02.X001
    name: ordered-edit-replay
    rel: governed-by
    note: replay must apply edits strictly in the device's own sequence-number order
  - to: Y02.X004
    name: monotonic-sequence-numbers
    rel: governed-by
    note: replay ordering relies on sequence numbers that never repeat or go backward
status: ok
written_by: ai
---
