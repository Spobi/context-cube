import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../../src/commands/build";
import { FakeBackend } from "../../src/ai/backends";
import { scriptedAsker } from "../../src/setup/ask";
import { allBoxes, getBox, loadCube, readDrawer } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { placedCoverage } from "../../src/core/build/coverage";
import { chronological } from "../../src/core/build/place";
import { inferHistoryUnit } from "../../src/core/build/stages";
import { loadRecipe } from "../../src/core/build/recipe";
import { addedLines } from "../../src/core/build/catchup";
import { splitGenerated } from "../../src/core/format/generated";
import { archiveSources } from "../../src/core/archive";
import { loadAliases, resolveAlias } from "../../src/core/state/state";
import type { Chunk } from "../../src/core/build/split";
import { commitAll, tempProject } from "../helpers";
import { answer, files } from "../fixtures/scripted";

describe("the full build with a scripted AI", () => {
  it("places every piece word for word, in time order, with coverage, aliases, and links", async () => {
    const root = tempProject(files);
    commitAll(root);
    const backend = new FakeBackend((c) => answer(c));
    const log: string[] = [];
    await build({ cwd: root, ask: scriptedAsker({}, log), backend });
    const cube = loadCube(root);
    expect(cube.rows.map((r) => `${r.id} ${r.name}`)).toEqual(["Y00 rules", "Y01 history", "Y02 invariants", "Y03 sync"]);

    // Rules: the Z0 body is the rule, word for word.
    const rules = cube.rows[0].boxes;
    expect(rules.map((b) => b.doc!.body)).toEqual(["- Use pnpm.\n", "- Never commit secrets.\n"]);

    // History: oldest first (the deploy on 2026-01-15), Z4 word for word.
    const hist = cube.rows[1].boxes;
    expect(hist.map((b) => readDrawer(b, 4)!.split("\n")[0])).toEqual(["## Deploy — 2026-01-15", "## 1.1 (1) — 2026-02-01", "## 1.1 (2) — Faster sync"]);
    expect(hist[0].header).toMatchObject({ name: "entry-001", summary: "Summary of Y01.X001.", written_by: "ai" });
    expect(hist[0].header!.links.map((l) => l.to)).toContain("Y03");
    expect(hist[0].header!.links.map((l) => l.to)).not.toContain("Y99");

    // Invariants: Z1 word for word; governs becomes governed-by on the governed box.
    const inv = cube.rows[2].boxes;
    expect(readDrawer(inv[0], 1)).toBe("## §1 Order\n- Edits apply in order.\n\n");
    const screen = getBox(cube, "Y03.X001")!;
    expect(screen.header!.links.filter((l) => l.rel === "governed-by").map((l) => l.to)).toEqual(["Y02.X001", "Y02.X002"]);
    // The short design doc stays whole (code splits notes; no AI) and became the proposed
    // box's Z4 instead of a second box about the same thing.
    expect(readDrawer(screen, 4)).toBe(files["DESIGN.md"]);
    expect(cube.rows[3].boxes).toHaveLength(1);

    // Text between entries sits in root Z4s, wrapped in markers.
    const invRoot = readDrawer(cube.rows[2].root!, 4)!;
    expect(invRoot).toContain("<!-- cube:from INVARIANTS.md L1-L4 -->\n# Invariants\n\nThese hold the app together.\n\n<!-- cube:end-from -->");

    // Legacy references resolve, and references became links.
    const aliases = loadAliases(root);
    expect(resolveAlias(aliases, "§2")).toBe("Y02.X002");
    expect(resolveAlias(aliases, "1.1 (2)")).toBe("Y01.X003");
    const newest = getBox(cube, "Y01.X003")!;
    expect(newest.header!.links).toContainEqual(expect.objectContaining({ to: "Y02.X002", rel: "see-also", note: "mentions §2" }));

    // Every source recombines exactly, and the cube passes its checks.
    const cov = placedCoverage(root, ["AGENTS.md", "HISTORY.md", "INVARIANTS.md", "DESIGN.md"]);
    expect(cov.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);

    // The always-loaded block went into CLAUDE.md with the rules; the originals are untouched.
    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude).toContain("- Y00.X001 Use pnpm.");
    for (const [p, t] of Object.entries(files)) expect(readFileSync(join(root, p), "utf8")).toBe(t);

    // A hand edit to migrated text shows up as a coverage difference.
    const z1 = join(inv[0].dir, "Z1-invariants.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(z1, readFileSync(z1, "utf8").replace("in order", "in any order"));
    expect(placedCoverage(root, ["INVARIANTS.md"])[0].ok).toBe(false);

    expect(log.join("\n")).toContain("Every line of your 4 source files is in the cube, word for word.");
    expect(allBoxes(cube).every((b) => b.header?.read_when)).toBe(true);
  });

  it("offers to file rules from a file that isn't agent instructions as notes, when the rules would go over the ceiling", async () => {
    const runbook = `# Release runbook\n\n${Array.from({ length: 6 }, (_, i) => `## Step ${i + 1}\n${"Check the build number and the changelog before you ship. ".repeat(40)}\n`).join("\n")}`;
    const root = tempProject({ ...files, "docs/RUNBOOK.md": runbook });
    commitAll(root);
    const backend = new FakeBackend((c) => {
      const a = answer(c) as any;
      if (c.step === "classify") for (const f of a.files) if (f.path === "docs/RUNBOOK.md") f.role = "rules";
      if (c.step === "recipe" && c.prompt.includes("## Source: docs/RUNBOOK.md")) a.sources.push({ path: "docs/RUNBOOK.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "heading", level: 2 } }] });
      return a;
    });
    const log: string[] = [];
    await build({ cwd: root, ask: scriptedAsker({}, log), backend });
    const text = log.join("\n");
    expect(text).toMatch(/The rules found would load about [\d,]+ tokens into every session; the ceiling is about 3,000\. 6 of them come from files that aren't agent instructions/);
    expect(text).toMatch(/docs\/RUNBOOK\.md: 6 \(~[\d,]+ tokens\), such as "Step 1"/);
    expect(log).toContain("? File those with the notes instead, in the rows they're about, so they load only when a task needs them?");
    // Only the agent file's rules load every session; the runbook's steps became notes, word for word.
    const cube = loadCube(root);
    expect(cube.rows[0].boxes.map((b) => b.doc!.body)).toEqual(["- Use pnpm.\n", "- Never commit secrets.\n"]);
    expect(loadRecipe(root)!.sources.find((x) => x.path === "docs/RUNBOOK.md")!.sections[0].kind).toBe("notes");
    expect(placedCoverage(root, ["docs/RUNBOOK.md"])[0].ok).toBe(true);
    expect(allBoxes(cube).filter((b) => b.header?.source?.startsWith("docs/RUNBOOK.md"))).toHaveLength(6);
  });

  it("asks about rules that are headed sections of a document even under the ceiling, but not a short list of house rules", async () => {
    const release = "# Release\n\n## Build\nBump the build number.\n\n## Upload\nUpload with the release script.\n";
    const root = tempProject({ ...files, "docs/RELEASE.md": release, "HOUSE.md": "# House rules\n\n- Tabs, not spaces.\n" });
    commitAll(root);
    const backend = new FakeBackend((c) => {
      const a = answer(c) as any;
      if (c.step === "classify") for (const f of a.files) if (f.path === "docs/RELEASE.md" || f.path === "HOUSE.md") f.role = "rules";
      if (c.step === "recipe" && c.prompt.includes("## Source: docs/RELEASE.md")) a.sources.push({ path: "docs/RELEASE.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "heading", level: 2 } }] });
      if (c.step === "recipe" && c.prompt.includes("## Source: HOUSE.md")) a.sources.push({ path: "HOUSE.md", sections: [{ startLine: 1, kind: "rules", split: { mode: "items" } }] });
      return a;
    });
    const log: string[] = [];
    await build({ cwd: root, ask: scriptedAsker({}, log), backend });
    const text = log.join("\n");
    expect(text).toMatch(/2 of the rules found are sections of a file that isn't agent instructions, and read more like plans or procedures than rules for every task\./);
    expect(text).toContain('docs/RELEASE.md: 2 (');
    expect(text).not.toContain("HOUSE.md: ");
    const rules = loadCube(root).rows[0].boxes.map((b) => b.doc!.body);
    expect(rules).toContain("- Tabs, not spaces.\n");
    expect(rules.some((r) => r.includes("Bump the build number"))).toBe(false);
    expect(placedCoverage(root, ["docs/RELEASE.md", "HOUSE.md"]).every((c) => c.ok)).toBe(true);
  });

  it("orders history across files by date, keeping each file's own order", () => {
    const c = (source: string, start: number, date?: string): Chunk => ({ id: `${source}#${start}`, source, section: 0, kind: "history", role: "entry", start, end: start, text: "", date });
    const recipeLike = { version: 1 as const, refs: [], sources: [
      { path: "NEW.md", sections: [{ startLine: 1, kind: "history" as const, split: { mode: "whole" as const }, order: "newest-first" as const }] },
      { path: "OLD.md", sections: [{ startLine: 1, kind: "history" as const, split: { mode: "whole" as const }, order: "oldest-first" as const }] },
    ] };
    const out = chronological(
      [c("NEW.md", 1), c("NEW.md", 5, "2026-03-01"), c("NEW.md", 9, "2026-02-20"), c("OLD.md", 1, "2026-01-01"), c("OLD.md", 5, "2026-02-25")],
      recipeLike,
    );
    // NEW.md reversed: 9 (02-20), 5 (03-01), 1 (undated → stays after 5). OLD.md interleaves by date.
    expect(out.map((x) => x.id)).toEqual(["OLD.md#1", "NEW.md#9", "OLD.md#5", "NEW.md#5", "NEW.md#1"]);
  });

  it("infers the history unit from entry keys", () => {
    const e = (key?: string, date?: string) => ({ key, date }) as Chunk;
    expect(inferHistoryUnit([e("1.0.8 (6)"), e("1.0.8 (5)")])).toBe("build");
    expect(inferHistoryUnit([e("2.1.0"), e("2.0.9")])).toBe("release");
    expect(inferHistoryUnit([e(undefined, "2026-01-01"), e(undefined, "2026-01-02")])).toBe("day");
  });
});

describe("starting the big part later", () => {
  // A clock that jumps ahead instead of waiting. Local times, so any time zone works.
  const fakeClock = (start: Date) => {
    let t = start.getTime();
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
        await new Promise((r) => setImmediate(r));
      },
    };
  };
  const at = (h: number, m = 0, day = 26) => new Date(2026, 8, day, h, m);

  it("runs the steps before the row review now, waits, then runs the rest on its own", async () => {
    const root = tempProject(files);
    commitAll(root);
    const clock = fakeClock(at(18));
    const when: Record<string, number> = {};
    const backend = new FakeBackend((c) => {
      when[c.step] ??= clock.now();
      return answer(c);
    });
    const log: string[] = [];
    const out = await build({ cwd: root, ask: scriptedAsker({ "Go ahead?": "later", "at what time?": "11:30pm" }, log), backend, clock });
    const text = log.join("\n");
    expect(out).toEqual([]);
    expect(text).toMatch(/By model:\n {2}Haiku \(smallest\)/);
    expect(text).toMatch(/Now: recipe and row structure, ~[\d,]+ \(Sonnet ~[\d,]+, Opus ~[\d,]+\), then you review the rows\./);
    expect(text).toMatch(/At 11:30 PM \(in 5 h 30 min\): the rest, ~[\d,]+/);
    expect(text).toContain("The rest starts at 11:30 PM (in 5 h 30 min). Until then this terminal waits:");
    // The recipe and rows ran at 6 PM; the summaries waited until 11:30.
    expect(when.recipe).toBe(at(18).getTime());
    expect(when.rows).toBe(at(18).getTime());
    expect(when["history-summaries"]).toBe(at(23, 30).getTime());
    // The row review asked the person; the spot check, after the unattended part, did too.
    expect(log.indexOf("? Accept these rows?")).toBeLessThan(log.findIndex((l) => l.includes("The rest starts at")));
    expect(log.some((l) => l.startsWith("? Look them over."))).toBe(true);
    expect(log.findIndex((l) => l.startsWith("? Look them over."))).toBeGreaterThan(log.findIndex((l) => l.startsWith("\nThe part that ran on its own finished")));
    expect(text).toMatch(/AI tokens used by this build: [\d,]+, by model: Haiku [\d,]+, Sonnet [\d,]+, Opus [\d,]+\./);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("waits for a usage limit to reset overnight and carries on", async () => {
    const root = tempProject(files);
    commitAll(root);
    const clock = fakeClock(at(18));
    let limited = false;
    const backend = new FakeBackend((c) => {
      if (c.step === "history-summaries" && !limited) {
        limited = true;
        return new Error("You've hit your limit · resets 4:20am (Europe/London)");
      }
      return answer(c);
    });
    const log: string[] = [];
    const out = await build({ cwd: root, ask: scriptedAsker({}, log), backend, clock, at: "23:30" });
    const text = log.join("\n");
    expect(out).toEqual([]);
    expect(text).toMatch(/Your plan hit its usage limit at 11:30 PM; it resets at 4:20 AM\. Waiting until 4:21 AM, then continuing where it stopped\./);
    expect(clock.now()).toBeGreaterThanOrEqual(at(4, 21, 27).getTime());
    expect(allBoxes(loadCube(root)).filter((b) => b.rowNum === 1 && !b.isRoot).map((b) => b.header?.summary)).toEqual(["Summary of Y01.X001.", "Summary of Y01.X002.", "Summary of Y01.X003."]);
  });

  it("stops rather than run into the day when the limit resets after the cut-off", async () => {
    const root = tempProject(files);
    commitAll(root);
    const clock = fakeClock(at(18));
    const backend = new FakeBackend((c) => (c.step === "history-summaries" ? new Error("Claude AI usage limit reached · resets 9am") : answer(c)));
    const log: string[] = [];
    const out = (await build({ cwd: root, ask: scriptedAsker({}, log), backend, clock, at: "23:30" })).join("\n");
    expect(out).toContain("Paused: your Claude plan hit a usage limit.");
    expect(out).toContain("It wouldn't reset before 7:30 AM, and the build starts nothing new after that.");
    expect(clock.now()).toBe(at(23, 30).getTime());
  });

  it("asks before starting much later than chosen, as when the computer slept", async () => {
    const root = tempProject(files);
    commitAll(root);
    const t0 = at(18);
    let t = t0.getTime();
    // The computer sleeps through the night: the first wait wakes up at 8 AM.
    const clock = { now: () => t, sleep: async () => void (t = at(8, 0, 27).getTime()) };
    const log: string[] = [];
    const out = await build({ cwd: root, ask: scriptedAsker({}, log), backend: new FakeBackend((c) => answer(c)), clock, at: "23:30" });
    expect(log.some((l) => l.startsWith("? It's 8:00 AM. The rest was set to start at 11:30 PM, but couldn't"))).toBe(true);
    expect(out.join("\n")).toContain("Didn't start.");
    expect(allBoxes(loadCube(root)).filter((b) => !b.isRoot)).toEqual([]);
  });

  it("rejects a start time it can't read", async () => {
    await expect(build({ cwd: tempProject(files), ask: scriptedAsker({}), backend: new FakeBackend((c) => answer(c)), at: "tonight" })).rejects.toThrow(/isn't a time this understands/);
  });
});

describe("a source that changed after the build read it", () => {
  const limitedOnce = () => {
    let limited = false;
    return new FakeBackend((c) => {
      if (c.step === "history-summaries" && !limited) {
        limited = true;
        return new Error("You've hit your session limit · resets 6:20pm (America/New_York)");
      }
      return answer(c);
    });
  };
  const md = Object.keys(files).filter((p) => p.endsWith(".md"));
  const edit = (root: string, path: string, f: (s: string) => string) => writeFileSync(join(root, path), f(readFileSync(join(root, path), "utf8")));

  it("finds lines added to what was read, or says the text changed", () => {
    expect(addedLines(["a", "", "c"], ["a", "", "x", "", "c"])).toEqual([false, false, true, true, false]);
    expect(addedLines(["a", "b"], ["a", "c"])).toBeUndefined();
    expect(addedLines(["a", "b", "c"], ["a", "c"])).toBeUndefined();
  });

  it("brings in new entries when a paused build resumes, and every file still recombines exactly", async () => {
    const root = tempProject(files);
    commitAll(root);
    const backend = limitedOnce();
    expect((await build({ cwd: root, ask: scriptedAsker({}, []), backend })).join("\n")).toContain("Paused");
    // Meanwhile: a new history entry between two others, and a new invariant at the end.
    edit(root, "HISTORY.md", (t) => t.replace("## 1.1 (1) — 2026-02-01", "## 1.1 (1b) — 2026-02-10\nA hotfix. Relies on §2.\n\n## 1.1 (1) — 2026-02-01"));
    edit(root, "INVARIANTS.md", (t) => `${t}\n## §3 Safety\n- Never drop an edit.\n`);
    const log: string[] = [];
    expect(await build({ cwd: root, ask: scriptedAsker({}, log), backend })).toEqual([]);
    const text = log.join("\n");
    expect(text).toContain('HISTORY.md changed after the build read it: its new lines 6–8 ("1.1 (1b) — 2026-02-10") is now in the cube as Y01.X004, and the rest of the file moved down to match.');
    expect(text).toContain('INVARIANTS.md changed after the build read it: its new lines 10–12 ("§3 Safety") is now in the cube as Y02.X003');
    expect(placedCoverage(root, md).map((c) => [c.source, c.ok])).toEqual(md.map((p) => [p, true]));
    const cube = loadCube(root);
    expect(readDrawer(getBox(cube, "Y01.X004")!, 4)).toMatch(/^## 1\.1 \(1b\) — 2026-02-10\nA hotfix\. Relies on §2\.\n\n/);
    expect(getBox(cube, "Y01.X004")!.header).toMatchObject({ summary: "Summary of Y01.X004.", written_by: "ai" }); // summarized like the rest
    expect(readDrawer(getBox(cube, "Y02.X003")!, 1)).toBe("\n## §3 Safety\n- Never drop an edit.\n");
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
    expect(archiveSources(root).archived.sort()).toEqual(["AGENTS.md", "DESIGN.md", "HISTORY.md", "INVARIANTS.md"]);
  });

  it("fits new text between an entry's closing blank lines, as when a section goes before the next part", async () => {
    const withGap = { ...files, "HISTORY.md": files["HISTORY.md"].replace("See §2.\n\n", "See §2.\n\n\n") };
    const root = tempProject(withGap);
    commitAll(root);
    const backend = limitedOnce();
    await build({ cwd: root, ask: scriptedAsker({}, []), backend });
    // Between the two blank lines that end "1.1 (2)", with a blank line of its own at the end.
    edit(root, "HISTORY.md", (t) => t.replace("See §2.\n\n\n", "See §2.\n\n## 1.1 (3) — 2026-03-05\nNewest.\n\n\n"));
    const log: string[] = [];
    expect(await build({ cwd: root, ask: scriptedAsker({}, log), backend })).toEqual([]);
    expect(log.join("\n")).toContain('its new lines 6–9 ("1.1 (3) — 2026-03-05") is now in the cube as Y01.X004');
    const cube = loadCube(root);
    // "1.1 (2)" keeps one closing blank line; the other now follows the new entry.
    const own = (id: string) => splitGenerated(readDrawer(getBox(cube, id)!, 4)!).own;
    expect(own("Y01.X003")).toBe("## 1.1 (2) — Faster sync\nSync got faster. See §2.\n\n");
    expect(own("Y01.X004")).toBe("## 1.1 (3) — 2026-03-05\nNewest.\n\n\n");
    expect(placedCoverage(root, ["HISTORY.md"])[0].ok).toBe(true);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("catches up when the file changed between reading and placing (a build started later)", async () => {
    const root = tempProject(files);
    commitAll(root);
    const backend = new FakeBackend((c) => answer(c));
    await build({ cwd: root, ask: scriptedAsker({}, []), backend, stopAfter: "review" });
    edit(root, "HISTORY.md", (t) => t.replace("# History\n\n", "# History\n\n## 1.2 (1) — 2026-03-01\nOffline mode.\n\n"));
    const log: string[] = [];
    await build({ cwd: root, ask: scriptedAsker({}, log), backend });
    expect(log.join("\n")).toContain('its new lines 3–5 ("1.2 (1) — 2026-03-01") is now in the cube as Y01.X004');
    expect(placedCoverage(root, md).every((c) => c.ok)).toBe(true);
  });

  it("keeps a file whose text was edited as the build read it, and leaves it in place", async () => {
    const root = tempProject(files);
    commitAll(root);
    const backend = limitedOnce();
    await build({ cwd: root, ask: scriptedAsker({}, []), backend });
    edit(root, "HISTORY.md", (t) => t.replace("Server went live.", "Server went live in us-east."));
    const log: string[] = [];
    expect(await build({ cwd: root, ask: scriptedAsker({}, log), backend })).toEqual([]);
    const text = log.join("\n");
    expect(text).toContain("HISTORY.md changed after the build read it, and not only by new entries (text the build read was changed or removed, not only added to). The cube keeps it as the build read it, and it will stay where it is, not archived");
    expect(text).toContain("Coverage: all 4 source files recombine exactly from the cube (");
    expect(text).toContain("one as the build read it.");
    const r = archiveSources(root);
    expect(r.archived).not.toContain("HISTORY.md");
    expect(r.skipped.map((x) => x.path)).toContain("HISTORY.md");
    expect(readFileSync(join(root, "HISTORY.md"), "utf8")).toContain("Server went live in us-east.");
  });
});
