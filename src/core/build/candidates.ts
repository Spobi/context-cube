import { normalizeEol, readTextOr } from "../fsutil";
import { absPath, listProjectFiles } from "../scan";
import { isCodeFile } from "../code/search";
import type { GitCommit } from "./gitHistory";

/**
 * Evidence for candidate invariants (plan 6, projects without memory files):
 * reverted commits, fix commits, and code comments that say "never", "do not",
 * "must", "important". Code gathers it; the AI drafts candidates; all start
 * pending a person's approval.
 */

export interface Evidence {
  reverts: string[];
  fixes: string[];
  comments: string[];
}

const COMMENT_RE = /^\s*(?:\/\/|#|--|\*|\/\*|;)\s*(.*)$/;
const RULE_RE = /\b(never|do not|don't|must not|must|always|important|warning|careful|critical|invariant)\b/i;
const NOT_RULE = /\b(todo|fixme|eslint|prettier|noqa|type:\s*ignore|@ts-)\b/i;

export function gatherEvidence(root: string, commits: GitCommit[], limits = { reverts: 30, fixes: 40, comments: 80 }): Evidence {
  const reverts = commits
    .filter((c) => /^revert\b/i.test(c.subject))
    .slice(-limits.reverts)
    .map((c) => `${c.hash.slice(0, 8)} ${c.date}: ${c.subject}${c.body ? ` — ${c.body.split("\n").slice(0, 3).join(" ").slice(0, 300)}` : ""}`);
  const fixes = commits
    .filter((c) => /\b(fix(es|ed)?|bug|regression|hotfix|crash|broke|breaks)\b/i.test(c.subject) && !/^revert\b/i.test(c.subject))
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, limits.fixes)
    .map((c) => `${c.hash.slice(0, 8)} ${c.date}: ${c.subject}${c.body ? ` — ${c.body.split("\n").slice(0, 4).join(" ").slice(0, 400)}` : ""} (files: ${c.files.slice(0, 5).join(", ")})`);
  const comments: string[] = [];
  for (const f of listProjectFiles(root).filter(isCodeFile)) {
    if (comments.length >= limits.comments) break;
    const lines = normalizeEol(readTextOr(absPath(root, f), "")).split("\n");
    lines.forEach((l, i) => {
      if (comments.length >= limits.comments) return;
      const m = COMMENT_RE.exec(l);
      if (!m || !RULE_RE.test(m[1]) || NOT_RULE.test(m[1]) || m[1].length < 12) return;
      comments.push(`${f}:${i + 1}: ${m[1].trim().slice(0, 300)}`);
    });
  }
  return { reverts, fixes, comments };
}

export function hasEvidence(e: Evidence): boolean {
  return e.reverts.length + e.fixes.length + e.comments.length > 0;
}
