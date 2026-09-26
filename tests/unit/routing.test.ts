import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodeIndex, codeOnly, filesWithName, usesAsCode } from "../../src/core/code/search";
import { linkCode, linkText } from "../../src/core/code/links";
import { linkStrength } from "../../src/core/code/governs";
import { pathRulesFor } from "../../src/core/code/pathRules";
import { computeStatus } from "../../src/core/code/status";
import { getBox, loadCube } from "../../src/core/cube";
import { createBox, writeDrawer } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { related, renderRelated } from "../../src/core/related";
import { runChecks } from "../../src/core/check/check";
import { supersede } from "../../src/commands/living";
import { ruleRewrites } from "../../src/setup/originals";
import { smallCube } from "../fixtures/build";

const swift = [
  "import CallKit",
  "// The ring window is out-of-band: head-of-line blocking can't touch it.",
  "let appStoreURL = URL(string: \"https://apps.apple.com/app/id1\")!",
  "/* A block comment about the high-fidelity path",
  "   that spans lines. */",
  "enum ChannelState { case subscribed, closed }",
  "func clockHandshake() { let label = \"Calling…\"; channel.status = .subscribed }",
  "",
].join("\n");

describe("the code index skips prose", () => {
  it("blanks comments, URLs, and import lines, keeping every line where it was", () => {
    const out = codeOnly(swift, "Call.swift");
    expect(out.split("\n")).toHaveLength(swift.split("\n").length);
    expect(out).not.toMatch(/band|head|apple|high|CallKit/);
    expect(out).toContain("clockHandshake");
    expect(out).toContain('"Calling…"'); // strings stay (event names live in them)
    expect(codeOnly(swift, "Call.swift", { strings: "blank" })).not.toContain("Calling");
    // A hash-comment language and SQL.
    expect(codeOnly("x = 1  # the head of the queue\ny = 'a # b'\n", "q.py")).toBe(`x = 1  ${" ".repeat("# the head of the queue".length)}\ny = 'a # b'\n`);
    expect(codeOnly("select 1; -- head\n", "q.sql")).toBe(`select 1; ${" ".repeat("-- head".length)}\n`);
  });

  it("counts a plain word only where the code uses it as code", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/Call.swift": swift });
    const idx = buildCodeIndex(root);
    // Words that appear only in comments, URLs, or imports aren't found at all.
    for (const w of ["band", "head", "apple", "high", "CallKit"]) expect(filesWithName(idx, w)).toEqual([]);
    // Comments still count when asking whether a name exists at all (for staleness).
    expect(filesWithName(idx, "head", 5, { raw: true })).toEqual(["src/Call.swift"]);
    // "Calling" appears only inside a string's prose; "subscribed" is an enum case.
    expect(filesWithName(idx, "Calling")).toEqual(["src/Call.swift"]);
    expect(usesAsCode(idx, "src/Call.swift", "Calling")).toBe(false);
    expect(usesAsCode(idx, "src/Call.swift", "subscribed")).toBe(true);
    const linked = linkText(idx, "The `Calling` label and the `subscribed` state, set in `clockHandshake`. Out-of-`band`, `head`-of-line.");
    expect(linked.names.sort()).toEqual(["clockHandshake", "subscribed"]);
  });

  it("doesn't mark a box needs-review because a name it links to is only in a comment", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/Call.swift": swift });
    writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake`.\n");
    linkCode(root);
    expect(computeStatus(root).filter((s) => s.status === "needs-review")).toEqual([]);
  });
});

describe("re-linking after an update", () => {
  it("keeps the fingerprints of files already linked, so a change still shows as stale", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/Call.swift": swift });
    writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake`.\n");
    linkCode(root);
    writeFileSync(join(root, "src/Call.swift"), `${swift}func later() {}\n`);
    linkCode(root, undefined, { keepFingerprints: true });
    expect(computeStatus(root).map((s) => [s.id, s.status])).toContainEqual(["Y03.X001", "stale"]);
    linkCode(root);
    expect(computeStatus(root)).toEqual([]);
  });
});

