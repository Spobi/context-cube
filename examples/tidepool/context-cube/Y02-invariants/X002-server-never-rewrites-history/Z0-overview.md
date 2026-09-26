---
id: Y02.X002
name: server-never-rewrites-history
summary: "Server never rewrites history: the server only stores edits — clients do all merging, squashing, and reordering"
read_when: Before adding server-side merging, squashing, or reordering of edits, before changing upload batching that could combine or reorder edits, or before changing client merge logic that assumes an untouched server history
scope: Server-side edit storage/upload endpoints and any batching logic in src/sync that sends edits to the server
links:
  - to: Y02.X001
    name: ordered-edit-replay
    rel: see-also
    note: mentions §1
status: ok
source: CONSTITUTION.md L10-L14, "§2 The server never rewrites history"
written_by: ai
---
