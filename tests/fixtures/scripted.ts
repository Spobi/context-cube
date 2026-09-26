import type { AICall } from "../../src/adapters/types";

/**
 * A small project and a scripted AI that answers every build step, for full
 * builds in a second without recorded answers.
 */

export const files = {
  "AGENTS.md": "# Guide\n\n- Use pnpm.\n- Never commit secrets.\n",
  "HISTORY.md": "# History\n\n## 1.1 (2) — Faster sync\nSync got faster. See §2.\n\n## 1.1 (1) — 2026-02-01\nFirst sync. Relies on §1.\n\n## Deploy — 2026-01-15\nServer went live.\n",
  "INVARIANTS.md": "# Invariants\n\nThese hold the app together.\n\n## §1 Order\n- Edits apply in order.\n\n## §2 Speed\n- Sync must finish in 2s. Changed in 1.1 (2).\n",
  "DESIGN.md": "# Design\n\n## Sync screen\nShows progress.\n\n## Settings\nOne toggle.\n",
  "src/sync.ts": "export function sync() {}\n",
};

export const recipe = {
  version: 1,
  sources: [
    { path: "AGENTS.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "items" } }] },
    { path: "HISTORY.md", sections: [{ startLine: 1, kind: "history", split: { mode: "heading", level: 2 }, key: "^##\\s+(\\d+\\.\\d+\\s*\\(\\d+\\))", date: "(\\d{4}-\\d{2}-\\d{2})", summary: "—\\s+(?!\\d{4})(.+)$", order: "newest-first" }] },
    { path: "INVARIANTS.md", sections: [{ startLine: 1, kind: "invariants", split: { mode: "heading", level: 2 }, key: "^##\\s+§(\\d+)" }] },
  ],
  refs: [
    { pattern: "§(\\d+)", kind: "invariants" },
    { pattern: "(\\d+\\.\\d+\\s*\\(\\d+\\))", kind: "history" },
  ],
};

export function answer(call: AICall): unknown {
  const ids = (re: RegExp) => [...call.prompt.matchAll(re)].map((m) => m[1]);
  switch (call.step) {
    case "classify":
      return {
        files: ids(/^## File: (.+)$/gm).map((path) => ({
          path,
          role: path === "AGENTS.md" ? "rules" : path === "HISTORY.md" ? "history" : path === "INVARIANTS.md" ? "invariants" : "notes",
          confidence: "high",
          why: "test",
        })),
      };
    case "recipe": {
      const paths = ids(/^## Source: (.+)$/gm);
      return { ...recipe, sources: recipe.sources.filter((s) => paths.includes(s.path)), refs: recipe.refs };
    }
    case "rows": {
      const pieces = ids(/^- (n\d+): /gm);
      return {
        rows: [{ name: "sync", type: "system", summary: "Keeping devices in step.", readWhen: "Changing sync.", boxes: [{ name: "sync-screen", summary: "The sync progress screen.", readWhen: "Changing the sync screen." }] }],
        place: pieces.map((p, i) => ({ piece: p, row: "sync", ...(i === 0 ? { box: "sync-screen" } : {}) })),
      };
    }
    case "history-summaries":
      return { entries: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `entry-${id.slice(-3)}`, summary: `Summary of ${id}.`, readWhen: `When ${id} matters.`, touches: [{ to: "Y03", note: "changed sync" }, { to: "Y99", note: "a bad id, dropped" }], projectWide: false })) };
    case "invariant-labels":
      return { topics: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `topic-${id.slice(-3)}`, label: `Label ${id}`, scope: "sync", readWhen: `Before changing ${id}.`, governs: [{ to: "Y03.X001", note: "the screen shows it" }] })) };
    case "box-overviews":
      return { pieces: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `piece-${id.slice(-3)}`, summary: `Piece ${id}.`, readWhen: `When ${id}.` })) };
    default:
      throw new Error(`unexpected step ${call.step}`);
  }
}
