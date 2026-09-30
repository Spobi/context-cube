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
import { commitAll, FIXED_GIT_ENV, tempProject } from "../helpers";
import { isCodeFile } from "../../src/core/code/search";
import { loadBoxState, saveBoxState } from "../../src/core/state/state";
import { lastCommit, linkedBoxes } from "../../src/core/update";
import { spawnSync } from "node:child_process";

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

  it("keeps a key from matching longer versions, and leaves the cube's own update commits out", () => {
    const c = (hash: string, subject: string, files: string[]) => ({ hash, date: "2026-09-30", subject, files });
    const commits = [
      // Quickie: each "Update Context Cube to 0.3.x" landed on the entry keyed "0.3" (a call_quality.md section) and pushed a real commit out.
      c("cube1", "Update Context Cube to 0.3.8", ["context-cube/.tool/cube.mjs", "context-cube/Y01-history/ROW.md", "context-cube/.state/boxes/Y01.X018.json"]),
      c("cube2", "Update Context Cube to 0.3.4 and re-check 15 stale boxes", [".claude/rules/cube-Y02-X033.md", ".claude/settings.json", "context-cube/CUBE.md"]),
      c("app1", "Go Dark: 250-coin spend inverts your video; 0.3.5", ["quickie-video/ios/Quickie/Calling/CallManager.swift"]),
      c("app2", "Rename the Home tab; 0.3.4 (2)", ["quickie-video/ios/project.yml", "context-cube/Y01-history/ROW.md"]),
      c("app3", "Polish for v0.3", ["quickie-video/HISTORY.md"]),
    ];
    const ids = (key: string) => commitsForKey(commits, key).map((x) => x.hash);
    expect(ids("0.3")).toEqual(["app3"]);
    expect(ids("0.3.4")).toEqual(["app2"]);
    expect(ids("0.3.4 (2)")).toEqual(["app2"]);
    expect(ids("0.3.5")).toEqual(["app1"]);
    expect(ids("0.3.8")).toEqual([]);
  });

  it("leaves agents' settings out of code search, and out of what a commit's update plan names", async () => {
    const root = tempProject({
      "src/camera.swift": "func requestPermissions() {}\n",
      ".claude/settings.json": '{ "permissions": { "allow": [] } }\n',
      ".codex/hooks.json": '{ "hooks": {} }\n',
      "config/app.json": '{ "permissions": true }\n',
    });
    await init({ cwd: root });
    createBox(root, 3 - 1, { name: "camera-permissions", summary: "Asking for camera permissions.", readWhen: "Changing permissions prompts.", drawers: { 1: "- Ask for `permissions` before the first call.\n" } });
    linkCode(root);
    const files = (loadBoxState(root, "Y02.X001")?.code?.files ?? []).map((f) => f.path);
    expect(files).toContain("config/app.json");
    expect(files).not.toContain(".claude/settings.json");
    expect(isCodeFile(".codex/hooks.json")).toBe(false);
    expect(isCodeFile(".github/workflows/test.yml")).toBe(true);
    // A cube linked before this change: the plan still ignores agent settings.
    const st = loadBoxState(root, "Y02.X001")!;
    saveBoxState(root, { ...st, code: { ...st.code!, files: [...st.code!.files, { ...st.code!.files[0], path: ".claude/settings.json" }] } });
    expect(linkedBoxes(root, [".claude/settings.json"])).toEqual([]);
    expect(linkedBoxes(root, ["config/app.json"]).map((b) => b.id)).toEqual(["Y02.X001"]);
  });

  it("writes a path rule for invariants with code, which loads for those files", async () => {
    const root = await project();
    const rule = readFileSync(join(root, ".claude/rules/cube-Y02-X001.md"), "utf8");
    expect(rule).toMatch(/^---\npaths:\n  - "src\/call\/clock\.swift"\n  - "src\/call\/ring\.swift"\n---\n/);
    expect(rule).toContain("Context Cube: before editing this file, open invariant Y02.X001, a rule that must never be broken:");
  });
});

