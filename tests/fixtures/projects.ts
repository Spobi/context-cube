/**
 * Synthetic sample projects (plan 16). Never real project content. Each is a
 * map of path → file text; tests write them into temporary folders.
 */

export type Files = Record<string, string>;

// 1. CONSTITUTION.md + a mixed NOTES.md + a mixed CLAUDE.md
export const constitutionNotes: Files = {
  "CLAUDE.md": `# Tidepool — notes for Claude

## Working here
- Run \`npm test\` before every commit.
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
`,
  "CONSTITUTION.md": `# The Tidepool Constitution

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
`,
  "NOTES.md": `# Working notes

## Conventions
- Components live in src/ui, one per file.
- Every sync function takes the device id as its first argument.

## Log
### 2026-07-20
Moved the sync worker to its own thread.
### 2026-07-11
First version of conflict highlighting.
`,
  "src/sync/queue.ts": `// The offline queue. IMPORTANT: never reorder queued edits (CONSTITUTION §1).
export function replay(deviceId: string, edits: { seq: number }[]) {
  return [...edits].sort((a, b) => a.seq - b.seq);
}
`,
  "src/sync/tombstones.ts": `export const TOMBSTONE_DAYS = 30;
`,
  "README.md": `# Tidepool

A note-taking app that syncs across devices. Install with \`npm install\`, run with \`npm start\`.
`,
  "package.json": `{"name":"tidepool","version":"1.4.0","scripts":{"test":"vitest","start":"vite"}}\n`,
};

// 2. A large CHANGELOG.md + AGENTS.md
function changelog(n: number): string {
  const out = ["# Changelog", "", "All notable changes to this project are documented here.", ""];
  for (let i = n; i >= 1; i--) {
    const major = 2;
    const minor = Math.floor(i / 10);
    const patch = i % 10;
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = String(1 + (Math.floor(i / 28) % 12)).padStart(2, "0");
    out.push(`## [${major}.${minor}.${patch}] - 2025-${month}-${day}`, "");
    out.push("### Added", `- Export option number ${i} for the report screen.`);
    if (i % 3 === 0) out.push(`- Keyboard shortcut for action ${i}.`);
    out.push("", "### Fixed", `- A crash when opening an empty report (introduced in ${major}.${Math.floor((i - 1) / 10)}.${(i - 1) % 10}).`, "");
  }
  return `${out.join("\n")}\n`;
}

export const changelogAgents: Files = {
  "AGENTS.md": `# Agent guide for Ledgerly

- Use pnpm, never npm or yarn.
- Every new report needs a snapshot test in tests/reports.
- Money is stored in integer cents; never use floats for amounts.
- Add an entry to CHANGELOG.md for every user-visible change.
`,
  "CHANGELOG.md": changelog(80),
  "src/reports/export.ts": "export function exportReport() {}\n",
  "src/money.ts": "// Amounts are integer cents. Never use floats for money.\nexport type Cents = number;\n",
};

// 3. HOUSERULES.md + a docs folder of decision records
export const houserulesDecisions: Files = {
  "HOUSERULES.md": `# House rules

1. Keep pull requests under 400 lines.
2. Every database migration must be reversible.
3. Feature flags are removed within two releases of full rollout.
4. Nobody deploys on Fridays.
`,
  "docs/decisions/0001-use-postgres.md": `# 1. Use Postgres

Date: 2025-03-02
Status: accepted

## Context
We need relational data with strong consistency.

## Decision
Use Postgres 16 for all services.

## Consequences
We run migrations with the migrate tool; every migration must be reversible.
`,
  "docs/decisions/0002-feature-flags.md": `# 2. Feature flags in the config service

Date: 2025-04-10
Status: accepted

## Context
Releases need gradual rollout.

## Decision
All flags live in the config service, never in code constants.

## Consequences
Flags must be cleaned up; see the house rules.
`,
  "docs/decisions/0003-no-orm.md": `# 3. No ORM

Date: 2025-05-21
Status: accepted

## Decision
Write SQL by hand with a thin query helper.
`,
  "src/db/migrate.ts": "export function migrate() {}\n",
  "README.md": "# Harbor\n\nInternal services for the Harbor platform.\n",
};

// 4. Code and git history only (commits are made by the test)
export const codeOnly: Files = {
  "src/index.ts": "export function main() { return 1; }\n",
  "src/auth/login.ts": "// Do not log passwords, ever.\nexport function login() {}\n",
  "src/auth/session.ts": "export const SESSION_HOURS = 12;\n",
  "package.json": `{"name":"quartz","scripts":{"test":"vitest","build":"tsc"}}\n`,
};

// 5. An empty new project
export const empty: Files = {};

// 6. A folder with no git
export const noGit: Files = {
  "CLAUDE.md": "# Rules\n\n- Always run the linter before finishing.\n- Keep functions under 50 lines.\n",
  "HISTORY.md": "# History\n\n## 0.2 — Added export\n- CSV export.\n\n## 0.1 — First version\n- Basic editing.\n",
  "main.py": "print('hello')\n",
};
