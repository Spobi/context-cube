import { spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export function git(args: string[], cwd: string, input?: string): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status,
  };
}

let gitAvailable: boolean | undefined;
export function hasGit(): boolean {
  if (gitAvailable === undefined) {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" });
    gitAvailable = r.status === 0;
  }
  return gitAvailable;
}

/** The git root containing `dir`, or undefined when there's no git repo. */
export function gitRoot(dir: string): string | undefined {
  if (!hasGit()) return undefined;
  const r = git(["rev-parse", "--show-toplevel"], dir);
  return r.ok ? r.stdout.trim() : undefined;
}

export function gitUser(cwd: string): string | undefined {
  if (!hasGit()) return undefined;
  const r = git(["config", "user.name"], cwd);
  const name = r.stdout.trim();
  return name || undefined;
}
