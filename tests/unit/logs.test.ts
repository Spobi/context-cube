import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { complementRanges, mergeRanges, rangeLength } from "../../src/core/logs/ranges";
import { readTranscriptUsage } from "../../src/core/logs/transcript";
import { detectMemoryFiles } from "../../src/core/logs/memoryFiles";
import { buildReport, renderReport } from "../../src/core/logs/report";
import { tempProject } from "../helpers";

describe("ranges", () => {
  it("merges overlapping and touching ranges", () => {
    expect(mergeRanges([[5, 9], [1, 3], [4, 4], [20, 22], [8, 12]])).toEqual([[1, 12], [20, 22]]);
  });
  it("finds the lines never read", () => {
    expect(complementRanges([[1, 420], [900, 950]], 5285)).toEqual([[421, 899], [951, 5285]]);
    expect(complementRanges([], 10)).toEqual([[1, 10]]);
    expect(complementRanges([[1, 10]], 10)).toEqual([]);
    expect(rangeLength([[421, 899], [951, 5285]])).toBe(479 + 4335);
  });
});

describe("transcript usage", () => {
  it("counts each API response once even when it spans several lines", () => {
    const dir = tempProject({}, { git: false });
    const t = join(dir, "t.jsonl");
    const msg = (id: string, input: number, read: number, out: number) =>
      JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-4-5", usage: { input_tokens: input, cache_creation_input_tokens: 10, cache_read_input_tokens: read, output_tokens: out } } });
    writeFileSync(t, [msg("a", 5, 100, 7), msg("a", 5, 100, 7), JSON.stringify({ type: "user" }), msg("b", 3, 200, 9)].join("\n"));
    const u = readTranscriptUsage(t)!;
    expect(u.apiCalls).toBe(2);
    expect(u.inputTokens).toBe(8);
    expect(u.cacheReadTokens).toBe(300);
    expect(u.outputTokens).toBe(16);
    expect(u.peakContextTokens).toBe(3 + 10 + 200);
    expect(u.models).toEqual(["claude-haiku-4-5"]);
  });
});

describe("memory file detection", () => {
  it("finds agent files, files they mention, and memory-like names", () => {
    const root = tempProject({
      "app/CLAUDE.md": "Always read `HISTORY.md` and INVARIANTS.md. See quality.md too. Also ../README.md",
      "app/HISTORY.md": "# History\n",
      "app/HISTORY-ARCHIVE.md": "# Old\n",
      "app/INVARIANTS.md": "# Rules\n",
      "app/quality.md": "# Q\n",
      "app/DESIGN.md": "# Design\n",
      "CHANGELOG.md": "# Changes\n",
      "README.md": "# Readme\n",
      "node_modules/x/CLAUDE.md": "ignored",
      ".claude/rules/api.md": "rule",
    });
    expect(detectMemoryFiles(root)).toEqual([
      ".claude/rules/api.md",
      "CHANGELOG.md",
      "app/CLAUDE.md",
      "app/HISTORY-ARCHIVE.md",
      "app/HISTORY.md",
      "app/INVARIANTS.md",
      "app/quality.md",
    ]);
  });
});

describe("report", () => {
  it("summarizes tokens per session and never-read lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const root = tempProject({ "HISTORY.md": lines, "src/a.ts": "x\n" });
    const t = "2026-09-23T10:00:00.000Z";
    const report = buildReport(
      root,
      [
        { t, session: "s1", tool: "Read", file: "HISTORY.md", ranges: [[1, 20]], chars: 400, tokens: 100, totalLines: 100 },
        { t, session: "s1", tool: "Read", file: "src/a.ts", ranges: [[1, 1]], chars: 40, tokens: 10 },
        { t, session: "s2", tool: "Grep", file: "HISTORY.md", ranges: [[50, 50]], chars: 20, tokens: 5 },
        { t, session: "s2", tool: "Instructions", file: "/home/me/.claude/CLAUDE.md", chars: 80, tokens: 20 },
      ],
      [{ t, event: "end", session: "s1", usage: { apiCalls: 4, inputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 900, outputTokens: 50, peakContextTokens: 1000, models: [] } }],
      ["HISTORY.md"],
    );
    expect(report.sessions).toHaveLength(2);
    expect(report.sessions[0].tokens).toEqual({ memory: 100, cube: 0, other: 10, outside: 0 });
    expect(report.sessions[1].tokens).toEqual({ memory: 5, cube: 0, other: 0, outside: 20 });
    expect(report.memoryFiles[0].neverRead).toEqual([[21, 49], [51, 100]]);
    const text = renderReport(report);
    expect(text).toContain("HISTORY.md: 100 lines, read in 2 of 2 sessions");
    expect(text).toContain("never read: 21–49, 51–100 (79 lines, 79%)");
    expect(text).not.toMatch(/saving/i);
  });
});
