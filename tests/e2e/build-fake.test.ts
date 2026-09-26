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
import type { Chunk } from "../../src/core/build/split";
import { commitAll, tempProject } from "../helpers";
import { answer, files } from "../fixtures/scripted";

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