describe("history dates", () => {
  it("dates an entry without its own date by the first commit naming it, or when its heading was added", async () => {
    const root = await project();
    const st = (id: string) => JSON.parse(readFileSync(join(root, `context-cube/.state/boxes/${id}.json`), "utf8"));
    // "1.0.8 (6)" is named by a commit made on 2026-01-01.
    expect(st("Y01.X001")).toMatchObject({ date: "2026-01-01", dateFrom: "commits" });
    // An entry no commit names: when its heading went into HISTORY.md.
    writeFileSync(join(root, "HISTORY.md"), "## 1.0.9 — Faster start\nStarts faster.\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "notes"], { cwd: root, env: { ...process.env, ...FIXED_GIT_ENV, GIT_AUTHOR_DATE: "2026-03-04T12:00:00Z", GIT_COMMITTER_DATE: "2026-03-04T12:00:00Z" } });
    const box = createBox(root, 1, { name: "faster-start", summary: "Faster start.", readWhen: "Debugging start-up.", drawers: { 4: "## 1.0.9 — Faster start\nStarts faster.\n" }, source: "HISTORY.md L1-L2" });
    const s = st(box.id);
    writeFileSync(join(root, `context-cube/.state/boxes/${box.id}.json`), JSON.stringify({ ...s, date: "2025-12-01", dateFrom: "inferred", sources: [{ file: "HISTORY.md", start: 1, end: 2, drawer: 4 }] }));
    linkCode(root, [box.id]);
    expect(st(box.id)).toMatchObject({ date: "2026-03-04", dateFrom: "file" });
    // A date the entry gives itself stays.
    const dated = createBox(root, 1, { name: "dated", summary: "Dated.", readWhen: "Never.", drawers: { 4: "## 1.1.0 — 2026-05-05\nShipped.\n" } });
    writeFileSync(join(root, `context-cube/.state/boxes/${dated.id}.json`), JSON.stringify({ ...st(dated.id), date: "2026-05-05", dateFrom: "text" }));
    linkCode(root, [dated.id]);
    expect(st(dated.id).date).toBe("2026-05-05");
  });
});

describe("staleness", () => {
  it("editing a linked file marks its boxes stale", async () => {
    const root = await project();
    writeFileSync(join(root, "src/call/ring.swift"), "struct RingProbe { let deadline: Int; let extra = 1 }\n");
    const out = (await status({ cwd: root })) as string[];
    expect(out.join("\n")).toContain("Y02.X001 sixty-second-clock: src/call/ring.swift changed near `RingProbe`");
    // Looking changes nothing (agents are told to run it); --mark writes it into the header.
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
    expect(spawnSync("git", ["status", "--porcelain", "context-cube", ".claude"], { cwd: root, encoding: "utf8" }).stdout).toBe("");
    await status({ cwd: root, mark: true });
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("stale");
    // History boxes describe the past and are never marked.
    expect(getBox(loadCube(root), "Y01.X001")!.header!.status).toBe("ok");
    // After checking it, `ok` refreshes fingerprints and clears the status.
    await ok(["Y02.X001"], { cwd: root });
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
    expect(computeStatus(root)).toEqual([]);
  });

  it("only a change near what a box mentions makes it stale, for status and for a commit's update plan", async () => {
    const root = await project();
    const clock = (endTime: string, other: string) =>
      ["final class CallClock {", "  func endTime() -> Date {", `    let a = ${endTime}`, "    return Date()", "  }", "", "  func unrelated() {", "    let b = 1", "    let c = 2", "    let d = 3", "    let e = 4", `    let f = ${other}`, "  }", "}", ""].join("\n");
    writeFileSync(join(root, "src/call/clock.swift"), clock("1", "5"));
    commitAll(root, "longer clock");
    await ok(["Y02.X001"], { cwd: root });
    commitAll(root, "checked");
    // An edit inside another function: nothing it says changed.
    writeFileSync(join(root, "src/call/clock.swift"), clock("1", "50"));
    expect(computeStatus(root)).toEqual([]);
    commitAll(root, "tweak unrelated");
    expect(linkedBoxes(root, ["src/call/clock.swift"], lastCommit(root)!.hash)).toEqual([]);
    // Without the commit to look at, any change to a linked file counts.
    expect(linkedBoxes(root, ["src/call/clock.swift"]).map((b) => b.id)).toEqual(["Y02.X001"]);
    // An edit inside `endTime`, which the box names.
    writeFileSync(join(root, "src/call/clock.swift"), clock("2", "50"));
    expect(computeStatus(root).map((r) => r.reasons)).toEqual([["src/call/clock.swift changed near `CallClock`, `endTime`"]]);
    commitAll(root, "change endTime");
    expect(linkedBoxes(root, ["src/call/clock.swift"], lastCommit(root)!.hash).map((b) => b.id)).toEqual(["Y02.X001"]);
  });

  it("--mark sets boxes back to ok when what made them stale is undone", async () => {
    const root = await project();
    const ring = join(root, "src/call/ring.swift");
    const before = readFileSync(ring, "utf8");
    writeFileSync(ring, "struct RingProbe { let deadline: Int; let extra = 1 }\n");
    await status({ cwd: root, mark: true });
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("stale");
    writeFileSync(ring, before);
    expect(await status({ cwd: root, mark: true })).toEqual(["Every box matches its code.", "Set 1 box back to ok."]);
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
  });

  it("a deleted code name mentioned in an invariant is flagged for review", async () => {
    const root = await project();
    writeFileSync(join(root, "src/call/clock.swift"), "final class Clock {\n  func endTime() -> Date { Date() }\n}\n");
    const results = computeStatus(root);
    expect(results).toContainEqual(expect.objectContaining({ id: "Y02.X001", status: "needs-review" }));
    expect(results[0].reasons).toContain("`CallClock` is no longer in the code");
    await status({ cwd: root, mark: true });
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
    expect(notice).toContain("- Y02.X001 sixty-second-clock (stale: src/call/ring.swift changed near `RingProbe`)");
    // The notice never edits the cube.
    expect(getBox(loadCube(root), "Y02.X001")!.header!.status).toBe("ok");
    expect(existsSync(join(root, "context-cube"))).toBe(true);
  });
});
