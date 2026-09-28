import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/commands/core";
import { handleHook } from "../../src/commands/hook";
import "../../src/hooks/handlers";
import { createBox } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { linkCode } from "../../src/core/code/links";
import { getBox, loadCube } from "../../src/core/cube";
import { defaultConfig, loadConfig, parseSettingValue, saveConfig, setSetting } from "../../src/core/config";
import { hunksFor, invariantsForEdit, loadReadFirst } from "../../src/core/code/readFirst";
import { computeStats } from "../../src/core/stats/reads";
import { claudeDialect } from "../../src/adapters/claude-code";
import { hookEntries } from "../../src/adapters/claude-code/hooks";
import { patchPieces } from "../../src/adapters/codex/hooks";
import { commitAll, tempProject } from "../helpers";

const CLOCK = [
  "final class CallClock {",
  "  func endTime() -> Date {",
  "    let a = 1",
  "    return Date()",
  "  }",
  "",
  "  func unrelated() {",
  "    let b = 1",
  "    let c = 2",
  "    let d = 3",
  "    let e = 4",
  "    let f = 5",
  "  }",
  "}",
  "",
].join("\n");

async function project() {
  const root = tempProject({ "src/call/clock.swift": CLOCK, "src/call/ring.swift": "struct RingProbe { let deadline: Int }\n", "src/util.ts": "export function formatDate() {}\n" });
  await init({ cwd: root });
  createBox(root, 2, {
    name: "sixty-second-clock",
    summary: "Both phones agree on one end time.",
    readWhen: "Changing call timing.",
    drawers: { 1: "- `CallClock.endTime()` must return the same instant on both phones.\n- See src/call/ring.swift for the `RingProbe` deadline.\n" },
  });
  linkCode(root);
  await reindex(root);
  commitAll(root, "cube");
  return root;
}

const z1Of = (root: string) => `context-cube/${getBox(loadCube(root), "Y02.X001")!.relDir}/Z1-invariants.md`;

describe("where an edit changes a file", () => {
  it("places the lines that differ, leaving out lines both sides share", () => {
    const h = hunksFor(CLOCK, "    let a = 1\n    return Date()", "    let a = 2\n    return Date()")!;
    expect(h).toHaveLength(1);
    expect(h[0].changed).toEqual([{ at: 3, text: "    let a = 1" }, { at: 3, text: "    let a = 2" }]);
    expect(h[0].lines).toContain("  func endTime() -> Date {");
  });

  it("covers every occurrence with replace-all, and gives up on text that isn't there", () => {
    expect(hunksFor(CLOCK, "let", "var", true)!.length).toBe(6);
    expect(hunksFor(CLOCK, "let", "var")!.length).toBe(1);
    expect(hunksFor(CLOCK, "not in the file", "x")).toBeUndefined();
    // Changing nothing changes no lines.
    expect(hunksFor(CLOCK, "let a = 1", "let a = 1")).toEqual([]);
  });
});

describe("which invariants an edit needs", () => {
  it("near: only an edit near the code an invariant names; a whole-file write needs every one", async () => {
    const root = await project();
    const cube = loadCube(root);
    const config = loadConfig(root);
    const need = (old: string, neu: string) => invariantsForEdit(cube, config, "src/call/clock.swift", [{ file: "src/call/clock.swift", old, new: neu }]);
    expect(need("    let a = 1", "    let a = 2")!.list.map((g) => g.inv.id)).toEqual(["Y02.X001"]);
    expect(need("    let f = 5", "    let f = 50")!.list).toEqual([]);
    const whole = invariantsForEdit(cube, config, "src/call/clock.swift", [{ file: "src/call/clock.swift" }])!;
    expect([whole.why, whole.list.map((g) => g.inv.id)]).toEqual(["whole", ["Y02.X001"]]);
    // Text the file doesn't have can't be placed: every invariant counts.
    expect(need("gone", "x")!.why).toBe("whole");
    // A file no invariant governs needs none.
    expect(invariantsForEdit(cube, config, "src/util.ts", [{ file: "src/util.ts", old: "formatDate", new: "fmt" }])!.list).toEqual([]);
  });

  it("all for the files a person lists, and nothing when the check is off (except those files)", async () => {
    const root = await project();
    const cube = loadCube(root);
    const edit = [{ file: "src/call/clock.swift", old: "    let f = 5", new: "    let f = 50" }];
    const listed = setSetting(defaultConfig(), "invariants.readAllFor", parseSettingValue("invariants.readAllFor", "src/call/**"));
    expect(listed.invariants.readAllFor).toEqual(["src/call/**"]);
    expect(invariantsForEdit(cube, listed, "src/call/clock.swift", edit)).toMatchObject({ why: "all", list: [{ inv: { id: "Y02.X001" } }] });
    const off = setSetting(defaultConfig(), "invariants.readFirst", "off");
    expect(invariantsForEdit(cube, off, "src/call/clock.swift", edit)).toBeUndefined();
    expect(invariantsForEdit(cube, { ...off, invariants: { ...off.invariants, readAllFor: ["src/call/*.swift"] } }, "src/call/clock.swift", edit)!.why).toBe("all");
    expect(() => setSetting(defaultConfig(), "invariants.readFirst", "sometimes")).toThrow(/Invalid value/);
  });
});