describe("how clearly a box is tied to a file", () => {
  it("weighs a named file over a specific code name over a plain word", () => {
    expect(linkStrength("named in the text")).toBe(3);
    expect(linkStrength("`clockHandshake` (line 7)")).toBe(2);
    expect(linkStrength("`decline` (line 3)")).toBe(1);
    expect(linkStrength("`a1` (line 1), `b_c` (line 2), `d` (line 3), `e` (line 4), and 3 more")).toBe(4 + 1 + 1 + 3);
  });

  it("related ranks invariants, and lists weak links apart", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/Call.swift": swift });
    createBox(root, 2, { name: "state-machine", summary: "Channel states never skip.", readWhen: "Changing channel state.", drawers: { 1: "- `subscribed` is only set after the echo.\n" }, writtenBy: "migrated" });
    writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake` from `src/Call.swift`.\n");
    linkCode(root);
    await reindex(root);
    const r = related(root, "src/Call.swift", root);
    // Y02.X001 through the handshake box (which names the file); Y02.X002 only by one plain word.
    expect(r.invariants.map((b) => b.id)).toEqual(["Y02.X001"]);
    expect(r.weak.map((b) => b.id)).toEqual(["Y02.X002"]);
    expect(renderRelated(r)).toContain("Linked only by a plain word or two, which may be prose (open one only if the task is about it): Y02.X002 state-machine");
    // Path rules only for clear links, and only for invariants.
    const rules = pathRulesFor(loadCube(root));
    expect(rules.map((x) => x.id)).toEqual(["cube-Y02-X001"]);
    expect(rules[0].body).toMatch(/^Context Cube: before editing this file, open invariant Y02\.X001, a rule that must never be broken: Both phones agree on one end time for every call\. → context-cube\/Y02-invariants\/X001-sixty-second-clock\/Z1-invariants\.md\n$/);
    expect(rules[0].body).not.toContain("handshake that fixes");
  });
});

describe("superseded notes", () => {
  async function cubeWithPlan() {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/Call.swift": swift });
    createBox(root, 3, {
      name: "stay-on-balanced",
      summary: "Recommends keeping the balanced degradation preference.",
      readWhen: "Choosing a degradation preference.",
      links: [{ to: "Y02.X001", rel: "governed-by", note: "clock" }],
      drawers: { 4: "We recommend staying on .balanced; see `clockHandshake`.\n" },
      source: "docs/VIDEO-PLAN.md L10-L20, \"Recommendation\"",
      writtenBy: "migrated",
    });
    linkCode(root);
    await reindex(root);
    return root;
  }

  it("marks a replaced note, keeps its text, and stops it routing agents to invariants", async () => {
    const root = await cubeWithPlan();
    const rowMd = () => readFileSync(join(root, "context-cube/Y03-sync/ROW.md"), "utf8");
    expect(rowMd()).toContain("from VIDEO-PLAN.md (dated: says what was meant or found then)");
    expect(related(root, "src/Call.swift", root).invariants.find((b) => b.id === "Y02.X001")!.why).toContain("via Y03.X002");

    const out = await supersede("Y03.X002", { by: "Y01.X001", note: "1.0.1 shipped maintainResolution instead.", cwd: root });
    expect(out[0]).toMatch(/^Marked Y03\.X002 superseded by Y01\.X001\./);
    const box = getBox(loadCube(root), "Y03.X002")!;
    expect(box.header!.status).toBe("superseded");
    expect(box.header!.links).toContainEqual(expect.objectContaining({ to: "Y01.X001", rel: "superseded-by" }));
    const z4 = readFileSync(join(box.dir, "Z4-detail.md"), "utf8");
    expect(z4.startsWith("We recommend staying on .balanced")).toBe(true);
    expect(z4).toMatch(/\*\*Added \d{4}-\d{2}-\d{2}:\*\*\nSuperseded by \[\[Y01\.X001\]\] build-1-0-1: 1\.0\.1 shipped maintainResolution instead\./);
    expect(rowMd()).toContain("SUPERSEDED: a later decision replaced it");
    // It no longer passes invariants on, is listed last, and says so.
    const r = related(root, "src/Call.swift", root);
    expect(r.invariants.map((b) => b.id)).not.toContain("Y02.X001"); // the plan was its only route to the file
    expect(r.boxes.map((b) => b.id).at(-1)).toBe("Y03.X002");
    expect(r.boxes.at(-1)!.summary).toMatch(/^\(superseded by Y01\.X001: read its last note first\)/);
    // A change to its code doesn't turn it back into "stale".
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);

    const undo = await supersede("Y03.X002", { undo: true, cwd: root });
    expect(undo[0]).toContain("marked current again");
    expect(getBox(loadCube(root), "Y03.X002")!.header!.status).toBe("ok");
  });

  it("refuses history, invariants, and rules, naming what to do instead", async () => {
    const root = await cubeWithPlan();
    await expect(supersede("Y01.X001", { note: "x", cwd: root })).rejects.toThrow(/past record already/);
    await expect(supersede("Y02.X001", { note: "x", cwd: root })).rejects.toThrow(/propose edit/);
    await expect(supersede("Y00.X001", { note: "x", cwd: root })).rejects.toThrow(/delete Y00\.X001 --reason/);
    await expect(supersede("Y03.X002", { cwd: root })).rejects.toThrow(/Say what's true now/);
  });
});

describe("rules pointing at archived files", () => {
  it("say which cube command replaces updating the file", async () => {
    const root = await smallCube();
    createBox(root, 0, { name: "update-history", summary: "Update HISTORY.md.", readWhen: "Always.", body: "3. **Update `HISTORY.md`** whenever you change code.\n", writtenBy: "migrated" });
    createBox(root, 0, { name: "read-history", summary: "Read HISTORY.md.", readWhen: "Always.", body: "1. **Read `HISTORY.md`** (repo root) at the start of work.\n", writtenBy: "migrated" });
    const rw = ruleRewrites(root, [{ path: "HISTORY.md", rowId: "Y01", rowName: "history" }]);
    expect(rw.map((r) => r.newText)).toEqual([
      '3. **Update the cube\'s history row (Y01)** whenever you change code. (In the cube: add history with `node context-cube/.tool/cube.mjs history add "<what changed>"`.)\n',
      "1. **Read the cube's history row (Y01)** at the start of work.\n",
    ]);
  });

  it("check names rules that came from files that aren't agent instructions when the block is over its ceiling", async () => {
    const root = await smallCube();
    for (let i = 1; i <= 6; i++) {
      createBox(root, 0, { name: `step-${i}`, summary: `Release step ${i}.`, readWhen: "Always.", body: `${"Run the release checklist carefully. ".repeat(80)}\n`, source: `docs/RUNBOOK.md L${i * 10}-L${i * 10 + 9}, "Step ${i}"`, writtenBy: "migrated" });
    }
    await reindex(root);
    const issue = (await runChecks(root)).find((i) => i.code === "block-too-large")!;
    expect(issue.fix).toContain("6 rules came from docs/RUNBOOK.md, not an agent instruction file (Y00.X002, Y00.X003, Y00.X004, Y00.X005, Y00.X006, Y00.X007)");
    expect(issue.fix).toContain("move <id> <row>");
  });
});
