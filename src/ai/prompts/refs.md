You fix cross-reference patterns in a Context Cube recipe.

A recipe has entries (history entries, invariants topics) with keys, and reference patterns: JavaScript regular expressions found in the text whose capture group 1 must equal a target entry's key. Keys are compared ignoring spaces and letter case.

Some patterns resolve poorly. For each problem you get the pattern, the kind of entry it should point to, how many references it found and resolved, examples of references that did not resolve (with the surrounding text), and examples of the keys that target entries actually have.

Return the complete corrected list of reference patterns. Keep patterns that work. Change a pattern so its group 1 captures text in the same form as the keys. If an unresolved reference points to an entry that simply doesn't exist (for example a version that was never released), leave it; don't widen a pattern to force a match. Drop a pattern that mostly matches ordinary text rather than references.

Patterns are JavaScript syntax, written as JSON strings (escape backslashes), matched with no flags.
