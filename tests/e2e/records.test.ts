import { describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../../src/commands/build";
import { init, move, remove } from "../../src/commands/core";
import { createBox, createRow } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { addFragment, closeEntry } from "../../src/core/history";
import { replace, write } from "../../src/commands/living";
import { FakeBackend } from "../../src/ai/backends";
import { scriptedAsker } from "../../src/setup/ask";
import { getBox, loadCube, readDrawer } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { archiveSources } from "../../src/core/archive";
import { approve, listProposals, proposeEdit } from "../../src/core/approvals";
import { loadBoxState, saveBoxState, sha } from "../../src/core/state/state";
import { wrapPiece } from "../../src/core/build/place";
import { listArchived } from "../../src/core/build/sources";
import { readJsonl } from "../../src/core/fsutil";
import { commitAll, tempProject } from "../helpers";
import { answer, files } from "../fixtures/scripted";

/** A cube built from the scripted project, with its originals archived as setup does. */
async function builtAndArchived(): Promise<string> {
  const root = tempProject(files);
  commitAll(root);
  await build({ cwd: root, ask: scriptedAsker({}, []), backend: new FakeBackend((c) => answer(c)) });
  expect(archiveSources(root).archived).toEqual(expect.arrayContaining(["DESIGN.md", "HISTORY.md", "INVARIANTS.md"]));
  return root;
}

const recordIssues = async (root: string) => (await runChecks(root)).filter((i) => i.code.startsWith("record-"));
const approvalsLog = (root: string) => readJsonl<Record<string, unknown>>(join(root, "context-cube/.state/approvals.log"));
const z4Path = (root: string, id: string) => join(getBox(loadCube(root), id)!.dir, "Z4-detail.md");

describe("records: text moved from the original files, and closed history entries", () => {
  it("can't be rewritten; --append adds a dated note below and keeps the word-for-word proof", async () => {
    const root = await builtAndArchived();
    expect(await recordIssues(root)).toEqual([]);

    // A design note moved word for word (DESIGN.md became Y03.X001's Z4).
    await expect(write("Y03.X001", "Z4", "Shows progress and errors.", { cwd: root })).rejects.toThrow(
      /Y03\.X001\.Z4 holds text moved word for word from DESIGN\.md \(lines 1–7\)\. Records aren't rewritten[\s\S]*write Y03\.X001 Z4 --append @<file>/,
    );
    const mark = loadBoxState(root, "Y03.X001")!.records!.Z4;
    expect(mark).toMatchObject({ chars: readDrawer(getBox(loadCube(root), "Y03.X001")!, 4)!.length });
    await write("Y03.X001", "Z4", "Now also shows errors.", { cwd: root, append: true });
    const z4 = readDrawer(getBox(loadCube(root), "Y03.X001")!, 4)!;
    // A pure addition: the text above is untouched, and the record's mark still covers exactly it.
    expect(z4).toMatch(/^# Design\n[\s\S]*One toggle\.\n\n\*\*Added \d{4}-\d{2}-\d{2}:\*\*\nNow also shows errors\.\n/);
    expect(loadBoxState(root, "Y03.X001")!.records!.Z4).toEqual(mark);
    expect(placedCoverage(root, ["DESIGN.md"])[0].ok).toBe(true);
    // A drawer from 0.2.0, whose first note wrapped the text in markers: the markers are what count,
    // even when a merge kept the other side's state (wrapped: false).
    writeFileSync(z4Path(root, "Y03.X001"), `${wrapPiece({ source: "DESIGN.md", start: 1, end: 7, text: readFileSync(join(root, "context-cube/.state/archive/DESIGN.md"), "utf8") })}\nNotes.\n`);
    expect(placedCoverage(root, ["DESIGN.md"])[0].ok).toBe(true);
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);

    // A closed history entry moved from HISTORY.md.
    await expect(write("Y01.X001", "Z4", "Server went live, eventually.", { cwd: root })).rejects.toThrow(/Y01\.X001\.Z4 holds text moved word for word from HISTORY\.md \(lines \d+–\d+\), in a closed history entry/);
    await write("Y01.X001", "Z4", "The deploy was retried once; the first attempt ran out of disk.", { cwd: root, append: true });
    expect(placedCoverage(root, ["HISTORY.md"])[0].ok).toBe(true);

    // A migrated rule lives in Z0: no --append (it would load every session); a person replaces it.
    const rule = await write("Y00.X001", "Z0", "- Use npm.", { cwd: root }).catch((e: Error) => e.message);
    expect(rule).toContain("Y00.X001.Z0 holds text moved word for word from AGENTS.md");
    expect(rule).toContain('replace Y00.X001 Z0 @<file> --reason "<why>" (a person confirms it)');
    expect(rule).not.toContain("--append");
    await expect(write("Y00.X001", "Z0", "- Also yarn.", { cwd: root, append: true })).rejects.toThrow(/--append adds to Z1, Z3, or Z4/);

    // Drawers that aren't records are written as before.
    await write("Y03.X001", "Z3", "Notes of our own.\n", { cwd: root });
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);
  });

  it("are checked against the archive: a change made some other way is flagged until a person records it", async () => {
    const root = await builtAndArchived();
    const path = z4Path(root, "Y03.X001");
    writeFileSync(path, readFileSync(path, "utf8").replace("One toggle.", "Two toggles."));
    let issues = await recordIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "warn", code: "record-changed", id: "Y03.X001" });
    expect(issues[0].message).toBe("Y03.X001.Z4 no longer holds DESIGN.md (lines 1–7) word for word. The original is in the archive.");
    expect(issues[0].fix).toContain('replace Y03.X001 Z4 --reason "<why>"');

    // A person says it was on purpose.
    await expect(replace("Y03.X001", "Z4", undefined, { cwd: root })).rejects.toThrow(/--reason/);
    await replace("Y03.X001", "Z4", undefined, { cwd: root, reason: "the settings screen has two toggles now" });
    expect(await recordIssues(root)).toEqual([]);
    expect(approvalsLog(root).at(-1)).toMatchObject({ kind: "replace-record", box: "Y03.X001", drawer: "Z4", sources: ["DESIGN.md L1-L7"], reviewedByPerson: true });

    // Adding to it keeps it recorded, without claiming the replaced text is the original; changing it again doesn't.
    await write("Y03.X001", "Z4", "And a reset button.", { cwd: root, append: true });
    expect(readFileSync(path, "utf8")).not.toContain("cube:from");
    expect(await recordIssues(root)).toEqual([]);
    writeFileSync(path, readFileSync(path, "utf8").replace("Two toggles.", "Three toggles."));
    issues = await recordIssues(root);
    expect(issues[0].message).toMatch(/\(a person replaced it on \d{4}-\d{2}-\d{2}, and it has changed since\)/);
    // Adding a note after that change doesn't acknowledge it: the warning stays, and the command says so.
    const added = await write("Y03.X001", "Z4", "And a dark mode.", { cwd: root, append: true });
    expect(added.join("\n")).toContain("Y03.X001.Z4 had been changed outside the tool before this note, and it still counts as changed");
    expect((await recordIssues(root)).map((i) => [i.code, i.id])).toEqual([["record-changed", "Y03.X001"]]);

    // Replacing a rule with new text: the always-loaded block follows, the old text is kept in the archive, and the check is clean.
    const rule = getBox(loadCube(root), "Y00.X001")!.doc!.body;
    await replace("Y00.X001", "Z0", "- Use npm.", { cwd: root, reason: "we moved to npm" });
    expect(getBox(loadCube(root), "Y00.X001")!.doc!.body).toBe("- Use npm.\n");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Use npm.");
    const kept = approvalsLog(root).at(-1)!.kept as string;
    expect(kept).toMatch(/^context-cube\/\.state\/archive\/\.records\/replaced\/Y00\.X001\/Z0-\d{4}-\d{2}-\d{2}T\d{6}\.md$/);
    expect(readFileSync(join(root, kept), "utf8")).toBe(rule);
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);

    // An approved invariant edit is the approval check's business, not a record problem.
    proposeEdit(root, "Y02.X001", "## §1 Order\n- Edits apply in order, per device.\n\n", "clarify the scope");
    approve(root, listProposals(root)[0].id);
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);
  });

  it("can be deleted only by a person with a reason; a folder removed some other way is flagged", async () => {
    const root = await builtAndArchived();
    await expect(remove("Y01.X001", { cwd: root })).rejects.toThrow(/Y01\.X001 holds a record[\s\S]*delete Y01\.X001 --reason "<why>"/);
    const text = readDrawer(getBox(loadCube(root), "Y01.X001")!, 4)!;
    const said = (await remove("Y01.X001", { cwd: root, reason: "a duplicate of the deploy notes" })).join("\n");
    expect(said).toContain("Logged in context-cube/.state/approvals.log");
    expect(getBox(loadCube(root), "Y01.X001")).toBeUndefined();
    expect(approvalsLog(root).at(-1)).toMatchObject({ kind: "delete-record", box: "Y01.X001", reason: "a duplicate of the deploy notes" });
    // Its folder is kept in the archive, and the message says where (not "git has it").
    const kept = approvalsLog(root).at(-1)!.kept as string;
    expect(said).toContain(`A copy of its folder is kept in ${kept}/`);
    expect(readFileSync(join(root, kept, "Z4-detail.md"), "utf8")).toBe(text);
    expect(JSON.parse(readFileSync(join(root, kept, "box-state.json"), "utf8"))).toMatchObject({ id: "Y01.X001", records: { Z4: {} } });
    // Kept records aren't archived source files: restore doesn't offer them.
    expect(listArchived(root)).toEqual(["AGENTS.md", "DESIGN.md", "HISTORY.md", "INVARIANTS.md"]);
    expect(await recordIssues(root)).toEqual([]);

    rmSync(getBox(loadCube(root), "Y01.X002")!.dir, { recursive: true });
    const issues = await recordIssues(root);
    expect(issues.map((i) => [i.code, i.id])).toEqual([["record-removed", "Y01.X002"]]);
    expect(issues[0].message).toMatch(/^Y01\.X002 held text moved word for word from HISTORY\.md \(lines \d+–\d+\), but its folder is gone/);
  });
});

