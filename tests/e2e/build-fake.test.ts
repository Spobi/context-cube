import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../../src/commands/build";
import { FakeBackend } from "../../src/ai/backends";
import { scriptedAsker } from "../../src/setup/ask";
import { allBoxes, getBox, loadCube, readDrawer } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { chronological } from "../../src/core/build/place";
import { inferHistoryUnit } from "../../src/core/build/stages";
import { loadAliases, resolveAlias } from "../../src/core/state/state";
import type { AICall } from "../../src/adapters/types";
import type { Chunk } from "../../src/core/build/split";
import { commitAll, tempProject } from "../helpers";

const files = {
  "AGENTS.md": "# Guide\n\n- Use pnpm.\n- Never commit secrets.\n",
  "HISTORY.md": "# History\n\n## 1.1 (2) — Faster sync\nSync got faster. See §2.\n\n## 1.1 (1) — 2026-02-01\nFirst sync. Relies on §1.\n\n## Deploy — 2026-01-15\nServer went live.\n",
  "INVARIANTS.md": "# Invariants\n\nThese hold the app together.\n\n## §1 Order\n- Edits apply in order.\n\n## §2 Speed\n- Sync must finish in 2s. Changed in 1.1 (2).\n",
  "DESIGN.md": "# Design\n\n## Sync screen\nShows progress.\n\n## Settings\nOne toggle.\n",
  "src/sync.ts": "export function sync() {}\n",
};

const recipe = {
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

function answer(call: AICall): unknown {
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

describe("the full build with a scripted AI", () => {
  it("places every piece word for word, in time order, with coverage, aliases, and links", async () => {
    const root = tempProject(files);
    commitAll(root);
    const backend = new FakeBackend((c) => answer(c));
    const log: string[] = [];
    await build({ cwd: root, ask: scriptedAsker({}, log), backend });
    const cube = loadCube(root);
    expect(cube.rows.map((r) => `${r.id} ${r.name}`)).toEqual(["Y00 rules", "Y01 history", "Y02 invariants", "Y03 sync"]);

    // Rules: the Z0 body is the rule, word for word.
    const rules = cube.rows[0].boxes;
    expect(rules.map((b) => b.doc!.body)).toEqual(["- Use pnpm.\n", "- Never commit secrets.\n"]);

    // History: oldest first (the deploy on 2026-01-15), Z4 word for word.
    const hist = cube.rows[1].boxes;
    expect(hist.map((b) => readDrawer(b, 4)!.split("\n")[0])).toEqual(["## Deploy — 2026-01-15", "## 1.1 (1) — 2026-02-01", "## 1.1 (2) — Faster sync"]);
    expect(hist[0].header).toMatchObject({ name: "entry-001", summary: "Summary of Y01.X001.", written_by: "ai" });
    expect(hist[0].header!.links.map((l) => l.to)).toContain("Y03");
    expect(hist[0].header!.links.map((l) => l.to)).not.toContain("Y99");

    // Invariants: Z1 word for word; governs becomes governed-by on the governed box.
    const inv = cube.rows[2].boxes;
    expect(readDrawer(inv[0], 1)).toBe("## §1 Order\n- Edits apply in order.\n\n");
    const screen = getBox(cube, "Y03.X001")!;
    expect(screen.header!.links.filter((l) => l.rel === "governed-by").map((l) => l.to)).toEqual(["Y02.X001", "Y02.X002"]);
    // The short design doc stays whole (code splits notes; no AI) and became the proposed
    // box's Z4 instead of a second box about the same thing.
    expect(readDrawer(screen, 4)).toBe(files["DESIGN.md"]);
    expect(cube.rows[3].boxes).toHaveLength(1);

    // Text between entries sits in root Z4s, wrapped in markers.
    const invRoot = readDrawer(cube.rows[2].root!, 4)!;
    expect(invRoot).toContain("<!-- cube:from INVARIANTS.md L1-L4 -->\n# Invariants\n\nThese hold the app together.\n\n<!-- cube:end-from -->");

    // Legacy references resolve, and references became links.
    const aliases = loadAliases(root);
    expect(resolveAlias(aliases, "§2")).toBe("Y02.X002");
    expect(resolveAlias(aliases, "1.1 (2)")).toBe("Y01.X003");
    const newest = getBox(cube, "Y01.X003")!;
    expect(newest.header!.links).toContainEqual(expect.objectContaining({ to: "Y02.X002", rel: "see-also", note: "mentions §2" }));

    // Every source recombines exactly, and the cube passes its checks.
    const cov = placedCoverage(root, ["AGENTS.md", "HISTORY.md", "INVARIANTS.md", "DESIGN.md"]);
    expect(cov.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);

    // The always-loaded block went into CLAUDE.md with the rules; the originals are untouched.
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Y00.X001 Use pnpm.");
    for (const [p, t] of Object.entries(files)) expect(readFileSync(join(root, p), "utf8")).toBe(t);

    // A hand edit to migrated text shows up as a coverage difference.
    const z1 = join(inv[0].dir, "Z1-invariants.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(z1, readFileSync(z1, "utf8").replace("in order", "in any order"));
    expect(placedCoverage(root, ["INVARIANTS.md"])[0].ok).toBe(false);

    expect(log.join("\n")).toContain("Every line of your 4 source files is in the cube, word for word.");
    expect(allBoxes(cube).every((b) => b.header?.read_when)).toBe(true);
  });

  it("orders history across files by date, keeping each file's own order", () => {
    const c = (source: string, start: number, date?: string): Chunk => ({ id: `${source}#${start}`, source, section: 0, kind: "history", role: "entry", start, end: start, text: "", date });
    const recipeLike = { version: 1 as const, refs: [], sources: [
      { path: "NEW.md", sections: [{ startLine: 1, kind: "history" as const, split: { mode: "whole" as const }, order: "newest-first" as const }] },
      { path: "OLD.md", sections: [{ startLine: 1, kind: "history" as const, split: { mode: "whole" as const }, order: "oldest-first" as const }] },
    ] };
    const out = chronological(
      [c("NEW.md", 1), c("NEW.md", 5, "2026-03-01"), c("NEW.md", 9, "2026-02-20"), c("OLD.md", 1, "2026-01-01"), c("OLD.md", 5, "2026-02-25")],
      recipeLike,
    );
    // NEW.md reversed: 9 (02-20), 5 (03-01), 1 (undated → stays after 5). OLD.md interleaves by date.
    expect(out.map((x) => x.id)).toEqual(["OLD.md#1", "NEW.md#9", "OLD.md#5", "NEW.md#5", "NEW.md#1"]);
  });

  it("infers the history unit from entry keys", () => {
    const e = (key?: string, date?: string) => ({ key, date }) as Chunk;
    expect(inferHistoryUnit([e("1.0.8 (6)"), e("1.0.8 (5)")])).toBe("build");
    expect(inferHistoryUnit([e("2.1.0"), e("2.0.9")])).toBe("release");
    expect(inferHistoryUnit([e(undefined, "2026-01-01"), e(undefined, "2026-01-02")])).toBe("day");
  });
});
