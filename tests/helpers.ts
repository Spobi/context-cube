import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReplayBackend, ReplayOrRecordBackend, adapterBackend, type AIBackend } from "../src/ai/backends";
import { aiAdapter } from "../src/adapters/registry";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLE = join(REPO, "dist", "cube.mjs");
export const RECORDED = join(REPO, "tests", "fixtures", "recorded");

/**
 * Recorded AI answers for builds. With CUBE_TEST_RECORD=1, answers missing
 * after a prompt change are made live and saved (uses your plan's usage).
 */
export function recordedBackend(): AIBackend {
  if (process.env.CUBE_TEST_RECORD) return new ReplayOrRecordBackend(adapterBackend(aiAdapter([])), RECORDED);
  return new ReplayBackend(RECORDED);
}
// In-process tests copy the built bundle into projects, as the real CLI would.
process.env.CUBE_BUNDLE_PATH ??= BUNDLE;

/** Creates a temporary project folder with the given files. */
export function tempProject(files: Record<string, string> = {}, opts: { git?: boolean } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cube-test-")));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.git !== false) {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test Person"], { cwd: dir });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  }
  return dir;
}

/** Commits everything with a fixed author and date, so the same files give the same commit ids (replays depend on it). */
export const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "Test Person",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Person",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
};

export function commitAll(dir: string, message = "commit"): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** Every file under `dir` (except .git) with its content. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) {
        out[`${relative(dir, abs)}/`] = "";
        walk(abs);
      } else out[relative(dir, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return out;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built bundle, as a person or hook would. */
export function cli(args: string[], opts: { cwd: string; input?: string; env?: Record<string, string> }): CliResult {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    env: { ...process.env, CUBE_BUNDLE_PATH: BUNDLE, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs the project's own copy of the tool (context-cube/.tool/cube.mjs), exactly as hooks do. */
export function projectTool(root: string, args: string[], input?: string): CliResult {
  const env = { ...process.env };
  delete env.CUBE_BUNDLE_PATH;
  const r = spawnSync(process.execPath, [join(root, "context-cube/.tool/cube.mjs"), ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
