import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "../../src/commands/core";
import { createBox } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { loadCube, readDrawer } from "../../src/core/cube";
import { approveText } from "../../src/core/approvals";
import { handleHook } from "../../src/commands/hook";
import "../../src/hooks/handlers";
import { addAgents, installAgents, removeAgent, uninstallAgents } from "../../src/core/install";
import { linkCode } from "../../src/core/code/links";
import { globToRegExp, pathRulesFor, rulesForFile } from "../../src/core/code/pathRules";
import { LOCATE_TOOL, patchFiles, shellScript } from "../../src/adapters/codex/hooks";
import { RULES_FILE } from "../../src/adapters/codex/rules";
import { ruleShaped } from "../../src/adapters/codex/index";
import { loadConfig } from "../../src/core/config";
import { runChecks } from "../../src/core/check/check";
import { commitAll, snapshot, tempProject } from "../helpers";

const TOOL = "node context-cube/.tool/cube.mjs";

async function codexProject(files: Record<string, string> = {}, agents = ["codex"]) {
  const root = tempProject({ "src/clock.ts": "export function endTime() { return 60; }\n", "src/other.ts": "export const x = 1;\n", ...files });
  const before = snapshot(root);
  await init({ cwd: root, historyUnit: "build", agents });
  const inv = createBox(root, 2, {
    name: "sixty-second-clock",
    summary: "Both phones agree on one end time.",
    readWhen: "Changing call timing.",
    drawers: { 1: "- `endTime` must never change during a call.\n" },
  });
  approveText(root, inv.id, readDrawer(inv, 1)!);
  linkCode(root);
  await reindex(root);
  await installAgents(root);
  commitAll(root, "init");
  return { root, before, inv: inv.id };
}

const patch = (...files: string[]) => ["*** Begin Patch", ...files.flatMap((f) => [`*** Update File: ${f}`, "@@", "-a", "+b"]), "*** End Patch"].join("\n");
const hook = (root: string, event: string, input: Record<string, unknown>, features: string[]) =>
  handleHook(event, { session_id: "s", cwd: root, permission_mode: "default", ...input }, root, new Set(features), "codex");
const context = (r: { stdout?: string }) => (r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext as string | undefined) : undefined);

