import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isDir, isFile } from "../../core/fsutil";

/**
 * Which Claude Code program runs the build's AI steps (`claude -p`). The Claude
 * desktop app doesn't put a `claude` command on the PATH, but it carries its
 * own copy of Claude Code, and a session running in the app names its program
 * in CLAUDE_CODE_EXECPATH. So, in order: CUBE_CLAUDE_BIN, `claude` on the PATH,
 * the program running this session, then the desktop app's copy (verified
 * 2026-09-27 on macOS: its copy, 2.1.170, shares the login and takes every flag
 * the runner uses).
 */
export interface ClaudeBin {
  path: string;
  from: "env" | "path" | "session" | "desktop";
}

export function findClaude(env: NodeJS.ProcessEnv = process.env): ClaudeBin | undefined {
  if (env.CUBE_CLAUDE_BIN) return { path: env.CUBE_CLAUDE_BIN, from: "env" };
  const onPath = onPathBin("claude", env);
  if (onPath) return { path: onPath, from: "path" };
  if (env.CLAUDE_CODE_EXECPATH && isFile(env.CLAUDE_CODE_EXECPATH)) return { path: env.CLAUDE_CODE_EXECPATH, from: "session" };
  const desktop = desktopClaude();
  if (desktop) return { path: desktop, from: "desktop" };
  return undefined;
}

/** The program to run for `claude -p`: the one found, or plain `claude` (whose failure says it isn't installed). */
export function claudeBin(): string {
  return findClaude()?.path ?? "claude";
}

/** A program on the PATH, by name (with Windows' extensions). */
export function onPathBin(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Where the Claude desktop app keeps its copies of Claude Code, one folder per version. */
export function desktopClaudeDir(): string | undefined {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Claude", "claude-code");
  return undefined;
}

/** The newest copy of Claude Code the desktop app carries, if the app is installed. */
export function desktopClaude(): string | undefined {
  // "0" hides the desktop app (tests); "1" is no override, since the path is still needed.
  if (process.env.CUBE_CLAUDE_DESKTOP === "0") return undefined;
  const dir = desktopClaudeDir();
  if (!dir || !isDir(dir)) return undefined;
  let versions: string[] = [];
  try {
    versions = readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+/.test(v));
  } catch {
    return undefined;
  }
  const nums = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const newestFirst = (a: string, b: string) => {
    const [x, y] = [nums(a), nums(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  };
  for (const v of versions.sort(newestFirst)) {
    for (const p of [join(dir, v, "claude.app", "Contents", "MacOS", "claude"), join(dir, v, "claude.exe"), join(dir, v, "claude")]) {
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Is the Claude desktop app installed on this machine? */
export function hasClaudeDesktop(): boolean {
  if (process.env.CUBE_CLAUDE_DESKTOP === "0") return false;
  if (process.platform === "darwin") return isDir("/Applications/Claude.app") || isDir(join(homedir(), "Applications", "Claude.app")) || !!desktopClaude();
  return !!desktopClaude();
}

/** Is this process running inside a Claude desktop app session (a hook, or a command the agent ran)? */
export function inClaudeDesktop(env: NodeJS.ProcessEnv = process.env): boolean {
  return /desktop/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? "");
}
