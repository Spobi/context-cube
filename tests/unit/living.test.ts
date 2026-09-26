import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init, configSet } from "../../src/commands/core";
import { createBox } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { getBox, loadCube, readDrawer } from "../../src/core/cube";
import { addFragment, closeEntry, openEntry } from "../../src/core/history";
import { approve, listProposals, proposeDelete, proposeEdit, proposeNew, reject, unapprovedChanges, weakens } from "../../src/core/approvals";
import { approveText } from "../../src/core/approvals";
import { handleHook } from "../../src/commands/hook";
import "../../src/hooks/handlers";
import { installAgents, uninstallAgents } from "../../src/core/install";
import { linkCode } from "../../src/core/code/links";
import { readJsonl } from "../../src/core/fsutil";
import { commitAll, snapshot, tempProject } from "../helpers";

async function cubeProject(files: Record<string, string> = {}) {
  const root = tempProject({ "src/clock.ts": "export function endTime() { return 60; }\n", "CLAUDE.md": "# Notes\n", ...files });
  await init({ cwd: root, historyUnit: "build" });
  const inv = createBox(root, 2, {
    name: "sixty-second-clock",
    summary: "Both phones agree on one end time.",
    readWhen: "Changing call timing.",
    drawers: { 1: "- `endTime` must never change during a call.\n- Both sides use the server's clock.\n" },
  });
  approveText(root, inv.id, readDrawer(inv, 1)!);
  linkCode(root);
  await reindex(root);
  commitAll(root, "init");
  return root;
}

describe("open history entries and fragments", () => {
  it("adds one fragment file per update, shows them in the open entry's Z4, and closes into Z4 for good", async () => {
    const root = await cubeProject();
    const a = addFragment(root, "Moved the clock to the server.", { by: "Jordan", key: "1.0.9 (1)", now: new Date("2026-09-24T15:12:00Z") });
    const b = addFragment(root, "Fixed a race in the ring timer.", { by: "Cole", key: "1.0.9 (1)", now: new Date("2026-09-24T16:00:00Z") });
    expect(a.box.id).toBe(b.box.id);
    const box = getBox(loadCube(root), a.box.id)!;
    expect(box.header!.status).toBe("open");
    expect(readdirSync(join(box.dir, "fragments"))).toEqual(["2026-09-24T1512-jordan.md", "2026-09-24T1600-cole.md"]);
    await reindex(root);
    expect(readDrawer(getBox(loadCube(root), box.id)!, 4)).toContain("Moved the clock to the server.");

    // A new build number closes the open entry and opens the next.
    const c = addFragment(root, "Started 1.0.9 (2).", { key: "1.0.9 (2)", by: "Jordan" });
    expect(c.closed).toBe(box.id);
    const closed = getBox(loadCube(root), box.id)!;
    expect(closed.header!.status).toBe("ok");
    expect(existsSync(join(closed.dir, "fragments"))).toBe(false);
    expect(readDrawer(closed, 4)).toBe("Moved the clock to the server.\n\nFixed a race in the ring timer.\n");
    expect(openEntry(loadCube(root))!.id).toBe(c.box.id);

    const done = closeEntry(root, { summary: "Build 1.0.9 (2): started." });
    expect(done.header).toMatchObject({ status: "ok", summary: "Build 1.0.9 (2): started." });
  });
});

