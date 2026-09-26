import { describe, expect, it } from "vitest";
import { chunkCoverage, findRefs, splitSource } from "../../src/core/build/split";
import { validateRecipe } from "../../src/core/build/dryrun";
import { codeRecipeForNotes } from "../../src/core/build/recipeCode";
import type { Recipe, SourceRecipe } from "../../src/core/build/recipe";
import { headings } from "../../src/core/build/markdown";

const history = `# History

Newest first.

## 1.0.8 (6) — Take out the lift
**The lift never lifted.** It re-sent the same parameters.
- Removed the lift. See §2.

\`\`\`sh
## not a heading, it's in a code block
\`\`\`

## 1.0.8 (5) — Frame pacing
- Paced frames. Reverts part of 1.0.8 (6)? No: of 1.0.7 (2).

## Server-side — deployed 2026-08-30
- Deployed the function.

## 1.0.7 (2) — 2026-08-01
### Audio
- Fixed echo.
### Video
- Fixed freeze.
`;

const invariants = `# Invariants

Intro text.

## §1 Mixed versions
- Old builds must keep working.

## §2 The clock
- Both sides agree.
- Never reset it. See 1.0.8 (6).
`;

const historyRecipe: SourceRecipe = {
  path: "HISTORY.md",
  sections: [
    {
      startLine: 1,
      kind: "history",
      split: { mode: "heading", level: 2 },
      key: "^##\\s+(\\d+\\.\\d+\\.\\d+\\s*\\(\\d+\\))",
      date: "(\\d{4}-\\d{2}-\\d{2})",
      summary: "^##\\s+\\d+\\.\\d+\\.\\d+\\s*\\(\\d+\\)\\s+—\\s+(?!\\d{4})(.+)$",
      order: "newest-first",
    },
  ],
};

const invariantsRecipe: SourceRecipe = {
  path: "INVARIANTS.md",
  sections: [{ startLine: 1, kind: "invariants", split: { mode: "heading", level: 2 }, key: "^##\\s+§\\s*(\\d+)" }],
};

describe("markdown", () => {
  it("ignores headings inside code fences", () => {
    expect(headings(history).map((h) => h.text)).not.toContain("not a heading, it's in a code block");
  });

  it("reads underlined (setext) headings like a changelog's `5.1.0 / 2025-03-31` over `====`", () => {
    const text = "5.1.0 / 2025-03-31\n==================\n\n  * Add a thing\n\n5.0.1 / 2024-10-08\n==================\n\n  * Fix\n\nNotes\n-----\ntext\n";
    expect(headings(text).map((h) => [h.line, h.level, h.text])).toEqual([
      [1, 1, "5.1.0 / 2025-03-31"],
      [6, 1, "5.0.1 / 2024-10-08"],
      [11, 2, "Notes"],
    ]);
    const sr: SourceRecipe = { path: "History.md", sections: [{ startLine: 1, kind: "history", split: { mode: "heading", level: 1 }, key: "^(\\d+\\.\\d+\\.\\d+)" }] };
    const chunks = splitSource(sr, text);
    expect(chunks.map((c) => [c.start, c.end, c.key])).toEqual([
      [1, 5, "5.1.0"],
      [6, 13, "5.0.1"],
    ]);
    expect(chunkCoverage(chunks, [{ path: "History.md", text }])[0].ok).toBe(true);
  });

  it("doesn't mistake a front-matter block for a heading", () => {
    expect(headings("---\ntitle: x\n---\n# Real\n")).toEqual([{ line: 4, level: 1, text: "Real" }]);
  });
});

