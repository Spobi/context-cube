import { describe, expect, it } from "vitest";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeStats, renderStats } from "../../src/core/stats/reads";
import { loadCube, getBox } from "../../src/core/cube";
import { linkCode } from "../../src/core/code/links";
import { reindex } from "../../src/core/index/index";
import { writeDrawer } from "../../src/core/ops";
import type { ReadRecord } from "../../src/core/logs/extract";
import { smallCube } from "../fixtures/build";

const tok = (path: string) => Math.ceil(statSync(path).size / 4);

describe("stats: what was read", () => {
  it("matches a session worked out by hand", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/handshake.ts": "export function clockHandshake() {}\n" });
    // Give the sync box a code link to a file, so an edit there is governed by an invariant.
    writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake` at the start of each call.\n");
    linkCode(root);
    await reindex(root);
    const cube = loadCube(root);
    const c = (p: string) => `context-cube/${p}`;
    const syncRow = cube.rows.find((r) => r.name === "sync")!;
    const handshake = getBox(cube, "Y03.X001")!;
    const t = "2099-01-01T10:00:00.000Z";
    const r = (file: string, tokens: number, extra: Partial<ReadRecord> = {}): ReadRecord => ({ t, session: "s1", tool: "Read", file, chars: tokens * 4, tokens, ...extra });
    const reads: ReadRecord[] = [
      r("CLAUDE.md", 300, { tool: "Instructions", loadReason: "session_start" }),
      r(c("CUBE.md"), 200),
      r(c(`${syncRow.relDir}/ROW.md`), 120),
      r(c(`${handshake.relDir}/Z0-overview.md`), 90),
      r(c(`${handshake.relDir}/Z0-overview.md`), 90), // read twice: counted twice
      r("src/handshake.ts", 50), // code: not counted
    ];
    const edits = [{ t, session: "s1", tool: "Edit", file: "src/handshake.ts" }];
    const report = computeStats(root, { reads, edits, now: new Date("2099-01-02") });
    const s = report.sessions.find((x) => x.session === "s1")!;

    // Read: the instruction file, every cube file read (repeats count), no code files.
    expect(s.read).toBe(300 + 200 + 120 + 90 + 90);
    // Conservative: the index page read + every drawer of the one box touched.
    const drawers = handshake.drawers.map((d) => tok(d.path)).reduce((a, b) => a + b, 0);
    expect(s.conservative).toBe(tok(join(syncRow.dir, "ROW.md")) + drawers);
    // Upper bound: every file in the touched row.
    const all = syncRow.allBoxes.flatMap((b) => b.drawers.map((d) => tok(d.path))).reduce((a, b) => a + b, 0);
    const pages = readdirSync(syncRow.dir).filter((f) => /^ROW/.test(f)).map((f) => tok(join(syncRow.dir, f))).reduce((a, b) => a + b, 0);
    expect(s.upper).toBe(all + pages);
    // CUBE.md is the row list: seeing it doesn't touch a row.
    expect(s.rowsTouched).toEqual(["sync"]);
    // The edited file is governed by Y02.X001 through Y03.X001, whose Z1 wasn't opened: a possible miss.
    expect(s.misses).toEqual([{ file: "src/handshake.ts", box: "Y03.X001", invariants: ["Y02.X001"] }]);

    const text = renderStats(report);
    expect(text).toContain("Same areas without the cube:");
    expect(text).toContain("(conservative) to");
    expect(text).toContain("Possible misses: 1");
    expect(text).not.toMatch(/saving/i);
  });

  it("doesn't count a miss when the path rule loaded or the invariant was opened", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/handshake.ts": "export function clockHandshake() {}\n" });
    writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake`.\n");
    linkCode(root);
    await reindex(root);
    const t = "2099-01-01T10:00:00.000Z";
    const edits = [{ t, session: "s1", tool: "Edit", file: "src/handshake.ts" }];
    const ruleLoaded: ReadRecord = { t, session: "s1", tool: "Instructions", file: ".claude/rules/cube-Y03-X001.md", chars: 400, tokens: 100, loadReason: "path_glob_match" };
    expect(computeStats(root, { reads: [ruleLoaded], edits }).sessions[0].misses).toEqual([]);
    const cube = loadCube(root);
    const opened: ReadRecord = { t, session: "s1", tool: "Read", file: `context-cube/${getBox(cube, "Y02.X001")!.relDir}/Z1-invariants.md`, chars: 40, tokens: 10 };
    expect(computeStats(root, { reads: [opened], edits }).sessions[0].misses).toEqual([]);
  });

  it("reports memory-file reads from before the cube separately", async () => {
    const root = await smallCube({ "CLAUDE.md": "# Demo\n", "HISTORY.md": "# H\n" });
    const old: ReadRecord = { t: "2000-01-01T00:00:00.000Z", session: "old", tool: "Read", file: "HISTORY.md", chars: 4000, tokens: 1000 };
    const report = computeStats(root, { reads: [old] });
    expect(report.before).toEqual({ sessions: 1, medianMemoryTokens: 1000 });
    expect(report.sessions).toEqual([]);
    writeFileSync(join(root, "x"), "");
  });
});
