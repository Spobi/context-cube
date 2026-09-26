import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, projectTool, snapshot, tempProject } from "../helpers";

const EXISTING_SETTINGS = `{
    "permissions": {
        "allow": ["Bash(npm test)"]
    },
    "hooks": {
        "PostToolUse": [
            { "matcher": "Edit", "hooks": [{ "type": "command", "command": "echo mine" }] }
        ]
    }
}`;

function hookPayloads(root: string) {
  const session = "sess-1";
  const common = { session_id: session, transcript_path: join(root, "t.jsonl"), cwd: root };
  return {
    start: { ...common, hook_event_name: "SessionStart", source: "startup" },
    instructions: { ...common, hook_event_name: "InstructionsLoaded", file_path: join(root, "app/CLAUDE.md"), load_reason: "session_start" },
    read: {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(root, "app/HISTORY.md"), offset: 1, limit: 3 },
      tool_response: { type: "text", file: { filePath: join(root, "app/HISTORY.md"), content: "# History\n## 1.0.2\n- a", numLines: 3, startLine: 1, totalLines: 8 } },
    },
    end: { ...common, hook_event_name: "SessionEnd", reason: "other" },
  };
}

describe("read logger install, hooks, report, uninstall", () => {
  it("logs reads through the project's copy of the tool and uninstalls exactly", () => {
    const root = tempProject({
      "app/CLAUDE.md": "Read HISTORY.md at the start of work.\n",
      "app/HISTORY.md": "# History\n## 1.0.2\n- a\n- b\n## 1.0.1\n- c\n- d\n- e\n",
      "src/main.swift": "print(1)\n",
      ".claude/settings.local.json": EXISTING_SETTINGS,
    });
    const before = snapshot(root);

    const install = cli(["log", "install"], { cwd: root });
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("app/HISTORY.md");
    expect(install.stdout).toContain("app/CLAUDE.md");
    expect(existsSync(join(root, "context-cube/.tool/cube.mjs"))).toBe(true);

    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("echo mine");
    const ours = settings.hooks.PostToolUse[1];
    expect(ours.matcher).toBe("Read|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(ours.hooks[0].command).toContain("context-cube/.tool/cube.mjs\" hook post-tool-use --features log");
    expect(Object.keys(settings.hooks).sort()).toEqual(["InstructionsLoaded", "PostToolUse", "SessionEnd", "SessionStart"]);

    // Installing twice changes nothing.
    const afterFirst = snapshot(root);
    expect(cli(["log", "install"], { cwd: root }).status).toBe(0);
    expect(snapshot(root)).toEqual(afterFirst);

    // Hooks run the project's copy of the tool, exactly as Claude Code would.
    const p = hookPayloads(root);
    for (const [event, payload] of [
      ["session-start", p.start],
      ["instructions-loaded", p.instructions],
      ["post-tool-use", p.read],
      ["session-end", p.end],
    ] as const) {
      const r = projectTool(root, ["hook", event, "--features", "log"], JSON.stringify(payload));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
    }
    const reads = readFileSync(join(root, "context-cube/.logs/reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(reads.map((r) => r.file)).toEqual(["app/CLAUDE.md", "app/HISTORY.md"]);

    const report = projectTool(root, ["log", "report"]);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toContain("app/HISTORY.md: 8 lines, read in 1 of 1 sessions");
    expect(report.stdout).toContain("never read: 4–8 (5 lines, 63%)");

    // A hook given garbage input still exits 0 and writes nothing to stdout.
    const bad = projectTool(root, ["hook", "post-tool-use", "--features", "log"], "not json{");
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");

    const uninstall = cli(["log", "uninstall", "--delete-logs"], { cwd: root });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  it("removes settings files and folders it created", () => {
    const root = tempProject({ "CLAUDE.md": "hi\n" });
    const before = snapshot(root);
    const exclude = join(root, ".git/info/exclude");
    const excludeBefore = readFileSync(exclude, "utf8");
    // A machine whose global git settings don't already ignore Claude Code's personal settings.
    const bare = tempProject({}, { git: false });
    const env = { XDG_CONFIG_HOME: bare, GIT_CONFIG_GLOBAL: join(bare, "gitconfig") };
    expect(cli(["log", "install"], { cwd: root, env }).status).toBe(0);
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(true);
    // Personal settings stay out of git, through the repo's local exclude file.
    expect(readFileSync(exclude, "utf8")).toContain(".claude/settings.local.json");
    const out = cli(["log", "uninstall"], { cwd: root, env });
    expect(out.status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(exclude, "utf8")).toBe(excludeBefore);
  });

  it("keeps logs on uninstall unless asked to delete them", () => {
    const root = tempProject({ "CLAUDE.md": "hi\n" });
    cli(["log", "install"], { cwd: root });
    projectTool(root, ["hook", "session-start", "--features", "log"], JSON.stringify({ session_id: "x", source: "startup" }));
    const out = cli(["log", "uninstall"], { cwd: root });
    expect(out.stdout).toContain("Kept your logs");
    expect(existsSync(join(root, "context-cube/.logs/sessions.jsonl"))).toBe(true);
    expect(existsSync(join(root, "context-cube/.tool"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("works without git", () => {
    const root = tempProject({ "AGENTS.md": "Read NOTES.md\n", "NOTES.md": "n\n" }, { git: false });
    const before = snapshot(root);
    const r = cli(["log", "install"], { cwd: root });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("NOTES.md");
    expect(cli(["log", "uninstall", "--delete-logs"], { cwd: root }).status).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });
});
