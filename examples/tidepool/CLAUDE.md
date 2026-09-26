# Tidepool — notes for Claude

## Working here
- Run `npm test` before every commit.
- Never push directly to main; open a pull request.
- Read CONSTITUTION.md before touching the sync engine.

## Recent changes
### 2026-08-14 — Batched uploads
Uploads now go in batches of 50 to stay under the rate limit.
### 2026-08-02 — Offline queue
Edits made offline wait in a queue and replay in order.

## Lessons
- The rate limiter counts retries too; a retry storm locked out a test account for an hour.
- Don't mock the clock in sync tests; the drift bug only shows with a real clock.

<!-- context-cube:start -->
## Project memory (Context Cube)
The rules below always apply. For everything else, pick rows from the list, open their row index, and open only the drawers your task needs. Full protocol: context-cube/CUBE.md
Before changing a file, `node context-cube/.tool/cube.mjs related <file>` lists the invariants, boxes, and history linked to it. To search the memory: `node context-cube/.tool/cube.mjs find <words>`.

### Rules
- Y00.X001 Run `npm test` before every commit.
- Y00.X002 Never push directly to main; open a pull request.
- Y00.X003 Read CONSTITUTION.md before touching the sync engine.
- Y00.X004 Components live in src/ui, one per file.
- Y00.X005 Every sync function takes the device id as its first argument.

### Rows
- Y01 history: What changed and why, one entry per day, newest first. Open when: Debugging, revisiting a decision, or changing something that was changed before. → context-cube/Y01-history/ROW.md
- Y02 invariants: Rules that must never be broken, by topic: what must hold, why, and what breaks otherwise. Open when: Before changing code that a box's Z2 lists, or anything the rules say needs the invariants. → context-cube/Y02-invariants/ROW.md
- Y03 sync-engine: The offline sync engine in src/sync: the offline edit queue that replays edits in order, tombstone retention for deletes, and how uploads and retries reach the server. Open when: Changing how queued edits replay, tombstone lifetime, upload batching, retry behavior, or any function in src/sync. → context-cube/Y03-sync-engine/ROW.md
- Y04 testing: How the test suite is run and the known traps when writing tests, especially sync tests. Open when: Writing or fixing tests, setting up sync test fixtures, or debugging a test that passes locally but hides a real bug. → context-cube/Y04-testing/ROW.md
<!-- context-cube:end -->
