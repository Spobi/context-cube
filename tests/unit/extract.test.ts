import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { extractReads, extractInstructions } from "../../src/core/logs/extract";
import { splitCommand } from "../../src/core/logs/shell";
import { tempProject } from "../helpers";

const notes = "line one\nline two\nline three foo\nline four\nline five foo\n";

function project() {
  return tempProject({ "notes.md": notes, "src/app.ts": "export const x = 1; // foo\n", "docs/a.md": "a\nb\nc\n" });
}

const base = (root: string) => ({ session_id: "s1", cwd: root, hook_event_name: "PostToolUse" });

describe("Read tool", () => {
  it("records the file, the line range, and characters including line-number prefixes", () => {
    const root = project();
    const [r] = extractReads(
      {
        ...base(root),
        tool_name: "Read",
        tool_input: { file_path: join(root, "notes.md"), offset: 2, limit: 2 },
        tool_response: {
          type: "text",
          file: { filePath: join(root, "notes.md"), content: "line two\nline three foo", numLines: 2, startLine: 2, totalLines: 6 },
        },
      },
      root,
    );
    expect(r.file).toBe("notes.md");
    expect(r.ranges).toEqual([[2, 3]]);
    expect(r.totalLines).toBe(6);
    // 23 content chars + "2\t" + "3\t"
    expect(r.chars).toBe(23 + 4);
    expect(r.tokens).toBe(Math.ceil(27 / 4));
  });

  it("counts a trailing newline as the end of the last line, not an extra line", () => {
    const root = project();
    const [r] = extractReads(
      {
        ...base(root),
        tool_name: "Read",
        tool_input: { file_path: join(root, "src/app.ts") },
        tool_response: { type: "text", file: { filePath: join(root, "src/app.ts"), content: "export const x = 1; // foo\n", numLines: 2, startLine: 1, totalLines: 2 } },
      },
      root,
    );
    expect(r.ranges).toEqual([[1, 1]]);
  });

  it("keeps a blank last line when the read stops before the end of the file", () => {
    const root = project();
    const content = Array.from({ length: 29 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const [r] = extractReads(
      {
        ...base(root),
        tool_name: "Read",
        tool_input: { file_path: join(root, "notes.md"), limit: 30 },
        tool_response: { type: "text", file: { filePath: join(root, "notes.md"), content, numLines: 30, startLine: 1, totalLines: 162 } },
      },
      root,
    );
    expect(r.ranges).toEqual([[1, 30]]);
  });

  it("records files outside the project with absolute paths", () => {
    const root = project();
    const [r] = extractReads(
      {
        ...base(root),
        tool_name: "Read",
        tool_input: { file_path: "/etc/hosts" },
        tool_response: { type: "text", file: { filePath: "/etc/hosts", content: "x", numLines: 1, startLine: 1, totalLines: 1 } },
      },
      root,
    );
    expect(r.file).toBe("/etc/hosts");
  });
});

describe("Grep tool", () => {
  it("attributes content lines to files with line numbers", () => {
    const root = project();
    const recs = extractReads(
      {
        ...base(root),
        tool_name: "Grep",
        tool_input: { pattern: "foo", path: root, output_mode: "content" },
        tool_response: {
          mode: "content",
          content: "src/app.ts:1:export const x = 1; // foo\nnotes.md:3:line three foo\nnotes.md:5:line five foo",
          numLines: 3,
        },
      },
      root,
    );
    const byFile = Object.fromEntries(recs.map((r) => [r.file, r]));
    expect(byFile["notes.md"].ranges).toEqual([[3, 3], [5, 5]]);
    expect(byFile["src/app.ts"].ranges).toEqual([[1, 1]]);
  });

  it("handles context lines and single-file searches", () => {
    const root = project();
    const recs = extractReads(
      {
        ...base(root),
        tool_name: "Grep",
        tool_input: { pattern: "three", path: join(root, "notes.md"), output_mode: "content", "-C": 1 },
        tool_response: { mode: "content", content: "2-line two\n3:line three foo\n4-line four", numLines: 3 },
      },
      root,
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].file).toBe("notes.md");
    expect(recs[0].ranges).toEqual([[2, 4]]);
  });

  it("ignores file-list and count modes, which return no file content", () => {
    const root = project();
    const recs = extractReads(
      { ...base(root), tool_name: "Grep", tool_input: { pattern: "foo" }, tool_response: { mode: "files_with_matches", filenames: ["notes.md"] } },
      root,
    );
    expect(recs).toEqual([]);
  });
});

describe("Bash file reads", () => {
  const bash = (root: string, command: string, stdout: string) =>
    extractReads({ ...base(root), tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false } }, root);

  it("head -n N", () => {
    const root = project();
    const [r] = bash(root, `head -n 3 ${join(root, "notes.md")}`, "line one\nline two\nline three foo");
    expect(r.file).toBe("notes.md");
    expect(r.ranges).toEqual([[1, 3]]);
    expect(r.chars).toBe(32);
  });

  it("cat of several files splits the output by size", () => {
    const root = project();
    const recs = bash(root, "cat notes.md docs/a.md", notes + "a\nb\nc\n");
    expect(recs.map((r) => r.file)).toEqual(["notes.md", "docs/a.md"]);
    expect(recs[0].ranges).toEqual([[1, 5]]);
    expect(recs[1].ranges).toEqual([[1, 3]]);
    expect(recs[0].chars + recs[1].chars).toBe(notes.length + 6);
  });

  it("tail, sed -n, and cd", () => {
    const root = project();
    expect(bash(root, "tail -n 2 notes.md", "line four\nline five foo")[0].ranges).toEqual([[4, 5]]);
    expect(bash(root, "sed -n '2,4p' notes.md", "x")[0].ranges).toEqual([[2, 4]]);
    expect(bash(root, "cd docs && cat a.md", "a\nb\nc")[0].file).toBe("docs/a.md");
  });

  it("cat piped into head narrows the range", () => {
    const root = project();
    expect(bash(root, "cat notes.md | head -2", "line one\nline two")[0].ranges).toEqual([[1, 2]]);
  });

  it("grep on a single file attributes lines", () => {
    const root = project();
    const [r] = bash(root, "grep -n foo notes.md", "3:line three foo\n5:line five foo");
    expect(r.file).toBe("notes.md");
    expect(r.ranges).toEqual([[3, 3], [5, 5]]);
  });

  it("ignores commands that aren't file reads", () => {
    const root = project();
    expect(bash(root, "npm test", "ok")).toEqual([]);
    expect(bash(root, "cat $(ls)", "x")).toEqual([]);
    expect(bash(root, "cat missing.md", "")).toEqual([]);
  });
});

