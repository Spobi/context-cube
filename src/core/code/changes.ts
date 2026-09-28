import { createHash } from "node:crypto";
import { readTextOr } from "../fsutil";
import { git, gitRoot } from "../git";
import { absPath } from "../scan";
import { DECLARE, isPlainWord } from "./search";

/**
 * Whether a change to a file touched what a box says about it (no AI). A box
 * is linked to a file by the code names it mentions; an edit elsewhere in the
 * file (a new button in a 3,000-line class) doesn't make it wrong. Git holds
 * the file as the box last saw it, so any clone can answer this.
 */

export interface Hunk {
  /** Every line shown: the changed ones and a few around them, old and new. */
  lines: string[];
  /** Each changed line's place in the new file (a removal: where it was), with the line itself. */
  changed: { at: number; text: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (n: string) => new RegExp(`(?<![\\w$])${escape(n)}(?![\\w$])`);

/** The hunks of `git diff` output. */
export function parseDiff(out: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let at = 0;
  for (const line of out.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      cur = { lines: [], changed: [] };
      hunks.push(cur);
      at = Number(h[1]);
      continue;
    }
    if (!cur || line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (line[0] === "+") {
      cur.lines.push(text);
      cur.changed.push({ at, text });
      at++;
    } else if (line[0] === "-") {
      cur.lines.push(text);
      cur.changed.push({ at, text });
    } else if (line[0] === " ") {
      cur.lines.push(text);
      at++;
    }
  }
  return hunks;
}

const indent = (l: string) => l.length - l.trimStart().length;

/**
 * The names a change is near: in a changed line or the few lines around it,
 * or declared by the declaration the change is inside (an edit in the body of
 * `func verifyEcho` is near `verifyEcho`; found by indentation, and only the
 * nearest one, so a SwiftUI view's name isn't near every edit in its file). A
 * plain word ("probe") may be prose, so it counts only in a changed line.
 */
export function namesNear(hunks: Hunk[], newText: string, names: string[]): string[] {
  const near = new Set<string>();
  const lines = newText.split("\n");
  const decl = new Map(names.filter((n) => !isPlainWord(n)).map((n) => [n, new RegExp(`\\b${DECLARE}\\s+${escape(n)}\\b`)]));
  const anyDecl = new RegExp(`\\b${DECLARE}\\s+[A-Za-z_$]`);
  for (const h of hunks) {
    for (const n of names) {
      const shown = isPlainWord(n) ? h.changed.map((c) => c.text) : h.lines;
      if (!near.has(n) && shown.some((l) => word(n).test(l))) near.add(n);
    }
    for (const c of h.changed) {
      if (!c.text.trim()) continue;
      let inner = indent(c.text);
      for (let i = Math.min(c.at, lines.length) - 2; i >= 0 && inner > 0; i--) {
        const l = lines[i];
        if (!l.trim() || indent(l) >= inner) continue;
        inner = indent(l);
        if (!anyDecl.test(l)) continue;
        for (const [n, re] of decl) if (re.test(l)) near.add(n);
        break;
      }
    }
  }
  return names.filter((n) => near.has(n));
}

/** A file's content fingerprint, as box state records it. */
export function fingerprintOf(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Compares files with the versions boxes last saw. Each answer is kept, so
 * boxes that share a file cost one look at git.
 */
export class Changes {
  private inGit: boolean;
  private bases = new Map<string, string | null>();
  private diffs = new Map<string, Hunk[] | null>();

  constructor(private root: string) {
    this.inGit = !!gitRoot(root);
  }

  /** The newest commit whose copy of `file` has this fingerprint, if git has one (it searches the file's last 50 commits). */
  base(file: string, fp: string): string | undefined {
    const key = `${file}\0${fp}`;
    if (!this.bases.has(key)) this.bases.set(key, this.inGit ? this.findBase(file, fp) ?? null : null);
    return this.bases.get(key) ?? undefined;
  }

  private findBase(file: string, fp: string): string | undefined {
    const log = git(["log", "-n", "50", "--format=%H", "--", file], this.root);
    if (!log.ok) return undefined;
    for (const c of log.stdout.split("\n").filter(Boolean)) {
      const r = git(["show", `${c}:./${file}`], this.root);
      if (r.ok && fingerprintOf(r.stdout) === fp) return c;
    }
    return undefined;
  }

  /** The hunks between a commit's copy of `file` and `to` (the working tree when not given). */
  hunks(file: string, from: string, to?: string): Hunk[] | undefined {
    const key = `${file}\0${from}\0${to ?? ""}`;
    if (!this.diffs.has(key)) {
      const r = git(["diff", "--no-color", "--no-ext-diff", "-U3", from, ...(to ? [to] : []), "--", file], this.root);
      this.diffs.set(key, r.ok ? parseDiff(r.stdout) : null);
    }
    return this.diffs.get(key) ?? undefined;
  }

  /**
   * Which of a box's names a file's change since the box last saw it is
   * near. `undefined` when it can't narrow it down (no git, git doesn't have
   * that version, or the box names the file but none of its code): then any
   * change counts.
   */
  near(file: string, fp: string, names: string[]): string[] | undefined {
    const from = this.base(file, fp);
    const hunks = from ? this.hunks(file, from) : undefined;
    return hunks && narrow(hunks, readTextOr(absPath(this.root, file), ""), names);
  }

  /** The same, for what one commit changed in a file. */
  nearInCommit(file: string, commit: string, names: string[]): string[] | undefined {
    const hunks = this.hunks(file, `${commit}^`, commit);
    const text = git(["show", `${commit}:./${file}`], this.root);
    return hunks && narrow(hunks, text.ok ? text.stdout : "", names);
  }
}

/** Near which of the names the file has (now, or in lines the change removed); undefined when it has none. */
export function narrow(hunks: Hunk[], text: string, names: string[]): string[] | undefined {
  const mine = names.filter((n) => word(n).test(text) || hunks.some((h) => h.changed.some((c) => word(n).test(c.text))));
  return mine.length ? namesNear(hunks, text, mine) : undefined;
}
