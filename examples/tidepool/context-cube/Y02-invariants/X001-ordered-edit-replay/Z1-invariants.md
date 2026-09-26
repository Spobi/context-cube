## §1 Edits replay in order
- Every device replays queued edits in the order they were made, by the device's own sequence number.
- Why: two edits to one line applied out of order leave the older text on top.
- What breaks: notes silently lose the newest edit.

