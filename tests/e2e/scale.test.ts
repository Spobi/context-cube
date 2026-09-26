import { describe, expect, it } from "vitest";
import { build } from "../../src/commands/build";
import { FakeBackend } from "../../src/ai/backends";
import { scriptedAsker } from "../../src/setup/ask";
import { allBoxes, loadCube } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { loadBoxState } from "../../src/core/state/state";
import type { AICall } from "../../src/adapters/types";
import { commitAll, tempProject } from "../helpers";

/** A synthetic project about the size of a real app's memory files. */
function bigProject(): Record<string, string> {
  const hist = ["# History", "", "Newest first.", ""];
  for (let i = 250; i >= 1; i--) {
    hist.push(`## 1.${Math.floor(i / 10)}.${i % 10} (${i}) — Change number ${i}`, "", `**Lead paragraph for build ${i}.** It relates to §${1 + (i % 25)}.`);
    for (let k = 0; k < (i % 7) * 4 + 3; k++) hist.push(`- detail ${k} of build ${i}, touching \`Module${i % 12}\``);
    if (i % 5 === 0) hist.push("", "### Notes", "- a subsection", "```swift", "## not a heading", "```");
    hist.push("");
  }
  const inv = ["# Invariants", "", "Read before changing anything below.", ""];
  for (let s = 1; s <= 25; s++) {
    inv.push(`## §${s}. Topic ${s}`, "");
    const bullets = s % 6 === 0 ? 60 : 8;
    for (let b = 0; b < bullets; b++) inv.push(`- Rule ${s}.${b}: \`Module${s % 12}\` must never do thing ${b}. Changed in 1.${Math.floor(s / 10)}.${s % 10} (${s}).`, "  - Why: because.");
    inv.push("");
  }
  const claude = ["# Instructions", "", "## Always do these"];
  for (let r = 1; r <= 30; r++) claude.push(`${r}. Rule number ${r}: keep doing the thing properly.`);
  const files: Record<string, string> = {
    "CLAUDE.md": `${claude.join("\n")}\n`,
    "HISTORY.md": `${hist.join("\n")}\n`,
    "INVARIANTS.md": `${inv.join("\n")}\n`,
  };
  for (let d = 1; d <= 5; d++) {
    const doc = [`# Plan ${d}`, ""];
    for (let sec = 1; sec <= 10; sec++) doc.push(`## Section ${sec}`, ...Array.from({ length: 45 }, (_, i) => `Line ${i} of section ${sec}.`), "");
    files[`docs/PLAN-${d}.md`] = `${doc.join("\n")}\n`;
  }
  for (let m = 0; m < 12; m++) files[`src/Module${m}.swift`] = `final class Module${m} {\n  func run() {}\n}\n`;
  return files;
}

function answer(call: AICall): unknown {
  const ids = (re: RegExp) => [...call.prompt.matchAll(re)].map((m) => m[1]);
  switch (call.step) {
    case "classify":
      return { files: ids(/^## File: (.+)$/gm).map((path) => ({ path, role: path === "CLAUDE.md" ? "rules" : path === "HISTORY.md" ? "history" : path === "INVARIANTS.md" ? "invariants" : "notes", confidence: "high", why: "test" })) };
    case "recipe": {
      const paths = ids(/^## Source: (.+)$/gm);
      const all: any[] = [
        { path: "CLAUDE.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "items" } }] },
        { path: "HISTORY.md", sections: [{ startLine: 1, kind: "history", split: { mode: "heading", level: 2 }, key: "^##\\s+(\\d+\\.\\d+\\.\\d+\\s*\\(\\d+\\))", summary: "—\\s+(.+)$", order: "newest-first" }] },
        { path: "INVARIANTS.md", sections: [{ startLine: 1, kind: "invariants", split: { mode: "heading", level: 2 }, key: "^##\\s+§(\\d+)", maxLines: 60, subsplit: "items" }] },
      ];
      return { version: 1, sources: all.filter((s) => paths.includes(s.path)), refs: [{ pattern: "§(\\d+)", kind: "invariants" }, { pattern: "(\\d+\\.\\d+\\.\\d+\\s*\\(\\d+\\))", kind: "history" }] };
    }
    case "rows": {
      const pieces = ids(/^- (n\d+): /gm);
      return {
        rows: [
          { name: "modules", type: "system", summary: "The app's modules.", readWhen: "Changing a module.", boxes: Array.from({ length: 12 }, (_, m) => ({ name: `module-${m}`, summary: `Module${m}.`, readWhen: `Changing Module${m}.` })) },
          { name: "plans", type: "custom", summary: "Plans.", readWhen: "Planning.", boxes: [] },
        ],
        place: pieces.map((p) => ({ piece: p, row: "plans" })),
      };
    }
    case "history-summaries":
      return { entries: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `entry-${id.slice(-3)}`, summary: `Summary ${id}.`, readWhen: `When ${id}.`, touches: [{ to: "Y03", note: "modules" }], projectWide: false })) };
    case "invariant-labels":
      return { topics: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `topic-${id.slice(-3)}`, label: `Label ${id}`, scope: "modules", readWhen: `Before ${id}.`, governs: [{ to: "Y03.X001", note: "module 0" }] })) };
    case "box-overviews":
      return { pieces: ids(/^### (Y\d+\.X\d+): /gm).map((id) => ({ id, name: `piece-${id.slice(-3)}`, summary: `Piece ${id}.`, readWhen: `When ${id}.` })) };
  }
  throw new Error(call.step);
}

describe("a project the size of a real app", () => {
  it("builds hundreds of boxes quickly, with full coverage and a clean check", async () => {
    const root = tempProject(bigProject());
    commitAll(root, "init");
    const started = Date.now();
    await build({ cwd: root, ask: scriptedAsker({}), backend: new FakeBackend((c) => answer(c)) });
    const seconds = (Date.now() - started) / 1000;
    const cube = loadCube(root);
    const boxes = allBoxes(cube).filter((b) => !b.isRoot).length;
    expect(cube.rows.find((r) => r.type === "history")!.boxes).toHaveLength(250);
    expect(cube.rows.find((r) => r.type === "rules")!.boxes).toHaveLength(30);
    expect(boxes).toBeGreaterThan(330);
    const cov = placedCoverage(root, ["CLAUDE.md", "HISTORY.md", "INVARIANTS.md", ...[1, 2, 3, 4, 5].map((d) => `docs/PLAN-${d}.md`)]);
    expect(cov.filter((c) => !c.ok)).toEqual([]);
    const issues = await runChecks(root);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    // Records get their marks partway through the build; nothing after that may change their text.
    expect(issues.filter((i) => i.code.startsWith("record-"))).toEqual([]);
    expect(Object.keys(loadBoxState(root, cube.rows.find((r) => r.type === "history")!.boxes[0].id)!.records ?? {})).toEqual(["Z4"]);
    expect(seconds).toBeLessThan(90);
  }, 180_000);
});