describe("InstructionsLoaded", () => {
  it("records the whole instruction file and why it loaded", () => {
    const root = tempProject({ "CLAUDE.md": "# Rules\n- one\n", "src/app.ts": "x\n" });
    const [r] = extractInstructions(
      {
        session_id: "s1",
        cwd: root,
        file_path: join(root, "CLAUDE.md"),
        load_reason: "path_glob_match",
        trigger_file_path: join(root, "src/app.ts"),
      },
      root,
    );
    expect(r).toMatchObject({ tool: "Instructions", file: "CLAUDE.md", ranges: [[1, 2]], loadReason: "path_glob_match", trigger: "src/app.ts" });
  });
});

describe("splitCommand", () => {
  it("respects quotes and separators", () => {
    expect(splitCommand(`cat "a b.md" && head -n 2 'c.md' | cat`)).toEqual([
      { words: ["cat", "a b.md"], next: "&&" },
      { words: ["head", "-n", "2", "c.md"], next: "|" },
      { words: ["cat"], next: undefined },
    ]);
  });
  it("allows 2>/dev/null and gives up on expansions", () => {
    expect(splitCommand("cat a.md 2>/dev/null")?.[0].words).toEqual(["cat", "a.md"]);
    expect(splitCommand('cat "$HOME/x"')).toBeUndefined();
  });
});
