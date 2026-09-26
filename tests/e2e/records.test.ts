import { describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../../src/commands/build";
import { remove } from "../../src/commands/core";
import { replace, write } from "../../src/commands/living";
import { FakeBackend } from "../../src/ai/backends";
import { scriptedAsker } from "../../src/setup/ask";
import { getBox, loadCube, readDrawer } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { archiveSources } from "../../src/core/archive";
import { approve, listProposals, proposeEdit } from "../../src/core/approvals";
import { loadBoxState, saveBoxState } from "../../src/core/state/state";
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
    await write("Y03.X001", "Z4", "Now also shows errors.", { cwd: root, append: true });
    const z4 = readDrawer(getBox(loadCube(root), "Y03.X001")!, 4)!;
    expect(z4).toMatch(/^<!-- cube:from DESIGN\.md L1-L7 -->\n# Design\n[\s\S]*One toggle\.\n<!-- cube:end-from -->\n\n\*\*Added \d{4}-\d{2}-\d{2}:\*\*\nNow also shows errors\.\n/);
    expect(placedCoverage(root, ["DESIGN.md"])[0].ok).toBe(true);
    expect(loadBoxState(root, "Y03.X001")!.sources![0].wrapped).toBe(true);
    // The markers are what count: a merge that keeps the other side's state (wrapped: false) breaks nothing.
    const st = loadBoxState(root, "Y03.X001")!;
    saveBoxState(root, { ...st, sources: st.sources!.map((s) => ({ ...s, wrapped: false })) });
    expect(placedCoverage(root, ["DESIGN.md"])[0].ok).toBe(true);

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
    expect(await recordIssues(root)).toEqual([]);
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

    // Replacing a rule with new text: the always-loaded block follows, and the check is clean.
    await replace("Y00.X001", "Z0", "- Use npm.", { cwd: root, reason: "we moved to npm" });
    expect(getBox(loadCube(root), "Y00.X001")!.doc!.body).toBe("- Use npm.\n");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Use npm.");
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);

    // An approved invariant edit is the approval check's business, not a record problem.
    proposeEdit(root, "Y02.X001", "## §1 Order\n- Edits apply in order, per device.\n\n", "clarify the scope");
    approve(root, listProposals(root)[0].id);
    expect((await recordIssues(root)).map((i) => i.id)).toEqual(["Y03.X001"]);
  });

  it("can be deleted only by a person with a reason; a folder removed some other way is flagged", async () => {
    const root = await builtAndArchived();
    await expect(remove("Y01.X001", { cwd: root })).rejects.toThrow(/Y01\.X001 holds a record[\s\S]*delete Y01\.X001 --reason "<why>"/);
    expect((await remove("Y01.X001", { cwd: root, reason: "a duplicate of the deploy notes" })).join("\n")).toContain("Logged in context-cube/.state/approvals.log");
    expect(getBox(loadCube(root), "Y01.X001")).toBeUndefined();
    expect(approvalsLog(root).at(-1)).toMatchObject({ kind: "delete-record", box: "Y01.X001", reason: "a duplicate of the deploy notes" });
    expect(await recordIssues(root)).toEqual([]);

    rmSync(getBox(loadCube(root), "Y01.X002")!.dir, { recursive: true });
    const issues = await recordIssues(root);
    expect(issues.map((i) => [i.code, i.id])).toEqual([["record-removed", "Y01.X002"]]);
    expect(issues[0].message).toMatch(/^Y01\.X002 held text moved word for word from HISTORY\.md \(lines \d+–\d+\), but its folder is gone/);
  });
});
