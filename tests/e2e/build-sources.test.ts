import { describe, expect, it } from "vitest";
import { build } from "../../src/commands/build";
import { scriptedAsker } from "../../src/setup/ask";
import { loadChunks, loadState } from "../../src/core/build/pipeline";
import { loadRecipe } from "../../src/core/build/recipe";
import { chunkCoverage } from "../../src/core/build/split";
import { readSource } from "../../src/core/build/sources";
import { commitAll, tempProject, recordedBackend } from "../helpers";
import * as fx from "../fixtures/projects";

// Answers recorded from live runs (CUBE_AI_RECORD). Tests replay them, so no AI is used.

async function runToSplit(files: fx.Files, git = true) {
  const root = tempProject(files, { git });
  if (git) commitAll(root, "init");
  const log: string[] = [];
  await build({ cwd: root, stopAfter: "split", ask: scriptedAsker({}, log), backend: recordedBackend() });
  const state = loadState(root);
  const roles = Object.fromEntries((state.classes ?? []).map((c) => [c.path, c.role]));
  const { chunks, refs } = loadChunks(root);
  const recipe = loadRecipe(root)!;
  const coverage = chunkCoverage(chunks, recipe.sources.map((s) => ({ path: s.path, text: readSource(root, s.path) })));
  return { root, log, state, roles, chunks, refs, recipe, coverage };
}

describe("sources, recipe, split, and coverage on the fixture projects", () => {
  it("fixture 1: CONSTITUTION.md is invariants, and mixed CLAUDE.md and NOTES.md split by section", async () => {
    const r = await runToSplit(fx.constitutionNotes);
    expect(r.roles["CONSTITUTION.md"]).toBe("invariants");
    expect(r.roles["CLAUDE.md"]).toBe("mixed");
    expect(r.roles["NOTES.md"]).toBe("mixed");
    expect(r.roles["README.md"]).toBe("other");
    const kinds = (path: string) => [...new Set(r.chunks.filter((c) => c.source === path && c.role === "entry").map((c) => c.kind))];
    expect(kinds("CLAUDE.md").sort()).toEqual(["history", "notes", "rules"]);
    expect(r.chunks.filter((c) => c.source === "CONSTITUTION.md" && c.role === "entry").map((c) => c.key)).toEqual(["1", "2", "3", "4"]);
    expect(r.coverage.every((c) => c.ok)).toBe(true);
    expect(r.refs.filter((x) => x.target).length).toBe(r.refs.length);
    expect(r.log.some((l) => l.includes("Use these 3 files"))).toBe(true);
  });

  it("fixture 2: a large CHANGELOG.md is history and AGENTS.md is rules", async () => {
    const r = await runToSplit(fx.changelogAgents);
    expect(r.roles).toEqual({ "AGENTS.md": "rules", "CHANGELOG.md": "history" });
    expect(r.chunks.filter((c) => c.source === "CHANGELOG.md" && c.role === "entry")).toHaveLength(80);
    expect(r.chunks.filter((c) => c.source === "AGENTS.md" && c.role === "entry")).toHaveLength(4);
    expect(r.coverage.every((c) => c.ok)).toBe(true);
    const resolved = r.refs.filter((x) => x.target).length / r.refs.length;
    expect(resolved).toBeGreaterThanOrEqual(0.95);
  });

  it("fixture 3: HOUSERULES.md is rules, and decision records are notes split by code", async () => {
    const r = await runToSplit(fx.houserulesDecisions);
    expect(r.roles["HOUSERULES.md"]).toBe("rules");
    for (const p of ["docs/decisions/0001-use-postgres.md", "docs/decisions/0002-feature-flags.md", "docs/decisions/0003-no-orm.md"]) {
      expect(r.roles[p]).toBe("notes");
      expect(r.recipe.sources.find((s) => s.path === p)!.sections[0].split).toEqual({ mode: "whole" });
    }
    expect(r.coverage.every((c) => c.ok)).toBe(true);
  });

  it("fixture 4: code and git history only has no memory files to classify", async () => {
    const r = await runToSplit(fx.codeOnly);
    expect(r.state.classes).toEqual([]);
    expect(r.chunks).toEqual([]);
  });

  it("fixture 5: an empty project", async () => {
    const r = await runToSplit(fx.empty);
    expect(r.state.candidates).toEqual([]);
  });

  it("fixture 6: works without git", async () => {
    const r = await runToSplit(fx.noGit, false);
    expect(r.roles).toEqual({ "CLAUDE.md": "rules", "HISTORY.md": "history" });
    expect(r.chunks.filter((c) => c.kind === "history" && c.role === "entry").map((c) => c.summary)).toEqual(["Added export", "First version"]);
    expect(r.coverage.every((c) => c.ok)).toBe(true);
  });

  it("asks before any usage at all: no to the first question means no AI calls", async () => {
    const root = tempProject(fx.noGit, { git: false });
    const log: string[] = [];
    const out = await build({ cwd: root, ask: scriptedAsker({ "small AI model": false }, log), backend: recordedBackend() });
    expect(out.join("\n")).toMatch(/Stopped before using any AI/);
    expect(loadState(root).classes).toBeUndefined();
  });

  it("asks before spending usage, and stops if the person says no", async () => {
    const root = tempProject(fx.noGit, { git: false });
    const log: string[] = [];
    const out = await build({ cwd: root, ask: scriptedAsker({ "Go ahead?": false }, log), backend: recordedBackend() });
    expect(out.join("\n")).toMatch(/Stopped before using any AI/);
    expect(log.findIndex((l) => l.includes("Go ahead?"))).toBeGreaterThan(log.findIndex((l) => l.includes("roughly")));
    // Only the classification ran (it's needed for the estimate); no recipe was written.
    expect(loadRecipe(root)).toBeUndefined();
  });
});
