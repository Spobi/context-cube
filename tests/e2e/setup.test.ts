import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../../src/setup/setup";
import { scriptedAsker } from "../../src/setup/ask";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { loadRecipe } from "../../src/core/build/recipe";
import { loadCube } from "../../src/core/cube";
import { archiveCmd, restoreCmd } from "../../src/commands/archive";
import { uninstallAgents } from "../../src/core/install";
import { commitAll, tempProject, recordedBackend } from "../helpers";
import * as fx from "../fixtures/projects";
import * as scripted from "../fixtures/scripted";
import { FakeBackend } from "../../src/ai/backends";


// A stand-in for `claude auth status`, so tests never touch the real login.
let fakeClaude = "";
beforeAll(() => {
  const dir = tempProject({}, { git: false });
  fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh\necho '{"loggedIn":true,"subscriptionType":"pro"}'\n`);
  chmodSync(fakeClaude, 0o755);
  process.env.CUBE_CLAUDE_BIN = fakeClaude;
});
afterAll(() => {
  delete process.env.CUBE_CLAUDE_BIN;
});

async function runSetup(files: fx.Files, opts: { git?: boolean; answers?: Record<string, string | boolean>; yes?: boolean } = {}) {
  const git = opts.git ?? true;
  const root = tempProject(files, { git });
  if (git) commitAll(root, "init");
  const log: string[] = [];
  const out = await setup({ cwd: root, yes: opts.yes ?? true, ask: scriptedAsker(opts.answers ?? {}, log), backend: recordedBackend() });
  return { root, log, out };
}

async function passes(root: string) {
  expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
  const recipe = loadRecipe(root);
  if (recipe) expect(placedCoverage(root, recipe.sources.map((s) => s.path)).every((c) => c.ok)).toBe(true);
}

const questions = (log: string[]) => log.filter((l) => l.startsWith("? ")).map((l) => l.slice(2));

describe("npx context-cube on each fixture", () => {
  it("fixture 1: builds from existing files, rewrites rules, archives the originals, and passes check with full coverage", async () => {
    const { root, log, out } = await runSetup(fx.constitutionNotes);
    await passes(root);
    // Questions only where needed: the classify consent, sources, estimate, rows, spot check, then the originals and logger.
    const q = questions(log);
    expect(q[0]).toMatch(/Read their headings and a short sample with a small AI model/);
    expect(q).toContain("Go ahead?");
    expect(q.findIndex((x) => x === "Go ahead?")).toBeLessThan(q.findIndex((x) => x.startsWith("Accept these rows?")));
    expect(q.some((x) => x.startsWith("Rewrite them to point at the cube?"))).toBe(true);
    // Archiving doesn't ask; the summary says where the originals are.
    expect(q.some((x) => /archive/i.test(x))).toBe(false);
    expect(out.join("\n")).toContain("Your original files are stored safely, unchanged, in context-cube/.state/archive/:\n  CLAUDE.md, CONSTITUTION.md, NOTES.md\n  Claude is kept out of that folder");
    // The rule "Read CONSTITUTION.md before touching the sync engine" now points at the invariants row.
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Read the cube's invariants row (Y02) before touching the sync engine.");
    expect(claude).not.toContain("- Y00.X003 Read CONSTITUTION.md");
    // Every original is archived word for word, and a placeholder takes its place (CLAUDE.md keeps the block).
    expect(claude).toContain("This project's instructions now live in its Context Cube");
    for (const f of ["CLAUDE.md", "CONSTITUTION.md", "NOTES.md"]) expect(readFileSync(join(root, "context-cube/.state/archive", f), "utf8")).toBe(fx.constitutionNotes[f]);
    const constitution = readFileSync(join(root, "CONSTITUTION.md"), "utf8");
    expect(constitution).toMatch(/^<!-- context-cube:archived:start -->\n# CONSTITUTION.md \(archived\)/);
    expect(constitution).toContain("mostly in its invariants row (Y02)");
    expect(constitution).toContain("node context-cube/.tool/cube.mjs restore CONSTITUTION.md");
    expect(constitution).not.toContain("§1");
    expect((await runChecks(root)).filter((i) => i.code.startsWith("archive"))).toEqual([]);
    // The summary states the approval default rather than asking about it.
    expect(q.some((x) => /approval/i.test(x))).toBe(false);
    expect(out.join("\n")).toContain("Invariant changes need a person's approval by default.");
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(true);
  });

  it("fixture 2: large changelog", async () => {
    const { root } = await runSetup(fx.changelogAgents);
    await passes(root);
  });

  it("fixture 3: house rules and decisions", async () => {
    const { root } = await runSetup(fx.houserulesDecisions);
    await passes(root);
  });

  it("fixture 5: an empty project gets a fresh cube, with no AI and one question", async () => {
    const { root, log } = await runSetup(fx.empty);
    await passes(root);
    expect(loadCube(root).rows.map((r) => r.name)).toEqual(["rules", "history", "invariants"]);
    expect(questions(log)).toEqual(["How should history be grouped? One entry per:", expect.stringMatching(/Also log which files/)]);
  });

  it("fixture 6: no git", async () => {
    const { root } = await runSetup(fx.noGit, { git: false });
    await passes(root);
    expect(JSON.parse(readFileSync(join(root, "context-cube/cube.config.json"), "utf8")).update.trigger).toBe("commit");
  });

  it("running it again offers an update instead of rebuilding", async () => {
    const { root } = await runSetup(fx.houserulesDecisions);
    const log: string[] = [];
    const out = await setup({ cwd: root, yes: true, ask: scriptedAsker({}, log), backend: recordedBackend() });
    expect(log).toContain("A cube already exists here.");
    expect(questions(log)[0]).toMatch(/^Update it/);
    expect(out.join("\n")).toMatch(/^Updated: \d+ rows/);
  });

  it("running it again after a usage limit finishes the build, instead of updating a half-built cube", async () => {
    const root = tempProject(scripted.files);
    commitAll(root, "init");
    let limited = false;
    const backend = new FakeBackend((c) => {
      if (c.step === "history-summaries" && !limited) {
        limited = true;
        return new Error("You've hit your session limit · resets 6:20pm (America/New_York)");
      }
      return scripted.answer(c);
    });
    const first = await setup({ cwd: root, yes: true, ask: scriptedAsker({}, []), backend });
    expect(first.join("\n")).toContain("Paused: your Claude plan hit a usage limit.");
    // Boxes are placed, so a cube "exists", but the build isn't done.
    const log: string[] = [];
    const out = await setup({ cwd: root, yes: true, ask: scriptedAsker({}, log), backend });
    expect(log).not.toContain("A cube already exists here.");
    expect(log).toContain("Continuing the build that was in progress.\n");
    expect(out.join("\n")).toContain("All set.");
    expect(existsSync(join(root, "context-cube/.state/archive/HISTORY.md"))).toBe(true);
    await passes(root);
  });

  it("restore puts the originals back exactly, and archive moves them again, with full coverage throughout", async () => {
    const { root } = await runSetup(fx.constitutionNotes);
    const back = restoreCmd([], { cwd: root, all: true });
    expect(back.join("\n")).toContain("Put back 3 files");
    expect(readFileSync(join(root, "CONSTITUTION.md"), "utf8")).toBe(fx.constitutionNotes["CONSTITUTION.md"]);
    expect(readFileSync(join(root, "NOTES.md"), "utf8")).toBe(fx.constitutionNotes["NOTES.md"]);
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude.startsWith(fx.constitutionNotes["CLAUDE.md"])).toBe(true);
    expect(claude).toContain("<!-- context-cube:start -->");
    expect(existsSync(join(root, "context-cube/.state/archive"))).toBe(false);
    await passes(root);
    expect(archiveCmd(["CONSTITUTION.md"], { cwd: root }).join("\n")).toContain("Archived 1 file");
    expect(archiveCmd([], { cwd: root }).join("\n")).toContain("Archived 2 files");
    expect(readFileSync(join(root, "context-cube/.state/archive/CONSTITUTION.md"), "utf8")).toBe(fx.constitutionNotes["CONSTITUTION.md"]);
    await passes(root);
  });

  it("keeps text added to an archived file: check flags it, restore won't overwrite it, and --to copies the original", async () => {
    const { root } = await runSetup(fx.constitutionNotes);
    writeFileSync(join(root, "NOTES.md"), `${readFileSync(join(root, "NOTES.md"), "utf8")}\n## New lesson\nAlways debounce saves.\n`);
    const issue = (await runChecks(root)).find((i) => i.code === "archived-file-changed");
    expect(issue?.message).toBe("NOTES.md was archived, but 2 lines were added to it since. That text isn't in the cube.");
    expect(restoreCmd(["NOTES.md"], { cwd: root }).join("\n")).toMatch(/Skipped NOTES.md: text was added to it after it was archived/);
    const out = tempProject({}, { git: false });
    expect(restoreCmd(["NOTES.md"], { cwd: root, to: out }).join("\n")).toContain("the archive is unchanged");
    expect(readFileSync(join(out, "NOTES.md"), "utf8")).toBe(fx.constitutionNotes["NOTES.md"]);
    expect(existsSync(join(root, "context-cube/.state/archive/NOTES.md"))).toBe(true);
  });

  it("won't archive a file whose current text the cube doesn't hold", async () => {
    const { root } = await runSetup(fx.constitutionNotes);
    restoreCmd(["NOTES.md"], { cwd: root });
    writeFileSync(join(root, "NOTES.md"), `${fx.constitutionNotes["NOTES.md"]}\n## Added after the build\nNot in the cube yet.\n`);
    const out = archiveCmd(["NOTES.md"], { cwd: root }).join("\n");
    expect(out).toMatch(/Left NOTES.md in place: the cube doesn't hold all of its current text word for word/);
    expect(existsSync(join(root, "context-cube/.state/archive/NOTES.md"))).toBe(false);
  });

  it("rebuilds from scratch after archiving: uninstall, restore, move the cube away, and the same build comes out", async () => {
    const { root } = await runSetup(fx.constitutionNotes);
    const before = loadCube(root).rows.map((r) => `${r.id} ${r.name} ${r.boxes.length}`);
    await uninstallAgents(root);
    restoreCmd([], { cwd: root, all: true });
    renameSync(join(root, "context-cube"), join(tempProject({}, { git: false }), "old-cube"));
    const log: string[] = [];
    await setup({ cwd: root, yes: true, logger: false, ask: scriptedAsker({}, log), backend: recordedBackend() });
    await passes(root);
    expect(loadCube(root).rows.map((r) => `${r.id} ${r.name} ${r.boxes.length}`)).toEqual(before);
    expect(readFileSync(join(root, "context-cube/.state/archive/CONSTITUTION.md"), "utf8")).toBe(fx.constitutionNotes["CONSTITUTION.md"]);
  });

  it("stops and says what to do when placeholders are left but the cube that archived them is gone", async () => {
    const { root } = await runSetup(fx.constitutionNotes);
    rmSync(join(root, "context-cube"), { recursive: true, force: true });
    const out = (await setup({ cwd: root, yes: true, ask: scriptedAsker({}), backend: recordedBackend() })).join("\n");
    expect(out).toContain("CLAUDE.md, CONSTITUTION.md, NOTES.md are placeholders left by an earlier Context Cube");
    expect(out).toContain("node context-cube/.tool/cube.mjs restore --all");
  });

  it("without --yes and no terminal, it doesn't rewrite rules, but still archives the originals", async () => {
    const { root } = await runSetup(fx.constitutionNotes, { yes: false });
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("- Y00.X003 Read CONSTITUTION.md before touching the sync engine.");
    for (const f of ["CLAUDE.md", "CONSTITUTION.md", "NOTES.md"]) expect(readFileSync(join(root, "context-cube/.state/archive", f), "utf8")).toBe(fx.constitutionNotes[f]);
    await passes(root);
  });
});
