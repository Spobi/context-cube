---
id: Y02.X004
name: monotonic-sequence-numbers
summary: "Monotonic sequence numbers: a device's sequence number only increases, even after reinstall, seeded from the server"
read_when: Before changing how sequence numbers are generated, how they are re-seeded after reinstall or on a new device, or before writing/updating tests for edit ordering or replay
scope: Sequence-number generation and seeding for devices within the sync engine, used to order queued edits
links:
  - to: Y02.X001
    name: ordered-edit-replay
    rel: see-also
    note: mentions §1
status: ok
source: CONSTITUTION.md L20-L22, "§4 Sequence numbers never repeat"
written_by: ai
---