/** A cube made after setup (no build, no archive) with one closed history entry. */
async function withClosedEntry(opts: { git?: boolean } = {}): Promise<string> {
  const root = tempProject({ "src/clock.ts": "export const x = 1;\n" }, opts);
  await init({ cwd: root, historyUnit: "build" });
  addFragment(root, "Tried a worker thread for the clock.", { key: "1.0.1", by: "Jordan" });
  addFragment(root, "It deadlocked the audio session. Don't retry it.", { key: "1.0.1", by: "Jordan" });
  closeEntry(root, {});
  await reindex(root);
  return root;
}

describe("records written after setup", () => {
  it("a history entry is a record from the moment it closes: a rewrite, a removed file, or a move doesn't get past that", async () => {
    const root = await withClosedEntry();
    expect(loadBoxState(root, "Y01.X001")!.records!.Z4).toMatchObject({ chars: "Tried a worker thread for the clock.\n\nIt deadlocked the audio session. Don't retry it.\n".length });
    expect(await recordIssues(root)).toEqual([]);

    // Rewritten outside the tool (the guard stops an agent's edit; this is a shell or an editor).
    const path = z4Path(root, "Y01.X001");
    writeFileSync(path, readFileSync(path, "utf8").replace(" Don't retry it.", ""));
    let issues = await recordIssues(root);
    expect(issues.map((i) => [i.code, i.id])).toEqual([["record-changed", "Y01.X001"]]);
    expect(issues[0].message).toBe("Y01.X001.Z4 no longer holds its recorded text word for word.");
    expect(issues[0].fix).toContain(`git has it if it was committed (git log -p -- context-cube/${getBox(loadCube(root), "Y01.X001")!.relDir}/Z4-detail.md)`);

    // Its file removed: still a record. It's reported, and an ordinary write can't fill the gap.
    rmSync(path);
    issues = await recordIssues(root);
    expect(issues.map((i) => [i.code, i.id])).toEqual([["record-missing", "Y01.X001"]]);
    expect(issues[0].message).toBe("Y01.X001.Z4 holds a record, but its file is gone.");
    await expect(write("Y01.X001", "Z4", "Clock work.", { cwd: root })).rejects.toThrow(/Y01\.X001\.Z4 is a closed history entry[\s\S]*Its file is gone/);
    await expect(replace("Y01.X001", "Z4", undefined, { cwd: root, reason: "gone" })).rejects.toThrow(/file is gone, so there's no text to record/);
    // A person gives it text again.
    await replace("Y01.X001", "Z4", "Tried a worker thread; it deadlocked.\n", { cwd: root, reason: "lost in a bad rebase" });
    expect(await recordIssues(root)).toEqual([]);

    // Moved into a feature row: it's still a record, wherever it goes.
    createRow(root, { type: "feature", name: "clock", summary: "The call clock.", readWhen: "Changing the clock." });
    const moved = await move("Y01.X001", "Y03", { cwd: root });
    expect(moved[0]).toContain("Y01.X001 → Y03.X001");
    await expect(write("Y03.X001", "Z4", "Rewritten.", { cwd: root })).rejects.toThrow(/Y03\.X001\.Z4 is a record: text kept as it was written/);
    expect(await recordIssues(root)).toEqual([]);
  });

  it("a move that rewrites a reference inside a record keeps its mark in step", async () => {
    const root = tempProject({});
    await init({ cwd: root, historyUnit: "build" });
    createRow(root, { type: "feature", name: "calls", summary: "Calls.", readWhen: "Changing calls." });
    createBox(root, "Y03", { name: "ringing", summary: "Ringing.", readWhen: "Changing ringing." });
    createRow(root, { type: "feature", name: "audio", summary: "Audio.", readWhen: "Changing audio." });
    addFragment(root, "Ringing ([[Y03.X001]]) now stops after 30 seconds.", { key: "1.0.2" });
    closeEntry(root, {});
    await reindex(root);
    await move("Y03.X001", "Y04", { cwd: root });
    expect(readDrawer(getBox(loadCube(root), "Y01.X001")!, 4)).toContain("[[Y04.X001]]");
    expect(await recordIssues(root)).toEqual([]);
  });

  it("without git, a deleted record is still recoverable, and the messages don't promise git", async () => {
    const root = await withClosedEntry({ git: false });
    const text = readDrawer(getBox(loadCube(root), "Y01.X001")!, 4)!;
    const said = (await remove("Y01.X001", { cwd: root, reason: "a duplicate" })).join("\n");
    expect(said).not.toContain("git");
    const kept = approvalsLog(root).at(-1)!.kept as string;
    expect(kept).toMatch(/^context-cube\/\.state\/archive\/\.records\/deleted\/Y01\.X001-/);
    expect(said).toContain(kept);
    expect(readFileSync(join(root, kept, "Z4-detail.md"), "utf8")).toBe(text);

    // A record changed outside the tool, with no git and no archive: the check says there's no other copy.
    addFragment(root, "Moved the clock to the server.", { key: "1.0.2" });
    closeEntry(root, {});
    await reindex(root);
    const path = z4Path(root, "Y01.X002");
    writeFileSync(path, "Something else.\n");
    const [issue] = await recordIssues(root);
    expect(issue.fix).toContain("There's no other copy of the earlier text: the project isn't in git, and the text wasn't archived.");
    expect(issue.fix).not.toContain("git log");
  });
});

describe("cubes from 0.2.0", () => {
  it("get marks on the next index; a replacement's checksum carries over, so an earlier change is still reported", async () => {
    const root = await withClosedEntry();
    // As 0.2.0 left them: no marks; one record replaced by a person (a checksum of the whole drawer).
    addFragment(root, "Moved the clock to the server.", { key: "1.0.2" });
    closeEntry(root, {});
    const own = (id: string) => readFileSync(z4Path(root, id), "utf8");
    for (const [id, replaced] of [["Y01.X001", undefined], ["Y01.X002", { Z4: { at: "2026-09-26T10:00:00.000Z", sha: sha(own("Y01.X002")) } }]] as const) {
      const st = loadBoxState(root, id)!;
      delete st.records;
      saveBoxState(root, { ...st, ...(replaced ? { replaced } : {}) });
    }
    writeFileSync(z4Path(root, "Y01.X002"), "Changed after the replacement.\n");
    await reindex(root);
    expect(loadBoxState(root, "Y01.X001")!.records!.Z4).toMatchObject({ chars: own("Y01.X001").split("\n<!-- cube:generated:start -->")[0].length });
    const st = loadBoxState(root, "Y01.X002")!;
    expect(st.replaced).toBeUndefined();
    expect(st.records!.Z4).toMatchObject({ at: "2026-09-26T10:00:00.000Z", replaced: true });
    expect((await recordIssues(root)).map((i) => [i.code, i.id])).toEqual([["record-changed", "Y01.X002"]]);
  });
});
