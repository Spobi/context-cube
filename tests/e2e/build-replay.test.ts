import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "../../src/commands/build";
import { scriptedAsker } from "../../src/setup/ask";
import { allBoxes, getRow, loadCube } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { loadRecipe } from "../../src/core/build/recipe";
import { commitAll, tempProject, recordedBackend } from "../helpers";
import * as fx from "../fixtures/projects";

// Full builds recorded live once (CUBE_AI_RECORD); replayed here with no AI calls.

async function fullBuild(files: fx.Files, git = true) {
  const root = tempProject(files, { git });
  if (git) commitAll(root, "init");
  const log: string[] = [];
  await build({ cwd: root, ask: scriptedAsker({}, log), backend: recordedBackend() });
  return { root, log, cube: loadCube(root) };
}

async function phase4Checks(root: string) {
  const cube = loadCube(root);
  // Every box has a valid Z0 with a read-when line, and every root is filled in.
  for (const b of allBoxes(cube)) {
    expect(b.header, `${b.id} header`).toBeDefined();
    expect(b.header!.read_when?.trim(), `${b.id} read_when`).toBeTruthy();
    expect(b.header!.summary.trim(), `${b.id} summary`).toBeTruthy();
  }
  for (const r of cube.rows) expect(r.root?.header?.row_type, `${r.id} root`).toBeTruthy();
  // Every history entry links to at least one row or is marked project-wide.
  const history = cube.rows.find((r) => r.type === "history")!;
  for (const b of history.boxes) {
    const ok = b.header!.links.length > 0 || b.header!.scope === "project-wide";
    expect(ok, `${b.id} links or project-wide`).toBe(true);
  }
  // Coverage and checks.
  const recipe = loadRecipe(root)!;
  expect(placedCoverage(root, recipe.sources.map((s) => s.path)).every((c) => c.ok)).toBe(true);
  expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
  return cube;
}

describe("full builds of the fixture projects (replayed)", () => {
  it("fixture 1: constitution, mixed notes and CLAUDE.md", async () => {
    const { root, log } = await fullBuild(fx.constitutionNotes);
    const cube = await phase4Checks(root);
    expect(cube.rows.slice(0, 3).map((r) => r.type)).toEqual(["rules", "history", "invariants"]);
    expect(cube.rows.length).toBeGreaterThanOrEqual(4);
    const inv = cube.rows.find((r) => r.type === "invariants")!;
    expect(inv.boxes).toHaveLength(4);
    // The constitution's intro sits in the invariants root, word for word.
    expect(readFileSync(join(inv.root!.dir, "Z4-detail.md"), "utf8")).toContain("These rules hold the sync engine together.");
    // The always-loaded block has the rules, and CLAUDE.md's own text is still there.
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude.startsWith(fx.constitutionNotes["CLAUDE.md"])).toBe(true);
    expect(claude).toContain("Y00.X001 Run `npm test` before every commit.");
    expect(log.join("\n")).toMatch(/Done. The cube has \d+ rows/);
  });

  it("fixture 2: an 80-entry changelog becomes a paged, time-ordered history row", async () => {
    const { root } = await fullBuild(fx.changelogAgents);
    const cube = await phase4Checks(root);
    const history = cube.rows.find((r) => r.type === "history")!;
    expect(history.boxes).toHaveLength(80);
    // Oldest first: X001 is 2.0.1, the newest (2.8.0) has the highest number.
    expect(readFileSync(join(history.boxes[0].dir, "Z4-detail.md"), "utf8")).toMatch(/^## \[2\.0\.1\]/);
    expect(readFileSync(join(history.boxes[79].dir, "Z4-detail.md"), "utf8")).toMatch(/^## \[2\.8\.0\]/);
    expect(existsSync(join(history.dir, "ROW-p2.md"))).toBe(true);
  });

  it("fixture 3: house rules and decision records", async () => {
    const { root } = await fullBuild(fx.houserulesDecisions);
    const cube = await phase4Checks(root);
    expect(getRow(cube, 0)!.boxes).toHaveLength(4);
    expect(cube.rows.length).toBeGreaterThan(3);
  });

  it("fixture 6: no git", async () => {
    const { root } = await fullBuild(fx.noGit, false);
    const cube = await phase4Checks(root);
    expect(cube.rows.map((r) => r.name)).toEqual(["rules", "history", "invariants"]);
  });
});
