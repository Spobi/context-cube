---
id: Y04.X001
name: no-clock-mocking-sync-tests
summary: Sync tests must use a real clock, not a mocked one, because the drift bug in sync only reproduces with real timing.
read_when: writing or debugging sync tests, or investigating clock-drift related sync bugs
links:
  - to: Y04
    name: testing
    rel: implements
    note: a known trap when writing sync tests
  - to: Y03.X001
    name: offline-replay-queue
    rel: see-also
    note: clock drift affects offline replay ordering behavior
status: ok
source: CLAUDE.md L16-L16, "Don't mock the clock in sync tests; the drift bug only shows with a real clock."
written_by: ai
---
