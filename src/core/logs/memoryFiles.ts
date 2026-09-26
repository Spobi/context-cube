import { dirname, join, posix } from "node:path";
import { exists, readTextOr } from "../fsutil";
import { cubePaths } from "../paths";
import { listProjectFiles, absPath } from "../scan";

/** Files agents load as instructions. */
const AGENT_FILE_NAMES = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "agent.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
]);

/** Name hints for memory-like files. Hints only: content decides in the build. */
const MEMORY_NAME_HINTS = /^(history|changelog|changes|invariants|constitution|house[-_]?rules|decisions|lessons|memory|handoff)([-_. ].*)?\.(md|markdown)$/i;

export function isAgentFile(rel: string): boolean {
  const base = rel.split("/").pop()!.toLowerCase();
  if (AGENT_FILE_NAMES.has(base)) return true;
  if (/(^|\/)\.claude\/rules\/.+\.md$/i.test(rel)) return true;
  if (/(^|\/)\.cursor\/rules\//i.test(rel)) return true;
  return false;
}

/**
 * Detects a project's memory files: agent instruction files, markdown files they
 * mention by name or path, and files whose names suggest memory (HISTORY, INVARIANTS…).
 */
export function detectMemoryFiles(root: string, files: string[] = listProjectFiles(root)): string[] {
  const fileSet = new Set(files);
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split("/").pop()!.toLowerCase();
    byBase.set(base, [...(byBase.get(base) ?? []), f]);
  }
  const found = new Set<string>();
  const agentFiles = files.filter(isAgentFile);
  for (const f of agentFiles) found.add(f);
  for (const f of files) {
    if (MEMORY_NAME_HINTS.test(f.split("/").pop()!)) found.add(f);
  }
  // Markdown files mentioned by agent files, resolved near the mentioning file first.
  for (const agentFile of agentFiles) {
    // An archived agent file is a placeholder now; its original says what it mentioned.
    const archived = join(cubePaths(root).archive, agentFile);
    const text = readTextOr(exists(archived) ? archived : absPath(root, agentFile), "");
    const dir = dirname(agentFile) === "." ? "" : dirname(agentFile);
    const mentions = new Set<string>();
    for (const m of text.matchAll(/@?([A-Za-z0-9_\-./]+\.(?:md|markdown))\b/g)) mentions.add(m[1].replace(/^\.\//, ""));
    for (const mention of mentions) {
      // READMEs are written for people; mentioning one doesn't make it agent memory.
      if (/^readme\./i.test(mention.split("/").pop()!)) continue;
      const candidates = [posix.join(dir, mention), mention].map((p) => posix.normalize(p));
      const direct = candidates.find((c) => fileSet.has(c));
      if (direct) {
        found.add(direct);
        continue;
      }
      // A bare name like "HISTORY.md": take matches inside the mentioning file's folder.
      if (!mention.includes("/")) {
        const matches = (byBase.get(mention.toLowerCase()) ?? []).filter((m) => !dir || m.startsWith(`${dir}/`));
        if (matches.length === 1) found.add(matches[0]);
      }
    }
  }
  return [...found].sort();
}