describe("setting a cube up for Codex", () => {
  it("writes the AGENTS.md block, .codex/ hooks and rules, the helper agent, and the skill", async () => {
    const { root } = await codexProject();
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("## Project memory (Context Cube)");
    const hooks = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
    expect(hooks.PreToolUse[0].matcher).toBe("^(Bash|apply_patch)$");
    const cmd: string = hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toBe(`node -e "${LOCATE_TOOL}" hook pre-tool-use --agent codex --features guard`);
    // Every shell passes it to Node unchanged.
    expect(LOCATE_TOOL).not.toMatch(/[$`"!]/);
    const rules = readFileSync(join(root, RULES_FILE), "utf8");
    expect(rules).toContain('pattern = ["node", "context-cube/.tool/cube.mjs", "approve"],');
    expect(rules).toContain('pattern = ["node", "context-cube/.tool/cube.mjs", "config", "set"],');
    expect(rules).toContain('decision = "prompt",');
    const agent = readFileSync(join(root, ".codex/agents/cube-updater.toml"), "utf8");
    expect(agent).toContain('name = "cube-updater"');
    expect(agent).toContain("developer_instructions = '''\nYou keep this project's Context Cube");
    expect(readFileSync(join(root, ".agents/skills/cube-update/SKILL.md"), "utf8")).toContain("update-plan --agent codex");
    // Nothing for Claude Code.
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });

  it("uninstalls to the files as they were, keeping a person's own hooks", async () => {
    const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    const ownText = `${JSON.stringify(own, null, 4)}\n`;
    const { root, before } = await codexProject({ ".codex/hooks.json": ownText, "AGENTS.md": "# Agents\n\nBe kind.\n" });
    const mid = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8"));
    expect(mid.hooks.Stop).toHaveLength(2);
    await uninstallAgents(root);
    const after = snapshot(root);
    const outside = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("context-cube")));
    expect(outside(after)).toEqual(outside(before));
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toBe(ownText);
  });

  it("adds Codex to a cube with a plain AGENTS.md block, taking the block over, and removes it again", async () => {
    const { root } = await codexProject({ "AGENTS.md": "# Agents\n" }, ["generic"]);
    const plain = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(addAgents(root, ["codex"])).toEqual(["codex"]);
    expect(loadConfig(root).agents).toEqual(["codex"]);
    await installAgents(root);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(plain);
    expect(existsSync(join(root, ".codex/hooks.json"))).toBe(true);
    await removeAgent(root, "codex");
    expect(existsSync(join(root, ".codex"))).toBe(false);
    expect(loadConfig(root).agents).toEqual(["generic"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(plain);
  });

  it("keeps personal Codex hooks out of git, and lets shared ones be committed", async () => {
    const { root } = await codexProject();
    await installAgents(root, undefined, { shared: false });
    const ignored = () => spawnSync("git", ["check-ignore", "-q", ".codex/hooks.json"], { cwd: root }).status === 0;
    // The file was committed while shared; only a file this install made is excluded.
    expect(ignored()).toBe(false);
    const fresh = tempProject({ "src/a.ts": "export const a = 1;\n" });
    await init({ cwd: fresh, historyUnit: "build", agents: ["codex"] });
    await installAgents(fresh, undefined, { shared: false });
    const freshIgnored = () => spawnSync("git", ["check-ignore", "-q", ".codex/hooks.json"], { cwd: fresh }).status === 0;
    expect(freshIgnored()).toBe(true);
    await installAgents(fresh, undefined, { shared: true });
    expect(freshIgnored()).toBe(false);
    expect(JSON.parse(readFileSync(join(fresh, ".codex/hooks.json"), "utf8")).hooks.PreToolUse).toHaveLength(1);
  });

  it("warns when AGENTS.md is too long for Codex to reach the cube's block", async () => {
    const { root } = await codexProject({ "AGENTS.md": `# Agents\n\n${"Keep the build green. ".repeat(1700)}\n` });
    expect((await runChecks(root)).map((i) => i.code)).toContain("agents-md-too-long");
    const short = await codexProject({ "AGENTS.md": "# Agents\n" });
    expect((await runChecks(short.root)).map((i) => i.code)).not.toContain("agents-md-too-long");
  });

  it("the hook command finds the project's tool from a subfolder and blocks an apply_patch edit of invariant text", async () => {
    const { root } = await codexProject();
    const hooks = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")).hooks;
    const cmd: string = hooks.PreToolUse[0].hooks[0].command;
    const z1 = loadCube(root).rows.find((r) => r.type === "invariants")!.boxes[0].relDir;
    const env = { ...process.env };
    delete env.CUBE_BUNDLE_PATH;
    delete env.CLAUDE_PROJECT_DIR;
    const input = { session_id: "s", cwd: join(root, "src"), hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch(`../context-cube/${z1}/Z1-invariants.md`) }, permission_mode: "default" };
    const r = spawnSync("sh", ["-c", cmd], { cwd: join(root, "src"), input: JSON.stringify(input), encoding: "utf8", env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Invariant text can't be edited directly");
    // Outside a project with a cube, it does nothing.
    const elsewhere = tempProject({}, { git: false });
    const none = spawnSync("sh", ["-c", cmd], { cwd: elsewhere, input: JSON.stringify({ ...input, cwd: elsewhere }), encoding: "utf8", env });
    expect(none.status).toBe(0);
    expect(none.stdout + none.stderr).toBe("");
  });
});

describe("Codex hooks", () => {
  it("tells the agent which invariants govern a file before it edits it, once a session", async () => {
    const { root, inv } = await codexProject();
    const r = await hook(root, "pre-tool-use", { tool_name: "apply_patch", tool_input: { command: patch("src/clock.ts") } }, ["guard"]);
    expect(r.exitCode).toBe(0);
    const ctx = context(r)!;
    expect(ctx).toContain("For src/clock.ts:");
    expect(ctx).toContain(`Context Cube: before editing this file, open invariant ${inv}`);
    expect(JSON.parse(r.stdout!).hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect((await hook(root, "pre-tool-use", { tool_name: "apply_patch", tool_input: { command: patch("src/clock.ts") } }, ["guard"])).stdout).toBeUndefined();
    expect((await hook(root, "pre-tool-use", { session_id: "s2", tool_name: "apply_patch", tool_input: { command: patch("src/other.ts") } }, ["guard"])).stdout).toBeUndefined();
  });

  it("and after it prints the file through the shell, however the command is given", async () => {
    const { root, inv } = await codexProject();
    const post = (session: string, command: unknown) => hook(root, "post-tool-use", { session_id: session, tool_name: "Bash", tool_input: { command }, tool_response: "…" }, ["guard", "update"]);
    expect(context(await post("a", "cat src/clock.ts"))).toContain(inv);
    expect(context(await post("b", ["bash", "-lc", "sed -n '1,20p' src/clock.ts"]))).toContain(inv);
    expect(context(await post("c", "bash -lc 'nl -ba src/clock.ts | head -n 5'"))).toContain(inv);
    expect((await post("d", "cat src/other.ts")).stdout).toBeUndefined();
  });

  it("blocks shell writes to protected files and keeps the agent out of the archive", async () => {
    const { root } = await codexProject();
    const pre = (command: string) => hook(root, "pre-tool-use", { tool_name: "Bash", tool_input: { command } }, ["guard"]);
    expect((await pre("echo x > context-cube/.state/aliases.txt")).exitCode).toBe(2);
    expect((await pre("cat context-cube/.state/archive/HISTORY.md")).exitCode).toBe(2);
    expect((await pre("cat context-cube/CUBE.md")).exitCode).toBe(0);
  });

  it("leaves person-only commands to Codex's rules, which ask, only when the rules will catch them", async () => {
    const { root } = await codexProject();
    const pre = (command: string, permission_mode = "default") => hook(root, "pre-tool-use", { tool_name: "Bash", tool_input: { command }, permission_mode }, ["guard"]);
    const plain = await pre(`${TOOL} approve P-1 --reason ok`);
    expect(plain).toEqual({ exitCode: 0 });
    const chained = await pre(`cd . && ${TOOL} approve P-1`);
    expect(chained.exitCode).toBe(2);
    expect(chained.stderr).toContain("Run it on its own");
    const npx = await pre("npx context-cube config set invariants.approval auto");
    expect(npx.exitCode).toBe(2);
    const bypass = await pre(`${TOOL} restore HISTORY.md`, "bypassPermissions");
    expect(bypass.exitCode).toBe(2);
    expect(bypass.stderr).toContain("Ask the person to run it themselves, in a terminal in this project: node context-cube/.tool/cube.mjs restore HISTORY.md");
    rmSync(join(root, RULES_FILE));
    expect((await pre(`${TOOL} approve P-1`)).exitCode).toBe(2);
  });

  it("asks for a cube update after a commit and before finishing, naming Codex's helper", async () => {
    const { root, inv } = await codexProject();
    writeFileSync(join(root, "src/clock.ts"), "export function endTime() { return 61; }\n");
    await hook(root, "post-tool-use", { tool_name: "apply_patch", tool_input: { command: patch("src/clock.ts") } }, ["update"]);
    const stop = await hook(root, "stop", { stop_hook_active: false }, ["update"]);
    // The commit trigger is on (a git project), so stop stays quiet; a commit asks.
    expect(stop.stdout).toBeUndefined();
    commitAll(root, "longer calls");
    const r = await hook(root, "post-tool-use", { tool_name: "Bash", tool_input: { command: "git commit -m 'longer calls'" }, tool_response: "ok" }, ["update"]);
    const ctx = context(r)!;
    expect(ctx).toContain("Context Cube: update the project memory for commit");
    expect(ctx).toContain("custom agent in .codex/agents/");
    expect(ctx).not.toContain("Task tool");
    expect(ctx).toContain(inv);
  });
});

describe("reading Codex's tool calls", () => {
  it("finds the files an apply_patch touches", () => {
    const p = ["*** Begin Patch", "*** Add File: a/new.ts", "+x", "*** Update File: b/old.ts", "*** Move to: b/renamed.ts", "@@", "-y", "+z", "*** Delete File: c/gone.ts", "*** End Patch"].join("\n");
    expect(patchFiles(p)).toEqual(["a/new.ts", "b/old.ts", "b/renamed.ts", "c/gone.ts"]);
    expect(patchFiles(`apply_patch <<'EOF'\n${patch("x.ts")}\nEOF`)).toEqual(["x.ts"]);
  });

  it("unwraps shell scripts given as arguments or as bash -lc", () => {
    expect(shellScript(["bash", "-lc", "cat a.md"])).toBe("cat a.md");
    expect(shellScript(["/bin/zsh", "-c", "ls"])).toBe("ls");
    expect(shellScript(["cat", "my file.md"])).toBe("cat 'my file.md'");
    expect(shellScript("bash -lc 'cat a.md | head'")).toBe("cat a.md | head");
    expect(shellScript("cat a.md && bash -lc x")).toBe("cat a.md && bash -lc x");
  });

  it("knows which person-only commands Codex's rules will catch", () => {
    expect(ruleShaped(`${TOOL} approve P-1 --reason "fine"`)).toBe(true);
    expect(ruleShaped(`${TOOL} config set preset max`)).toBe(true);
    expect(ruleShaped(`${TOOL} config get preset`)).toBe(false);
    expect(ruleShaped(`${TOOL} approve P-1; rm -rf x`)).toBe(false);
    expect(ruleShaped(`node ./context-cube/.tool/cube.mjs approve P-1`)).toBe(false);
  });

  it("matches rule globs as Claude Code's path rules do", () => {
    const m = (g: string, f: string) => globToRegExp(g).test(f);
    expect(m("src/ui/**", "src/ui/a/b.tsx")).toBe(true);
    expect(m("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(m("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(m("src/{a,b}.ts", "src/b.ts")).toBe(true);
    expect(m("src/clock.ts", "src/clock.ts")).toBe(true);
    expect(m("src/clock.ts", "src/clockXts")).toBe(false);
  });

  it("finds the path rules for a file from the cube", async () => {
    const { root, inv } = await codexProject();
    const rules = pathRulesFor(loadCube(root));
    expect(rulesForFile(rules, "src/clock.ts").map((r) => r.id)).toEqual([`cube-${inv.replace(".", "-")}`]);
    expect(rulesForFile(rules, "src/other.ts")).toEqual([]);
    mkdirSync(join(root, "tmp"), { recursive: true });
  });
});