describe("invariant approval", () => {
  it("edits wait for approval; approve applies them and logs who, when, and why", async () => {
    const root = await cubeProject();
    const { proposal, applied } = proposeEdit(root, "Y02.X001", "- `endTime` must never change during a call.\n- Both sides use the server's clock, rounded to the second.\n", "rounding fix");
    expect(applied).toBe(false);
    expect(proposal.weakens).toBe(false);
    expect(readDrawer(getBox(loadCube(root), "Y02.X001")!, 1)).not.toContain("rounded");
    approve(root, proposal.id);
    expect(readDrawer(getBox(loadCube(root), "Y02.X001")!, 1)).toContain("rounded to the second");
    expect(unapprovedChanges(root)).toEqual([]);
    const log = readJsonl<any>(join(root, "context-cube/.state/approvals.log"));
    expect(log[log.length - 1]).toMatchObject({ decision: "approved", box: "Y02.X001", reviewedByPerson: true, reason: "rounding fix" });
  });

  it("flags weakenings and deletions, and reject leaves the text alone", async () => {
    const root = await cubeProject();
    expect(weakens("- It must never change.\n- Both sides agree.\n", "- Both sides agree.\n")).toBe(true);
    const e = proposeEdit(root, "Y02.X001", "- Both sides use the server's clock.\n", "simplify");
    expect(e.proposal.weakens).toBe(true);
    reject(root, e.proposal.id, "that removes the rule");
    expect(readDrawer(getBox(loadCube(root), "Y02.X001")!, 1)).toContain("must never change");
    const d = proposeDelete(root, "Y02.X001", "obsolete");
    expect(d.proposal.weakens).toBe(true);
    expect(listProposals(root)).toHaveLength(1);
    approve(root, d.proposal.id);
    expect(getBox(loadCube(root), "Y02.X001")).toBeUndefined();
  });

  it("new invariants go in at once as pending; auto mode applies changes and logs them as not reviewed", async () => {
    const root = await cubeProject();
    const n = proposeNew(root, { name: "no-negative-coins", summary: "Coin balances never go below zero.", readWhen: "Changing coins.", text: "- Balances must never go negative.\n", reason: "found in review" });
    expect(getBox(loadCube(root), n.proposal.box)!.header!.status).toBe("pending");
    approve(root, n.proposal.id);
    expect(getBox(loadCube(root), n.proposal.box)!.header!.status).toBe("ok");

    configSet("invariants.approval", "auto", { cwd: root });
    const e = proposeEdit(root, "Y02.X001", "- `endTime` must never change.\n", "shorter");
    expect(e.applied).toBe(true);
    const log = readJsonl<any>(join(root, "context-cube/.state/approvals.log"));
    expect(log[log.length - 1]).toMatchObject({ decision: "applied-automatically", reviewedByPerson: false });
  });
});

