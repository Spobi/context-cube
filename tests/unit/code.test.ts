import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/commands/core";
import { status, ok } from "../../src/commands/code";
import { createBox } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { linkCode, mentions, commitsForKey } from "../../src/core/code/links";
import { computeStatus } from "../../src/core/code/status";
import { sessionNotice } from "../../src/core/code/notice";
import { getBox, loadCube, readDrawer } from "../../src/core/cube";
import { commitAll, tempProject } from "../helpers";

async function project() {
  const root = tempProject({
    "src/call/clock.swift": "final class CallClock {\n  func endTime() -> Date { Date() }\n}\n",
    "src/call/ring.swift": "struct RingProbe { let deadline: Int }\n",
    "src/util.ts": "export function formatDate() {}\n",
  });
  await init({ cwd: root });
  createBox(root, 2, {
    name: "sixty-second-clock",
    summary: "Both phones agree on one end time.",
    readWhen: "Changing call timing.",
    drawers: { 1: "- `CallClock.endTime()` must return the same instant on both phones.\n- See src/call/ring.swift for the `RingProbe` deadline.\n" },
  });
  createBox(root, 1, {
    name: "clock-fix",
    summary: "Fixed the clock.",
    readWhen: "Debugging the clock.",
    drawers: { 4: "## 1.0.8 (6) — Fixed the clock\n`CallClock` now rounds.\n" },
    source: 'HISTORY.md L1-L3, "1.0.8 (6) — Fixed the clock"',
  });
  commitAll(root, "Tidepool 1.0.8 (6): fix the clock");
  linkCode(root);
  await reindex(root);
  commitAll(root, "cube");
  return root;
}

describe("code links", () => {
  it("finds paths and code names in text", () => {
    const m = mentions("Call `CallClock.endTime()` and see src/call/ring.swift. The started_at column and answerIncoming() matter.");
    expect(m.paths).toContain("src/call/ring.swift");
    expect(m.names).toEqual(expect.arrayContaining(["CallClock", "endTime", "started_at", "answerIncoming"]));
  });

  it("links boxes to the files that contain their names, with fingerprints, and shows them in Z2", async () => {
    const root = await project();
    const box = getBox(loadCube(root), "Y02.X001")!;
    const z2 = readDrawer(box, 2)!;
    expect(z2).toContain("`src/call/clock.swift`: `CallClock` (line 1), `endTime` (line 2)");
    expect(z2).toContain("`src/call/ring.swift`:");
    expect(z2).not.toContain("util.ts");
  });

  it("links history entries to the commits whose message names them", async () => {
    const root = await project();
    const z2 = readDrawer(getBox(loadCube(root), "Y01.X001")!, 2)!;
    expect(z2).toContain("Tidepool 1.0.8 (6): fix the clock");
    expect(commitsForKey([{ hash: "a", date: "", subject: "Tidepool 1.0.8 (10): other", files: [] }], "1.0.8 (1)")).toEqual([]);
  });

  it("writes a path rule for invariants with code, which loads for those files", async () => {
    const root = await project();
    const rule = readFileSync(join(root, ".claude/rules/cube-Y02-X001.md"), "utf8");
    expect(rule).toMatch(/^---\npaths:\n  - "src\/call\/clock\.swift"\n  - "src\/call\/ring\.swift"\n---\n/);
    expect(rule).toContain("Context Cube: before editing this file, open invariant Y02.X001, a rule that must never be broken:");
  });
});

describe("staleness", () => {
  it("editing a linked file marks its boxes stale", async () => {
    const root = await project();
    writeFileSync(join(root, "src/call/ring.swift"), "struct RingProbe { let deadline: Int; let extra = 1 }\n");
    const out = (await status({ cwd: root })) as string[];
    expect(out.join("\n")).toContain("Y02.X001 sixty-second-clock: src/call/ring.swift changed");
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("stale");
    // History boxes describe the past and are never marked.
    expect(getBox(loadCube(root), "Y01.X001")!.header!.status).toBe("ok");
    // After checking it, `ok` refreshes fingerprints and clears the status.
    await ok(["Y02.X001"], { cwd: root });
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
    expect(computeStatus(root)).toEqual([]);
  });

  it("a deleted code name mentioned in an invariant is flagged for review", async () => {
    const root = await project();
    writeFileSync(join(root, "src/call/clock.swift"), "final class Clock {\n  func endTime() -> Date { Date() }\n}\n");
    const results = computeStatus(root);
    expect(results).toContainEqual(expect.objectContaining({ id: "Y02.X001", status: "needs-review" }));
    expect(results[0].reasons).toContain("`CallClock` is no longer in the code");
    await status({ cwd: root });
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("needs-review");
  });

  it("a deleted file counts as changed", async () => {
    const root = await project();
    unlinkSync(join(root, "src/call/ring.swift"));
    expect(computeStatus(root)[0].reasons).toContain("src/call/ring.swift was deleted");
  });

  it("the session notice lists stale boxes linked to recent work, and nothing when all is well", async () => {
    const root = await project();
    expect(sessionNotice(root)).toBeUndefined();
    writeFileSync(join(root, "src/call/ring.swift"), "struct RingProbe { let deadline: Int; let x = 2 }\n");
    const notice = sessionNotice(root)!;
    expect(notice).toContain("Context Cube: 1 box linked to recent work may be out of date:");
    expect(notice).toContain("- Y02.X001 sixty-second-clock (stale: src/call/ring.swift changed)");
    // The notice never edits the cube.
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
    expect(existsSync(join(root, "context-cube"))).toBe(true);
  });
});