describe("the read-first check in the guard hook", () => {
  const guard = new Set(["guard"]);
  const edit = (root: string, session: string, old = "    let a = 1", neu = "    let a = 2") =>
    handleHook("pre-tool-use", { session_id: session, cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src/call/clock.swift"), old_string: old, new_string: neu } }, root, guard);
  const read = (root: string, session: string, file: string) =>
    handleHook("post-tool-use", { session_id: session, cwd: root, tool_name: "Read", tool_input: { file_path: join(root, file) }, tool_response: {} }, root, guard);

  it("holds back an edit near an invariant's code until the invariant is opened", async () => {
    const root = await project();
    await read(root, "s1", "src/call/clock.swift");
    const held = await edit(root, "s1");
    expect(held.exitCode).toBe(2);
    expect(held.stderr).toContain("this edit to src/call/clock.swift is near code that invariants govern");
    expect(held.stderr).toContain(`- Y02.X001: Both phones agree on one end time. → ${z1Of(root)}`);
    expect(held.stderr).toMatch(/Open it, about \d+ tokens, then make the edit again/);
    // An edit elsewhere in the file isn't near it.
    expect((await edit(root, "s1", "    let f = 5", "    let f = 50")).exitCode).toBe(0);
    await read(root, "s1", z1Of(root));
    expect((await edit(root, "s1")).exitCode).toBe(0);
    // Reading it through the shell counts too.
    await handleHook("post-tool-use", { session_id: "s2", cwd: root, tool_name: "Bash", tool_input: { command: `cat ${z1Of(root)}` }, tool_response: { stdout: "x" } }, root, guard);
    expect((await edit(root, "s2")).exitCode).toBe(0);
  });

  it("checks nothing until the guard has seen the session's reads (hooks from before the check)", async () => {
    const root = await project();
    expect((await edit(root, "s1")).exitCode).toBe(0);
  });

  it("asks again after the context is compacted", async () => {
    const root = await project();
    await read(root, "s1", z1Of(root));
    expect((await edit(root, "s1")).exitCode).toBe(0);
    await handleHook("session-start", { session_id: "s1", cwd: root, source: "compact" }, root, guard);
    expect((await edit(root, "s1")).exitCode).toBe(2);
  });

  it("holds an edit back at most twice per invariant, then lets it through as a miss that stats reports", async () => {
    const root = await project();
    await read(root, "s1", "src/call/clock.swift");
    expect((await edit(root, "s1")).exitCode).toBe(2);
    expect((await edit(root, "s1")).exitCode).toBe(2);
    expect((await edit(root, "s1")).exitCode).toBe(0);
    const log = loadReadFirst(root, "s1");
    expect(log.misses.map((m) => [m.file, m.invariants])).toEqual([["src/call/clock.swift", ["Y02.X001"]]]);
    // Stats take the check's word for what the edits needed, not "every governing invariant".
    const t = new Date().toISOString();
    const stats = computeStats(root, { reads: [{ t, session: "s1", tool: "Read", file: "src/call/clock.swift", chars: 40, tokens: 10 }], edits: [{ t, session: "s1", tool: "Edit", file: "src/call/clock.swift" }] });
    expect(stats.sessions[0].misses).toEqual([{ file: "src/call/clock.swift", box: "Y02.X001", invariants: ["Y02.X001"] }]);
  });

  it("is off when the setting says so", async () => {
    const root = await project();
    const config = loadConfig(root);
    config.invariants.readFirst = "off";
    saveConfig(root, config);
    await read(root, "s1", "src/call/clock.swift");
    expect((await edit(root, "s1")).exitCode).toBe(0);
    expect(loadReadFirst(root, "s1").checked).toBe(false);
  });

  it("reads Codex patches hunk by hunk", async () => {
    const root = await project();
    const patch = (body: string) =>
      handleHook("pre-tool-use", { session_id: "c1", cwd: root, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: src/call/clock.swift\n${body}\n*** End Patch` } }, root, guard, "codex");
    await handleHook("post-tool-use", { session_id: "c1", cwd: root, tool_name: "Bash", tool_input: { command: "cat src/call/clock.swift" }, tool_response: { stdout: CLOCK } }, root, guard, "codex");
    expect((await patch("@@\n     let e = 4\n-    let f = 5\n+    let f = 50")).exitCode).toBe(0);
    const held = await patch("@@ func endTime\n-    let a = 1\n+    let a = 2\n     return Date()");
    expect(held.exitCode).toBe(2);
    expect(held.stderr).toContain("Y02.X001");
  });
});

describe("what the hooks see", () => {
  it("Claude Code edits carry what they change, and reads are their own kind", () => {
    const call = (tool_name: string, tool_input: Record<string, unknown>) => claudeDialect.toolCall({ tool_name, tool_input });
    expect(call("Edit", { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true })).toEqual({ kind: "edit", files: ["a.ts"], pieces: [{ file: "a.ts", old: "x", new: "y", all: true }] });
    expect(call("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] })).toMatchObject({ pieces: [{ old: "x" }, { old: "p" }] });
    expect(call("Write", { file_path: "a.ts", content: "all new" })).toEqual({ kind: "edit", files: ["a.ts"], pieces: [{ file: "a.ts" }] });
    expect(call("Read", { file_path: "a.ts" })).toEqual({ kind: "read", files: ["a.ts"] });
  });

  it("Codex patches: an updated file by hunk; an added, deleted, or moved one whole", () => {
    const p = patchPieces(
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ function a",
        " keep",
        "-old",
        "+new",
        "@@",
        "-x",
        "+y",
        "*** Add File: src/b.ts",
        "+hello",
        "*** Delete File: src/c.ts",
        "*** Update File: src/d.ts",
        "*** Move to: src/e.ts",
        "@@",
        "-1",
        "+2",
        "*** End Patch",
      ].join("\n"),
    );
    expect(p).toEqual([
      { file: "src/a.ts", old: "keep\nold", new: "keep\nnew" },
      { file: "src/a.ts", old: "x", new: "y" },
      { file: "src/b.ts" },
      { file: "src/c.ts" },
      { file: "src/d.ts" },
      { file: "src/e.ts" },
    ]);
  });

  it("the guard's hooks include reads and session starts, for the check", () => {
    const entries = hookEntries("/p", "shared", ["guard", "update"]);
    const post = entries.find((e) => e.event === "PostToolUse")!;
    expect(post.matcher!.split("|")).toEqual(expect.arrayContaining(["Read", "Bash", "Edit"]));
    expect(post.command).toContain("--features guard,update");
    expect(entries.find((e) => e.event === "SessionStart")!.command).toContain("--features guard");
  });
});

describe("the read-first log", () => {
  it("keeps what was opened across hook runs, appended line by line", async () => {
    const root = await project();
    const z1 = z1Of(root);
    await Promise.all([1, 2, 3].map(() => handleHook("post-tool-use", { session_id: "p", cwd: root, tool_name: "Read", tool_input: { file_path: join(root, z1) }, tool_response: {} }, root, new Set(["guard"]))));
    const log = loadReadFirst(root, "p");
    expect(log.seen).toBe(true);
    expect([...log.opened]).toEqual([z1]);
    const text = readFileSync(join(root, "context-cube/.logs/sessions/p.read-first"), "utf8");
    expect(text.split("\n").filter((l) => l.endsWith(z1))).toHaveLength(3);
    writeFileSync(join(root, "context-cube/.logs/sessions/p.read-first"), `${text}garbage line\n`);
    expect(loadReadFirst(root, "p").opened.size).toBe(1);
  });
});