describe("split", () => {
  it("cuts entries at the split level, keeps text before them as glue, and ignores fenced headings", () => {
    const chunks = splitSource(historyRecipe, history);
    expect(chunks.map((c) => `${c.role}:${c.start}-${c.end}`)).toEqual(["glue:1-4", "entry:5-12", "entry:13-15", "entry:16-18", "entry:19-23"]);
    const [, lift, pacing, server, old] = chunks;
    expect(lift).toMatchObject({ key: "1.0.8 (6)", summary: "Take out the lift", title: "1.0.8 (6) — Take out the lift" });
    expect(pacing.key).toBe("1.0.8 (5)");
    expect(server.key).toBeUndefined();
    expect(server.date).toBe("2026-08-30");
    expect(old).toMatchObject({ key: "1.0.7 (2)", date: "2026-08-01", summary: undefined });
  });

  it("recombines into the source exactly", () => {
    const chunks = splitSource(historyRecipe, history);
    expect(chunkCoverage(chunks, [{ path: "HISTORY.md", text: history }])).toEqual([{ source: "HISTORY.md", ok: true, lines: 23, covered: 23 }]);
    expect(chunks.map((c) => c.text).join("")).toBe(history);
  });

  it("normalizes Windows line endings", () => {
    const crlf = history.replace(/\n/g, "\r\n");
    const chunks = splitSource(historyRecipe, crlf);
    expect(chunkCoverage(chunks, [{ path: "HISTORY.md", text: crlf }])[0].ok).toBe(true);
  });

  it("detects gaps and overlaps", () => {
    const chunks = splitSource(historyRecipe, history);
    const gap = chunkCoverage(chunks.filter((_, i) => i !== 2), [{ path: "HISTORY.md", text: history }])[0];
    expect(gap.ok).toBe(false);
    expect(gap.problem).toMatch(/lines 13–15 are missing/);
  });

  it("splits oversized entries at subheadings", () => {
    const sr: SourceRecipe = { path: "HISTORY.md", sections: [{ ...historyRecipe.sections[0], maxLines: 4, subsplit: "heading" }] };
    const chunks = splitSource(sr, history).filter((c) => c.key === "1.0.7 (2)");
    expect(chunks.map((c) => [c.start, c.end, c.part?.index, c.part?.total])).toEqual([
      [19, 21, 1, 2],
      [22, 23, 2, 2],
    ]);
    expect(chunks.every((c) => c.key === "1.0.7 (2)")).toBe(true);
  });

  it("groups short items of an oversized entry into a few parts instead of one per item", () => {
    const items = Array.from({ length: 30 }, (_, i) => `- Rule ${i + 1} must hold.`).join("\n");
    const text = `# Invariants\n\n## §2 The clock\n${items}\n`;
    const sr: SourceRecipe = { path: "INV.md", sections: [{ startLine: 1, kind: "invariants", split: { mode: "heading", level: 2 }, maxLines: 12, subsplit: "items" }] };
    const chunks = splitSource(sr, text);
    const parts = chunks.filter((c) => c.part);
    // 31 lines, pieces of one line, a minimum of 4 lines per part: 7 parts, not 30.
    expect(parts.length).toBe(7);
    expect(parts.every((c) => c.end - c.start + 1 >= 4)).toBe(true);
    expect(chunkCoverage(chunks, [{ path: "INV.md", text }])[0].ok).toBe(true);
  });

  it("splits rules written as a list, keeping headings and intro text as glue", () => {
    const rules = "# Rules\n\nIntro.\n\n1. Run the tests.\n2. Never push to main;\n   open a pull request.\n\n## Extra\n- Keep PRs small.\n";
    const sr: SourceRecipe = { path: "R.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "items" } }] };
    const chunks = splitSource(sr, rules);
    expect(chunks.map((c) => `${c.role}:${c.start}-${c.end}`)).toEqual(["glue:1-4", "entry:5-5", "entry:6-8", "glue:9-9", "entry:10-10"]);
    expect(chunks[2].text).toBe("2. Never push to main;\n   open a pull request.\n\n");
    expect(chunkCoverage(chunks, [{ path: "R.md", text: rules }])[0].ok).toBe(true);
  });

  it("handles files that mix kinds by section", () => {
    const mixed = "# Notes\n\n## Rules\n- Test first.\n- No force pushes.\n\n## Log\n### 2026-01-02\nDid a thing.\n### 2026-01-01\nStarted.\n";
    const sr: SourceRecipe = {
      path: "CLAUDE.md",
      sections: [
        { startLine: 1, kind: "rules", split: { mode: "items" } },
        { startLine: 7, kind: "history", split: { mode: "heading", level: 3 }, key: "^###\\s+(\\S+)" },
      ],
    };
    const chunks = splitSource(sr, mixed);
    expect(chunks.filter((c) => c.role === "entry").map((c) => `${c.kind}:${c.title}`)).toEqual([
      "rules:Test first.",
      "rules:No force pushes.",
      "history:2026-01-02",
      "history:2026-01-01",
    ]);
    expect(chunkCoverage(chunks, [{ path: "CLAUDE.md", text: mixed }])[0].ok).toBe(true);
  });
});

describe("cross-references", () => {
  it("resolves references by key across files, ignoring spacing, and skips self-references", () => {
    const recipe: Recipe = {
      version: 1,
      sources: [historyRecipe, invariantsRecipe],
      refs: [
        { pattern: "§\\s*(\\d+)", kind: "invariants" },
        { pattern: "(\\d+\\.\\d+\\.\\d+\\s*\\(\\d+\\))", kind: "history" },
      ],
    };
    const chunks = [...splitSource(historyRecipe, history), ...splitSource(invariantsRecipe, invariants)];
    const hits = findRefs(recipe, chunks);
    const show = hits.map((h) => `${h.text}→${h.target ? chunks.find((c) => c.id === h.target)!.key : "?"}`);
    expect(show).toContain("§2→2");
    expect(show).toContain("1.0.8 (6)→1.0.8 (6)");
    expect(show).toContain("1.0.7 (2)→1.0.7 (2)");
    // The heading "## 1.0.8 (6)" doesn't count as a reference to itself.
    expect(hits.filter((h) => h.chunk === "HISTORY.md#L5" && h.text === "1.0.8 (6)")).toHaveLength(0);
  });
});

describe("reference fallbacks", () => {
  it("tries the key, then without v, then without the build number, then the parent section", async () => {
    const { keyFallbacks } = await import("../../src/core/build/split");
    expect(keyFallbacks("4.3")).toEqual(["4.3", "4"]);
    expect(keyFallbacks("v0.2.1(1)")).toEqual(["v0.2.1(1)", "0.2.1(1)", "v0.2.1", "0.2.1"]);
    expect(keyFallbacks("1.0.6(7)")).toEqual(["1.0.6(7)", "1.0.6"]);
    expect(keyFallbacks("12a.2")).toEqual(["12a.2", "12a"]);
  });
});

describe("recipe validation", () => {
  const read = (p: string) => (p === "HISTORY.md" ? history : invariants);
  it("accepts a working recipe", () => {
    expect(validateRecipe({ version: 1, sources: [historyRecipe, invariantsRecipe], refs: [] }, ["HISTORY.md", "INVARIANTS.md"], read)).toBeUndefined();
  });
  it("reports missing sources, bad regexes, and splits that find nothing", () => {
    expect(validateRecipe({ version: 1, sources: [historyRecipe], refs: [] }, ["HISTORY.md", "INVARIANTS.md"], read)).toMatch(/missing these sources: INVARIANTS.md/);
    const bad = { ...historyRecipe, sections: [{ ...historyRecipe.sections[0], key: "(unclosed" }] };
    expect(validateRecipe({ version: 1, sources: [bad], refs: [] }, ["HISTORY.md"], read)).toMatch(/invalid regex/);
    const none = { ...historyRecipe, sections: [{ ...historyRecipe.sections[0], split: { mode: "heading" as const, level: 5 } }] };
    expect(validateRecipe({ version: 1, sources: [none], refs: [] }, ["HISTORY.md"], read)).toMatch(/produced no entries/);
  });
  it("rejects a key regex that matches no entries, but allows some entries without keys", () => {
    const wrong = { ...historyRecipe, sections: [{ ...historyRecipe.sections[0], key: "^##\\s+v(\\d+)" }] };
    expect(validateRecipe({ version: 1, sources: [wrong], refs: [] }, ["HISTORY.md"], read)).toMatch(/matched none/);
    // "Server-side" has no version, and that's fine.
    expect(validateRecipe({ version: 1, sources: [historyRecipe], refs: [] }, ["HISTORY.md"], read)).toBeUndefined();
  });
});

describe("recipes written by code", () => {
  it("keeps short notes whole and splits long ones at their main headings", () => {
    expect(codeRecipeForNotes("a.md", "# A\n\ntext\n").sections[0].split).toEqual({ mode: "whole" });
    const long = `# Plan\n${Array.from({ length: 5 }, (_, i) => `## Part ${i}\n${"line\n".repeat(80)}`).join("")}`;
    expect(codeRecipeForNotes("b.md", long).sections[0].split).toEqual({ mode: "heading", level: 2 });
  });
});
