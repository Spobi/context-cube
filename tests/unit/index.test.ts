import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCube } from "../../src/core/cube";
import { loadConfig } from "../../src/core/config";
import { rowPages } from "../../src/core/index/pages";
import { extractBlock } from "../../src/core/index/block";
import { estimateTokens } from "../../src/core/tokens";
import { bigHistory, smallCube } from "../fixtures/build";

const GOLDEN = fileURLToPath(new URL("../golden/", import.meta.url));

/** Compares with a saved expected file. UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, actual: string) {
  const path = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

describe("generated indexes", () => {
  it("match the golden files", async () => {
    const root = await smallCube();
    golden("CUBE.md", readFileSync(join(root, "context-cube/CUBE.md"), "utf8"));
    golden("Y01-history-ROW.md", readFileSync(join(root, "context-cube/Y01-history/ROW.md"), "utf8"));
    golden("Y03-sync-ROW.md", readFileSync(join(root, "context-cube/Y03-sync/ROW.md"), "utf8"));
    golden("CLAUDE.md", readFileSync(join(root, "CLAUDE.md"), "utf8"));
  });

  it("keeps the user's own CLAUDE.md text outside the block", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo project\n\nHouse notes stay here.\n" });
    const text = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(text.startsWith("# Demo project\n\nHouse notes stay here.\n\n<!-- context-cube:start -->\n")).toBe(true);
    const block = extractBlock(text)!;
    expect(block).toContain("- Y00.X001 Read the invariants before touching timer or sync code.");
    expect(block).toContain("- Y03 sync: How two devices stay in step.");
    expect(block).not.toContain("- Y00 rules");
  });
});

describe("paging a 500-entry history row", () => {
  it("splits at the token budget, newest first, with every entry exactly once", async () => {
    const root = await bigHistory(500);
    const cube = loadCube(root);
    const config = loadConfig(root);
    const row = cube.rows.find((r) => r.type === "history")!;
    const pages = rowPages(row, config);
    expect(pages.length).toBeGreaterThan(3);

    const files = readdirSync(row.dir).filter((f) => /^ROW(-p\d+)?\.md$/.test(f)).sort();
    expect(files).toEqual(pages.map((p) => p.file).sort());

    const seen: number[] = [];
    for (const p of pages) {
      const tokens = estimateTokens(p.text.length);
      expect(tokens).toBeLessThanOrEqual(config.rowIndex.pageTokens + 200);
      for (const m of p.text.matchAll(/^### Y01\.X(\d+) /gm)) seen.push(Number(m[1]));
    }
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
    // Newest first across pages.
    expect(seen).toEqual([...seen].sort((a, b) => b - a));

    const page1 = pages[0].text;
    expect(page1).toContain(`This index has ${pages.length} pages. This is page 1 (X500–`);
    for (const p of pages.slice(1)) expect(page1).toContain(`- ${p.file}: X`);
  });
});
