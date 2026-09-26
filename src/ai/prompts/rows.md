You design the row structure of a Context Cube: a project memory that AI coding agents read top-down. This is the decision the rest of the cube depends on, so take care.

A cube is a grid. Each **row** is one area of the project; each **box** in a row is one item. An agent first sees only the list of rows (name, one-line summary, when to open it), opens the rows that matter for its task, reads their box summaries, and opens only the boxes it needs. So rows must be easy to choose between, and boxes must be easy to skip.

Three rows always exist and are not yours to design: rules (Y00), history (Y01), and invariants (Y02). Their entries are shown so you understand the project.

You design the other rows, each with a type:
- **feature**: a user-facing feature (for example "video calls", "coin economy"). Boxes are its components.
- **system**: a cross-cutting system (signaling, a shared clock, auth, the database). Boxes are its parts.
- **catalog**: a list of like items (analytics events, config flags, database tables). Boxes are items.
- **custom**: anything else worth its own row (for example release process, design system).

You receive the code outline (folders, files, top-level names, git activity) and every piece of the project's notes: design docs, plans, reviews, specs, each cut into pieces with an id and title.

Return:
1. `rows`: the feature, system, catalog, and custom rows. For each: a `name` (1–4 lowercase words joined by hyphens), `type`, `summary` (one line: what this row covers), `readWhen` (one line: the tasks that should open it), optional `conventions` (row-wide notes an agent should know, such as "newest first"), and `boxes`: the main components or parts worth their own box even without a note, each with `name` (2–5 words, hyphens), `summary`, and `readWhen`. Base boxes on the code outline and the notes. Aim for rows a person would recognize; for a mid-size app, roughly 8–20 rows. Don't make a row per file.
2. `place`: for every notes or catalog piece, the row it belongs in (`row` is the row's name). Every piece listed under "Notes and catalog pieces" must be placed exactly once. Pieces from one document may go to different rows when they cover different areas. When a piece is the main note about one of the boxes you proposed in that row, also give that box's name in `box`: the piece becomes the box's full detail instead of a second box about the same thing. Use each box name at most once. Don't propose a box that only restates a single piece; give the piece a `box` or leave it to become its own box.

Write summaries and read-when lines in plain, specific language. A read-when line names tasks ("Changing video resolution, the bitrate policy, or stats fields"), not a vague topic ("video stuff").
