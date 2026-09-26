---
id: Y03.X003
name: batched-uploads
summary: Groups queued edits into batches for upload to the server (added 2026-08-14).
read_when: Changing batch size, upload request shape, or how batches interact with retries and rate limits.
links:
  - to: Y02.X002
    name: server-never-rewrites-history
    rel: governed-by
    note: batched uploads must preserve each edit distinctly, not squash them into a merged history
status: ok
written_by: ai
---
