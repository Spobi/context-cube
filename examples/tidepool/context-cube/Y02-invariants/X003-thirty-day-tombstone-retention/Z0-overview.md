---
id: Y02.X003
name: thirty-day-tombstone-retention
summary: "30-day tombstone retention: delete markers persist 30 days so long-offline devices learn about deletes"
read_when: Before changing TOMBSTONE_DAYS or tombstone expiry/purge logic, before changing assumptions about the longest supported offline gap, or before writing/updating tests covering deletes or tombstones
scope: Tombstone storage and expiry logic in src/sync/tombstones.ts and any code that purges or reads tombstones
links:
  - to: Y02.X002
    name: server-never-rewrites-history
    rel: see-also
    note: mentions §2
status: ok
source: CONSTITUTION.md L15-L19, "§3 Tombstones live for 30 days"
written_by: ai
---
