## §2 The server never rewrites history
- The server stores edits; it never merges, squashes, or reorders them.
- Clients do all merging. See §1 for ordering.
- What breaks: a client that already merged gets a different history than one that didn't.

