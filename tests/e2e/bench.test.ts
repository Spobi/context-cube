import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { build } from "../../src/commands/build";
import { scriptedAsker } from "../../src/setup/ask";
import { prepareCopies, removeCopies } from "../../src/bench/copies";
import { runBench } from "../../src/bench/run";
import { benchReport } from "../../src/bench/report";
import { loadTasks } from "../../src/bench/tasks";
import { cleanEnv } from "../../src/bench/run";
import { commitAll, tempProject, recordedBackend } from "../helpers";
import * as fx from "../fixtures/projects";

const roots: string[] = [];
afterAll(() => roots.forEach(removeCopies));

async function builtProject() {
  const root = tempProject(fx.constitutionNotes);
  commitAll(root, "init");
  await build({ cwd: root, ask: scriptedAsker({}), backend: recordedBackend() });
  commitAll(root, "add the cube");
  roots.push(root);
  return root;
}

describe("cube bench", () => {
  it("prepares a files copy (originals, no cube) and a cube copy (cube, originals archived) at the same commit", async () => {
    const root = await builtProject();
    const c = prepareCopies(root);
    // Files copy: the original files, word for word, and no cube.
    expect(readFileSync(join(c.files.path, "CONSTITUTION.md"), "utf8")).toBe(fx.constitutionNotes["CONSTITUTION.md"]);
    expect(readFileSync(join(c.files.path, "CLAUDE.md"), "utf8")).toBe(fx.constitutionNotes["CLAUDE.md"]);
    expect(existsSync(join(c.files.path, "context-cube/Y00-rules"))).toBe(false);
    expect(existsSync(join(c.files.path, ".claude/rules/cube-Y03-X001.md"))).toBe(false);
    // Cube copy: the cube, the block, and the original memory files archived behind placeholders, as setup leaves them.
    for (const f of ["CONSTITUTION.md", "NOTES.md"]) {
      expect(readFileSync(join(c.cube.path, f), "utf8")).toMatch(/^<!-- context-cube:archived:start -->/);
      expect(readFileSync(join(c.cube.path, "context-cube/.state/archive", f), "utf8")).toBe(fx.constitutionNotes[f]);
    }
    const claude = readFileSync(join(c.cube.path, "CLAUDE.md"), "utf8");
    expect(claude).toContain("<!-- context-cube:start -->");
    expect(claude).toContain("This project's instructions now live in its Context Cube");
    expect(JSON.parse(readFileSync(join(c.cube.path, "context-cube/cube.config.json"), "utf8")).update.trigger).toBe("manual");
    // Both log reads with the same logger.
    for (const p of [c.files.path, c.cube.path]) expect(readFileSync(join(p, ".claude/settings.local.json"), "utf8")).toContain("--features");
  });

  it("runs tasks in both copies with a reset between runs, captures results, and writes a report", async () => {
    const root = await builtProject();
    const dir = tempProject({}, { git: false });
    const fake = join(dir, "claude");
    // A stand-in agent: edits a file and reports usage like `claude -p --output-format json`.
    writeFileSync(
      fake,
      `#!/bin/sh
echo "// touched by the fake agent" >> src/sync/queue.ts
echo "new" > NEW_FILE.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-'$$'","total_cost_usd":0.5,"num_turns":7,"duration_ms":60000,"usage":{"input_tokens":100,"cache_read_input_tokens":900,"output_tokens":50}}'
`,
    );
    chmodSync(fake, 0o755);
    process.env.CUBE_CLAUDE_BIN = fake;
    const tasksPath = join(dir, "tasks.yaml");
    writeFileSync(
      tasksPath,
      stringify({
        model: "haiku",
        runs: 2,
        tasks: [
          { id: "doc-queue", size: "simple", prompt: "Document the queue.", check: "grep -q 'fake agent' src/sync/queue.ts" },
          { id: "old-incident", size: "complex", older: true, prompt: "Fix the tombstones.", invariants: ["Y02.X003"], check: "false" },
        ],
      }),
    );
    try {
      const r = await runBench(root, loadTasks(tasksPath));
      expect(r.records).toHaveLength(8);
      for (const rec of r.records) {
        expect(rec.ok).toBe(true);
        expect(rec.changedFiles.sort()).toEqual(["NEW_FILE.txt", "src/sync/queue.ts"]);
        expect(readFileSync(join(rec.dir, "diff.patch"), "utf8")).toContain("+// touched by the fake agent");
      }
      // Resets between runs: each run's diff shows one appended line, not two.
      const d = readFileSync(join(r.records[2].dir, "diff.patch"), "utf8");
      expect(d.match(/\+\/\/ touched by the fake agent/g)).toHaveLength(1);
      expect(r.records.filter((x) => x.task === "doc-queue").every((x) => x.checkPassed)).toBe(true);
      expect(r.records.filter((x) => x.task === "old-incident").every((x) => x.checkPassed === false)).toBe(true);

      // Scores (written as a person would through `cube bench score`), then the unblinded report.
      const scores = r.records
        .map((x) => JSON.stringify({ run: x.id, correctness: x.copy === "cube" ? 5 : 3, invariants: 4, scope: 5, respected: x.task === "old-incident" ? { "Y02.X003": x.copy === "cube" ? "yes" : "no" } : undefined, t: "" }))
        .join("\n");
      writeFileSync(join(r.dir, "scores.jsonl"), `${scores}\n`);
      const rep = benchReport(r.dir);
      expect(rep.text).toContain("| files | 4 | 3.0 | 4.0 | 5.0 | 50% | $0.50 | 1,000 | 50 | 7.0 | 1.0 |");
      expect(rep.text).toContain("| cube | 4 | 5.0 | 4.0 | 5.0 | 50% | $0.50 |");
      expect(rep.text).toContain("## old-incident (complex, depends on an older incident)");
      // Retrieval: the stand-in agent reads nothing, so the required invariant is never found; the scorer's yes/no gives the violations.
      expect(r.records.find((x) => x.task === "old-incident")!.retrieval).toEqual({ required: 1, found: 0, readsToFind: undefined, readsBeforeEdit: 0, memoryBeforeEdit: 0 });
      expect(rep.text).toContain("| files | 2 of 2 (100%) | 0 of 2 (0%) |");
      expect(rep.text).toContain("| cube | 0 of 2 (0%) | 0 of 2 (0%) |");
      expect(rep.text).not.toMatch(/saving/i);
    } finally {
      delete process.env.CUBE_CLAUDE_BIN;
    }
  });

  it("runs agents without deploy credentials", () => {
    const env = cleanEnv({ PATH: "/bin", HOME: "/h", SUPABASE_SERVICE_ROLE_KEY: "x", AWS_SECRET_ACCESS_KEY: "y", GITHUB_TOKEN: "z", LANG: "en" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LANG: "en" });
  });
});
