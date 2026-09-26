---
id: Y03.X004
name: rate-limiter-counts-retries
summary: The server rate limiter counts retry attempts along with original requests; a retry storm once locked a test account out for an hour.
read_when: debugging retry/upload failures, tuning retry backoff, or investigating unexpected account lockouts in sync
links:
  - to: Y03.X003
    name: batched-uploads
    rel: see-also
    note: retry storms arise from batched upload retry behavior
  - to: Y03
    name: sync-engine
    rel: see-also
    note: describes a gotcha in how uploads/retries reach the server
status: ok
source: CLAUDE.md L15-L15, "The rate limiter counts retries too; a retry storm locked out a test account for"
written_by: ai
---