describe("the guard hook", () => {
  const pre = (root: string, tool_name: string, tool_input: Record<string, unknown>, permission_mode = "default") =>
    handleHook("pre-tool-use", { session_id: "s", cwd: root, tool_name, tool_input, permission_mode }, root, new Set(["guard"]));

  it("blocks direct edits of invariant text and names the command to use instead", async () => {
    const root = await cubeProject();
    const z1 = join(getBox(loadCube(root), "Y02.X001")!.dir, "Z1-invariants.md");
    const r = await pre(root, "Edit", { file_path: z1, old_string: "a", new_string: "b" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("node context-cube/.tool/cube.mjs propose edit Y02.X001 --text @<file>");
    const b = await pre(root, "Bash", { command: `sed -i '' 's/never/rarely/' ${z1}` });
    expect(b.exitCode).toBe(2);
  });

  it("blocks direct edits of settings and tool-owned files, but not other cube drawers", async () => {
    const root = await cubeProject();
    expect((await pre(root, "Write", { file_path: join(root, "context-cube/cube.config.json") })).stderr).toContain("config set <setting> <value>");
    expect((await pre(root, "Edit", { file_path: join(root, "context-cube/.state/retired.txt") })).exitCode).toBe(2);
    const z4 = join(getBox(loadCube(root), "Y02.X001")!.dir, "Z4-detail.md");
    expect((await pre(root, "Write", { file_path: z4 })).exitCode).toBe(0);
    expect((await pre(root, "Edit", { file_path: join(root, "src/clock.ts") })).exitCode).toBe(0);
  });

  it("keeps the agent out of the archive, and makes putting an original back ask a person", async () => {
    const root = await cubeProject();
    const cat = await pre(root, "Bash", { command: "cat context-cube/.state/archive/HISTORY.md" });
    expect(cat.exitCode).toBe(2);
    expect(cat.stderr).toContain("node context-cube/.tool/cube.mjs find <words>");
    expect((await pre(root, "Bash", { command: "grep -r clock context-cube/.state/archive" })).exitCode).toBe(2);
    expect((await pre(root, "Bash", { command: "cat context-cube/Y02-invariants/ROW.md" })).exitCode).toBe(0);
    const restore = await pre(root, "Bash", { command: "node context-cube/.tool/cube.mjs restore HISTORY.md" });
    expect(JSON.parse(restore.stdout!).hookSpecificOutput.permissionDecision).toBe("ask");
    await installAgents(root);
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Read(/context-cube/.state/archive/**)");
    expect(settings.permissions.ask).toContain("Bash(node context-cube/.tool/cube.mjs restore:*)");
  });

  it("makes setting changes and approvals ask a person, and blocks them when prompts are skipped", async () => {
    const root = await cubeProject();
    const ask = await pre(root, "Bash", { command: "node context-cube/.tool/cube.mjs config set invariants.approval auto" });
    expect(JSON.parse(ask.stdout!).hookSpecificOutput.permissionDecision).toBe("ask");
    const approveAsk = await pre(root, "Bash", { command: "node context-cube/.tool/cube.mjs approve P-1" });
    expect(JSON.parse(approveAsk.stdout!).hookSpecificOutput.permissionDecision).toBe("ask");
    const bypass = await pre(root, "Bash", { command: "node context-cube/.tool/cube.mjs config set preset max" }, "bypassPermissions");
    expect(bypass.exitCode).toBe(2);
    expect(bypass.stderr).toContain("! node context-cube/.tool/cube.mjs config set preset max");
    expect((await pre(root, "Bash", { command: "node context-cube/.tool/cube.mjs pending" })).stdout).toBeUndefined();
  });
});

describe("records in the guard hook", () => {
  const pre = (root: string, tool_name: string, tool_input: Record<string, unknown>, permission_mode = "default") =>
    handleHook("pre-tool-use", { session_id: "s", cwd: root, tool_name, tool_input, permission_mode }, root, new Set(["guard"]));
  const cmd = (c: string) => `node context-cube/.tool/cube.mjs ${c}`;

  it("blocks direct edits of a closed history entry, and asks a person before replacing or deleting one", async () => {
    const root = await cubeProject();
    addFragment(root, "Tried a worker thread for the clock; it deadlocked the audio session. Don't retry it.", { key: "1.0.1" });
    closeEntry(root, {});
    const hist = getBox(loadCube(root), "Y01.X001")!;
    const edit = await pre(root, "Edit", { file_path: join(hist.dir, "Z4-detail.md"), old_string: "Don't retry it.", new_string: "" });
    expect(edit.exitCode).toBe(2);
    expect(edit.stderr).toContain("Y01.X001.Z4 is a closed history entry, a record of the past");
    expect(edit.stderr).toContain(cmd("write Y01.X001 Z4 --append @<file>"));
    expect(edit.stderr).toContain(cmd('replace Y01.X001 Z4 @<file> --reason "<why>" (a person confirms it)'));
    // Its header (Z0) isn't a record: summaries and read-when lines are routing, and stay editable.
    expect((await pre(root, "Edit", { file_path: join(hist.dir, "Z0-overview.md") })).exitCode).toBe(0);

    const ask = async (c: string) => JSON.parse((await pre(root, "Bash", { command: cmd(c) })).stdout!).hookSpecificOutput;
    expect(await ask("replace Y01.X001 Z4 @fix.md --reason typo")).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: "Replacing a record's text needs a person to confirm." });
    expect((await ask("delete Y01.X001 --reason old")).permissionDecision).toBe("ask");
    expect((await ask('delete --reason "no longer true" Y01.X001')).permissionDecision).toBe("ask");
    const bypass = await pre(root, "Bash", { command: cmd("delete Y01.X001 --reason old") }, "bypassPermissions");
    expect(bypass.exitCode).toBe(2);
    expect(bypass.stderr).toContain(`! ${cmd("delete Y01.X001 --reason old")}`);
    // Deleting a box that holds no record doesn't ask.
    createBox(root, 0, { name: "scratch-rule", summary: "A rule written here.", readWhen: "Always.", body: "Keep it short.\n" });
    expect((await pre(root, "Bash", { command: cmd("delete Y00.X001") })).stdout).toBeUndefined();
  });
});

describe("the update trigger", () => {
  const post = (root: string, command: string, session = "s1") =>
    handleHook("post-tool-use", { session_id: session, cwd: root, tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "ok" } }, root, new Set(["update"]));

  it("after a commit, tells the agent which boxes are linked and how to update, once per commit", async () => {
    const root = await cubeProject();
    writeFileSync(join(root, "src/clock.ts"), "export function endTime() { return 61; }\n");
    commitAll(root, "Tidepool 1.0.9 (3): longer calls");
    const r = await post(root, "rtk git commit -m 'Tidepool 1.0.9 (3): longer calls'");
    const ctx = JSON.parse(r.stdout!).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("Context Cube: update the project memory for commit");
    expect(ctx).toContain('history add "<note>" --key "1.0.9 (3)" --touches Y02.X001');
    expect(ctx).toContain("cube-updater");
    expect(ctx).toContain("never rewrite or shorten what's there");
    expect(ctx).toContain("write Y02.X001 Z4 @<file> (it has no Z4 yet");
    expect((await post(root, "git commit -m again")).stdout).toBeUndefined();
    // A commit that only changed the cube needs no update.
    writeFileSync(join(root, "context-cube/Y02-invariants/X001-sixty-second-clock/Z4-detail.md"), "detail\n");
    commitAll(root, "cube only");
    expect((await post(root, "git commit -m 'cube only'", "s2")).stdout).toBeUndefined();
    // Once the box has a Z4, the plan adds to it instead of rewriting it.
    writeFileSync(join(root, "src/clock.ts"), "export function endTime() { return 62; }\n");
    commitAll(root, "Tidepool 1.0.9 (4): even longer calls");
    const again = await post(root, "git commit -m 'Tidepool 1.0.9 (4)'", "s3");
    expect(JSON.parse(again.stdout!).hookSpecificOutput.additionalContext).toContain("write Y02.X001 Z4 --append @<file>");
  });

  it("with the stop trigger, asks once at the end of a session that edited files", async () => {
    const root = await cubeProject();
    configSet("update.trigger", "stop", { cwd: root });
    const stop = () => handleHook("stop", { session_id: "s9", cwd: root, stop_hook_active: false }, root, new Set(["update"]));
    expect((await stop()).stdout).toBeUndefined();
    await handleHook("post-tool-use", { session_id: "s9", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src/clock.ts") } }, root, new Set(["update"]));
    const r = await stop();
    expect(JSON.parse(r.stdout!)).toMatchObject({ decision: "block" });
    expect(JSON.parse(r.stdout!).reason).toContain("Y02.X001");
    expect((await stop()).stdout).toBeUndefined();
  });
});

describe("install, the pre-commit check, and uninstall", () => {
  it("the pre-commit check catches an edit made outside the agent, and uninstall restores everything outside the cube", async () => {
    const root = tempProject({ "CLAUDE.md": "# Notes\n", ".claude/settings.local.json": '{\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n', "src/clock.ts": "x\n" });
    commitAll(root);
    const outside = () => Object.fromEntries(Object.entries(snapshot(root)).filter(([p]) => !p.startsWith("context-cube")));
    const before = outside();
    const hooksBefore = readdirSync(join(root, ".git/hooks")).sort();
    await init({ cwd: root });
    const inv = createBox(root, 2, { name: "rule", summary: "A rule.", readWhen: "Always.", drawers: { 1: "- Never do X.\n" } });
    approveText(root, inv.id, "- Never do X.\n");
    await installAgents(root);
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    expect(settings.permissions.ask).toContain("Bash(node context-cube/.tool/cube.mjs config set:*)");
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
    expect(existsSync(join(root, ".claude/agents/cube-updater.md"))).toBe(true);
    expect(readFileSync(join(root, ".claude/agents/cube-updater.md"), "utf8")).toContain("model: haiku");
    expect(existsSync(join(root, ".claude/commands/cube-update.md"))).toBe(true);
    commitAll(root, "cube");

    // An edit made outside the agent: the commit is refused.
    writeFileSync(join(inv.dir, "Z1-invariants.md"), "- Sometimes do X.\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    const bad = spawnSync("git", ["commit", "-m", "sneaky"], { cwd: root, encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain("invariant text changed without approval");
    // Restored, it commits.
    writeFileSync(join(inv.dir, "Z1-invariants.md"), "- Never do X.\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    expect(spawnSync("git", ["commit", "-m", "fine", "--allow-empty"], { cwd: root }).status).toBe(0);

    await uninstallAgents(root);
    expect(outside()).toEqual(before);
    expect(readdirSync(join(root, ".git/hooks")).sort()).toEqual(hooksBefore);
  });
});
