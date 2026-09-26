---
id: Y02.X001
name: ordered-edit-replay
summary: "Ordered edit replay: each device replays its queued edits by its own sequence number, never out of order"
read_when: Before changing how queued edits are ordered, replayed, or merged, before changing batching/upload logic that could reorder edits, or before writing/updating sync tests about edit ordering
scope: The offline edit queue and replay logic in src/sync (queue.ts), and any client-side merge logic that applies queued edits
links: []
status: ok
source: CONSTITUTION.md L5-L9, "§1 Edits replay in order"
written_by: ai
---
