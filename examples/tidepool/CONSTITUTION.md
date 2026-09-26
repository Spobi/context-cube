# The Tidepool Constitution

These rules hold the sync engine together. Breaking one corrupts somebody's notes.

## §1 Edits replay in order
- Every device replays queued edits in the order they were made, by the device's own sequence number.
- Why: two edits to one line applied out of order leave the older text on top.
- What breaks: notes silently lose the newest edit.

## §2 The server never rewrites history
- The server stores edits; it never merges, squashes, or reorders them.
- Clients do all merging. See §1 for ordering.
- What breaks: a client that already merged gets a different history than one that didn't.

## §3 Tombstones live for 30 days
- A deleted note keeps a tombstone for 30 days so offline devices learn about the delete.
- Never shorten this without checking the longest offline gap in the analytics (see §2).
- What breaks: a device that was offline for a month resurrects deleted notes.

## §4 Sequence numbers never repeat
- A device's sequence number only goes up, even after a reinstall; it is seeded from the server.
- What breaks: two edits with one number, and §1 can't order them.
