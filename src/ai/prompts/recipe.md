You write a recipe for Context Cube: instructions that ordinary code follows to cut a project's memory files into entries. You write it once; code applies it every time after, so it must be exact.

For each source file you get its role (from an earlier classification), its line count, its heading outline with line numbers, its first lines, and a few sample entries. Lines are shown as `N| text`; the `N| ` prefix is not part of the file.

For each file, return `sections`. A section is a run of lines with one kind; most files have exactly one section starting at line 1. For a file that mixes kinds, start a new section at the heading where the kind changes. The first section must start at line 1. Sections cover the whole file; nothing is skipped.

For each section:

- `kind`: rules, history, invariants, catalog, or notes.
- `split`: how entries begin.
  - `{"mode": "heading", "level": N}`: every heading of exactly level N (N `#` marks) starts an entry. Choose the level that gives one entry per history entry, per invariants topic, or per catalog item. Headings of a higher level (fewer `#`) and any text before the first entry are kept as text between entries.
  - `{"mode": "items"}`: every top-level list item (`- `, `* `, `1. ` at the start of a line) starts an entry. Use this for rules written as a list.
  - `{"mode": "whole"}`: the whole section is one entry (a single design doc or note).
- `maxLines` and `subsplit` (optional): entries longer than `maxLines` are split at the next heading level (`"heading"`) or at top-level list items (`"items"`). Use this for invariants topics that are very long. Never split history entries: leave `maxLines` out for history.
- `key` (optional but important for history and invariants): a JavaScript regular expression matched against an entry's first line, whose capture group 1 is the entry's identifier that other text uses to refer to it. Examples: for `## 1.0.8 (6) — Take out the lift`, the key is the version `1.0.8 (6)`: `^##\s+(\d+\.\d+\.\d+\s*\(\d+\))`. For `## §21 Signal fields`, the key is `21`: `^##\s+§\s*(\d+)`.
- `date` (optional): a regex whose group 1 is a YYYY-MM-DD date in the entry's first line.
- `summary` (optional): a regex whose group 1 is text in the first line that already works as a one-line summary (for example the words after a dash in `## 1.0.8 (6) — Take out the resolution lift that never lifted`). Only set it when most entries have such text.
- `order` (history only): "newest-first" or "oldest-first", as the entries appear in the file.

Then return `refs`: patterns for references between entries that appear in the text, such as `§21` (pointing at invariants topic 21) or `1.0.8 (10)` (pointing at that history entry). Each has a JavaScript `pattern` whose group 1 matches the target's `key` exactly as your key regex captures it, and the `kind` of entry it points to. Only include patterns you see evidence of in the outline or samples. Make patterns specific enough not to match ordinary numbers.

Regular expressions are JavaScript syntax, written as JSON strings (escape backslashes). They are matched against one line at a time with no flags.

Return every source file you were given, with its path unchanged, and `version: 1`.
