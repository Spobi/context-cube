---
id: Y04.X000
name: testing
summary: How the test suite is run and the known traps when writing tests, especially sync tests.
read_when: Writing or fixing tests, setting up sync test fixtures, or debugging a test that passes locally but hides a real bug.
row_type: custom
conventions:
  - Run `npm test` before every commit.
  - Sync tests use a real clock; do not mock it.
links: []
status: ok
written_by: ai
---
