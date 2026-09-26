---
id: Y03.X000
name: sync-engine
summary: "The offline sync engine in src/sync: the offline edit queue that replays edits in order, tombstone retention for deletes, and how uploads and retries reach the server."
read_when: Changing how queued edits replay, tombstone lifetime, upload batching, retry behavior, or any function in src/sync.
row_type: system
conventions:
  - Read CONSTITUTION.md (invariants §1–§4) before changing anything here.
  - Every sync function takes the device id as its first argument.
  - Edits must replay in order, sequence numbers never repeat, and the server never rewrites history.
links: []
status: ok
written_by: ai
---
