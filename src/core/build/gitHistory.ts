import { git, gitRoot } from "../git";
import type { CubeConfig } from "../config";

/**
 * History from git (plan 6, projects without memory files): commits grouped by
 * the history unit. Code writes Z2 (changed files) and Z4 (the commit messages
 * and file list) for free; the AI only writes each group's short summary.
 */

export interface GitCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
  body: string;
  files: string[];
  merge: boolean;
  tags: string[];
}

export interface CommitGroup {
  key: string;
  date: string;
  commits: GitCommit[];
}

const SEP = "\x1e";
const FS = "\x1f";

export function readCommits(root: string, max = 400): GitCommit[] {
  if (!gitRoot(root)) return [];
  const r = git(["log", "-n", String(max), "--date=short", `--format=${SEP}%H${FS}%ad${FS}%an${FS}%P${FS}%D${FS}%s${FS}%b${FS}`, "--name-only"], root);
  if (!r.ok) return [];
  return r.stdout
    .split(SEP)
    .filter((b) => b.trim())
    .map((block) => {
      const [hash, date, author, parents, refs, subject, body, rest] = block.split(FS);
      const tags = (refs ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("tag: ")).map((s) => s.slice(5));
      return {
        hash,
        date,
        author,
        subject: subject ?? "",
        body: (body ?? "").trim(),
        files: (rest ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
        merge: (parents ?? "").trim().split(/\s+/).length > 1,
        tags,
      };
    })
    .reverse(); // oldest first
}

/** Groups commits by the history unit, oldest group first. */
export function groupCommits(commits: GitCommit[], unit: CubeConfig["history"]["unit"]): CommitGroup[] {
  const groups: CommitGroup[] = [];
  const push = (key: string, c: GitCommit) => {
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.commits.push(c);
    else groups.push({ key, date: c.date, commits: [c] });
  };
  switch (unit) {
    case "commit":
      for (const c of commits) groups.push({ key: c.hash.slice(0, 8), date: c.date, commits: [c] });
      return groups;
    case "pr": {
      // A merge "Merge pull request #12" closes a group of the commits before it.
      let cur: GitCommit[] = [];
      for (const c of commits) {
        cur.push(c);
        const m = /Merge pull request #(\d+)/.exec(c.subject) ?? /\(#(\d+)\)\s*$/.exec(c.subject);
        if (m) {
          groups.push({ key: `PR #${m[1]}`, date: c.date, commits: cur });
          cur = [];
        }
      }
      if (cur.length) groups.push({ key: `after PR ${groups.length ? groups[groups.length - 1].key : "(none)"}`, date: cur[cur.length - 1].date, commits: cur });
      return groups;
    }
    case "release":
    case "build": {
      // Commits up to and including a tag (or a version named in a subject) form one release.
      let cur: GitCommit[] = [];
      for (const c of commits) {
        cur.push(c);
        const version = c.tags[0] ?? /\b(?:release|version|bump(?:ed)?(?: to)?)\s+v?(\d+\.\d+(?:\.\d+)?(?:\s*\(\d+\))?)/i.exec(c.subject)?.[1];
        if (version) {
          groups.push({ key: version, date: c.date, commits: cur });
          cur = [];
        }
      }
      if (cur.length) groups.push({ key: "unreleased", date: cur[cur.length - 1].date, commits: cur });
      if (groups.length === 1 && groups[0].key === "unreleased") return groupCommits(commits, "day");
      return groups;
    }
    default:
      for (const c of commits) push(c.date, c);
      return groups;
  }
}

/** Z4 for a group: the commit messages and changed files, written by code. */
export function groupDetail(g: CommitGroup): string {
  const lines = [`## ${g.key}${g.key !== g.date ? ` (${g.date})` : ""}`, "", `${g.commits.length} commit${g.commits.length === 1 ? "" : "s"}, from git.`, ""];
  for (const c of g.commits) {
    lines.push(`### ${c.hash.slice(0, 8)} ${c.date} ${c.author}: ${c.subject}`);
    if (c.body) lines.push("", c.body.slice(0, 2000));
    if (c.files.length) lines.push("", `Files: ${c.files.slice(0, 40).map((f) => `\`${f}\``).join(", ")}${c.files.length > 40 ? `, and ${c.files.length - 40} more` : ""}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function groupFiles(g: CommitGroup): string[] {
  return [...new Set(g.commits.flatMap((c) => c.files))];
}
