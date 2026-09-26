import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCube, getBox } from "../../src/core/cube";
import { linkCode } from "../../src/core/code/links";
import { pathRulesFor } from "../../src/core/code/pathRules";
import { alwaysLoadedBlock, reindex } from "../../src/core/index/index";
import { rowPages } from "../../src/core/index/pages";
import { loadConfig } from "../../src/core/config";
import { addLink, createBox, writeDrawer } from "../../src/core/ops";
import { proposeNew } from "../../src/core/approvals";
import { computeStats, renderStats } from "../../src/core/stats/reads";
import { find, globMatch, related, renderRelated } from "../../src/core/related";
import { runChecks, vagueReadWhen } from "../../src/core/check/check";
import { edit } from "../../src/commands/living";
import type { ReadRecord } from "../../src/core/logs/extract";
import { smallCube } from "../fixtures/build";

/** A small cube whose sync box covers src/handshake.ts, governed by Y02.X001. */
async function linkedCube() {
  const root = await smallCube({ "CLAUDE.md": "# Demo\n", "src/handshake.ts": "export function clockHandshake() {}\n", "src/ui/Button.tsx": "export {}\n" });
  writeDrawer(root, "Y03.X001", 4, "Runs `clockHandshake` at the start of each call.\n");
  linkCode(root);
  await reindex(root);
  return root;
}

describe("candidate invariants aren't rules", () => {
  it("get no path rule, a candidate label, and don't count as misses", async () => {
    const root = await linkedCube();
    const res = proposeNew(root, { name: "drafted-rule", summary: "A drafted rule.", readWhen: "Before changing the handshake in src/handshake.ts.", text: "- `clockHandshake` must run once.\n", reason: "drafted" });
    addLink(root, "Y03.X001", res.proposal.box, "governed-by", "drafted from a fix commit");
    linkCode(root);
    await reindex(root);
    const cube = loadCube(root);
    const cand = getBox(cube, res.proposal.box)!;
    expect(cand.header!.status).toBe("pending");

    // No rule for the candidate, and the sync box's rule names only the approved invariant.
    const rules = pathRulesFor(cube);
    expect(rules.find((r) => r.id === `cube-${cand.id.replace(".", "-")}`)).toBeUndefined();
    const sync = rules.find((r) => r.id === "cube-Y03-X001")!;
    expect(sync.body).toContain("Y02.X001");
    expect(sync.body).not.toContain(cand.id);

    // Labeled wherever an agent reads it.
    expect(readFileSync(join(cand.dir, "Z1-invariants.md"), "utf8")).toContain("Candidate, not approved");
    const page = rowPages(cube.rows.find((r) => r.type === "invariants")!, loadConfig(root))[0].text;
    expect(page).toContain("CANDIDATE, not approved by a person");
    expect(readFileSync(join(getBox(cube, "Y03.X001")!.dir, "Z1-invariants.md"), "utf8")).toContain(`[[${cand.id}]] drafted-rule (candidate, not approved)`);

    // An edit governed only through the candidate isn't a miss.
    const t = "2099-01-01T10:00:00.000Z";
    const opened: ReadRecord = { t, session: "s1", tool: "Read", file: `context-cube/${getBox(cube, "Y02.X001")!.relDir}/Z1-invariants.md`, chars: 40, tokens: 10 };
    const s = computeStats(root, { reads: [opened], edits: [{ t, session: "s1", tool: "Edit", file: "src/handshake.ts" }] }).sessions[0];
    expect(s.misses).toEqual([]);

    // related lists it apart from the approved invariants.
    const r = related(root, "src/handshake.ts", root);
    expect(r.invariants.map((b) => b.id)).toEqual(["Y02.X001"]);
    expect(r.candidates.map((b) => b.id)).toEqual([cand.id]);
  });
});

describe("history reads as the past", () => {
  it("marks closed entries as past records and says so in the row index", async () => {
    const root = await linkedCube();
    const cube = loadCube(root);
    const z4 = readFileSync(join(getBox(cube, "Y01.X001")!.dir, "Z4-detail.md"), "utf8");
    expect(z4).toContain("Past record");
    expect(z4).toContain("the invariant and the code are current");
    const page = rowPages(cube.rows.find((r) => r.type === "history")!, loadConfig(root))[0].text;
    expect(page).toContain("Entries are past records.");
  });
});

describe("related and find", () => {
  it("routes a file to its invariants, boxes, and history without AI", async () => {
    const root = await linkedCube();
    const r = related(root, "src/handshake.ts", root);
    expect(r.kind).toBe("path");
    expect(r.invariants.map((b) => b.id)).toEqual(["Y02.X001"]);
    expect(r.boxes.map((b) => b.id)).toEqual(["Y03.X001"]);
    // Y01.X001 touches the sync box, so it touched the file's area.
    expect(r.history.map((b) => b.id)).toEqual(["Y01.X001"]);
    const text = renderRelated(r);
    expect(text).toContain("Invariants to read before editing it (Z1):");
    expect(text).toContain("Z1-invariants.md");
    expect(text).toContain("past records");
    // A folder and a code name route the same way.
    expect(related(root, "src", root).boxes.map((b) => b.id)).toEqual(["Y03.X001"]);
    expect(related(root, "clockHandshake", root).boxes.map((b) => b.id)).toEqual(["Y03.X001"]);
    expect(renderRelated(related(root, "src/nothing.ts", root))).toMatch(/^The cube has nothing linked/);
  });

  it("finds boxes containing every word, labeling history and candidates", async () => {
    const root = await linkedCube();
    const hits = find(root, "clock reconnect");
    expect(hits[0].id).toBe("Y01.X001");
    expect(hits[0].label).toBe("past record");
    expect(find(root, "no-such-words-anywhere")).toEqual([]);
  });

  it("matches globs", () => {
    expect(globMatch("src/ui/**", "src/ui/Button.tsx")).toBe(true);
    expect(globMatch("src/ui/**", "src/ui/a/b.tsx")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/x.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/x.ts")).toBe(false);
  });
});

describe("the always-loaded block has a ceiling", () => {
  it("scopes a rule to files: out of the block, into a path rule", async () => {
    const root = await linkedCube();
    createBox(root, 0, { name: "components-in-ui", summary: "Components live in src/ui.", readWhen: "Always.", body: "Each component in src/ui has its own file.\n" });
    await reindex(root);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Y00.X002 Each component in src/ui");
    await edit("Y00.X002", { paths: "src/ui/**", cwd: root });
    const block = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(block).not.toContain("Y00.X002 Each component");
    expect(block).toContain("1 more rule loads only when you work with the files it covers");
    const rule = readFileSync(join(root, ".claude/rules/cube-Y00-X002.md"), "utf8");
    expect(rule).toContain('"src/ui/**"');
    expect(rule).toContain("Each component in src/ui has its own file.");
    expect(related(root, "src/ui/Button.tsx", root).rules.map((b) => b.id)).toEqual(["Y00.X002"]);
    await edit("Y00.X002", { paths: "", cwd: root });
    expect(existsSync(join(root, ".claude/rules/cube-Y00-X002.md"))).toBe(false);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Y00.X002 Each component");
  });

  it("shortens the row list over the ceiling, and check warns with rules to scope", async () => {
    const root = await linkedCube();
    createBox(root, 0, { name: "components-in-ui", summary: "Components live in src/ui.", readWhen: "Always.", body: "Each component in src/ui has its own file.\n" });
    await reindex(root);
    const cube = loadCube(root);
    const config = loadConfig(root);
    const full = alwaysLoadedBlock(cube, config);
    expect(full).toContain("Y03 sync: How two devices stay in step. Open when:");
    const tight = alwaysLoadedBlock(cube, { ...config, limits: { ...config.limits, blockTokens: 50 } });
    expect(tight).toContain("- Y03 sync: open when changing anything that both devices must agree on.");
    expect(tight).toContain("What each row holds: context-cube/CUBE.md");
    expect(tight.length).toBeLessThan(full.length);
    const { configSet } = await import("../../src/commands/core");
    await configSet("limits.blockTokens", "50", { cwd: root });
    const issues = await runChecks(root);
    const big = issues.find((i) => i.code === "block-too-large")!;
    expect(big.fix).toContain('edit Y00.X002 --paths "src/ui/**"');
  });
});

describe("links and read-when lines", () => {
  it("flags vague read-when lines", () => {
    expect(vagueReadWhen("Working on WebRTC.")).toBe("Working on WebRTC");
    expect(vagueReadWhen("Optimizing sync performance, debugging sync issues, or understanding sync architecture")).toBe("understanding sync architecture");
    expect(vagueReadWhen("Sync stuff")).toBe("Sync stuff");
    expect(vagueReadWhen("Before changing call negotiation, ICE handling, or SDP creation, or when calls connect on one version but not another.")).toBeUndefined();
    expect(vagueReadWhen("Always.")).toBeUndefined();
  });

  it("warns about too many links and links without a note", async () => {
    const root = await linkedCube();
    for (let i = 0; i < 9; i++) createBox(root, 3, { name: `part-${i + 2}`, summary: "A part.", readWhen: "Before changing this part of the sync handshake." });
    for (let i = 0; i < 9; i++) addLink(root, "Y03.X001", `Y03.X00${i + 2}`, "see-also", i ? "a related part" : undefined);
    await reindex(root);
    const codes = (await runChecks(root)).map((i) => i.code);
    expect(codes).toContain("too-many-links");
    expect(codes).toContain("link-without-note");
  });
});

describe("opened but possibly unused", () => {
  it("tells boxes the agent used from boxes it opened for nothing", async () => {
    const root = await linkedCube();
    const cube = loadCube(root);
    const sync = getBox(cube, "Y03.X001")!;
    const hist = getBox(cube, "Y01.X001")!;
    const t0 = "2099-01-01T10:00:00.000Z";
    const t1 = "2099-01-01T10:01:00.000Z";
    const r = (file: string, t: string): ReadRecord => ({ t, session: "s1", tool: "Read", file, chars: 400, tokens: 100 });
    const reads = [r(`context-cube/${sync.relDir}/Z0-overview.md`, t0), r(`context-cube/${hist.relDir}/Z4-detail.md`, t0)];
    // Afterwards the agent talks about clockHandshake (named in the sync box) and nothing from the history entry.
    const activity = new Map([["s1", [{ t: t1, text: "I'll update clockHandshake to re-run." }, { t: t1, text: JSON.stringify({ file_path: `context-cube/${hist.relDir}/Z0-overview.md` }), tool: "Read" }]]]);
    const s = computeStats(root, { reads, edits: [], activity }).sessions[0];
    expect(s.opened).toEqual([
      { box: "Y03.X001", tokens: 100, used: true },
      { box: "Y01.X001", tokens: 100, used: false },
    ]);
    expect(renderStats({ ...computeStats(root, { reads, edits: [], activity }) })).toContain("Opened, possibly unused: 1 of 2 boxes opened, ~100 tokens (Y01.X001)");
    // Without a transcript it says so instead of guessing.
    expect(computeStats(root, { reads, edits: [] }).sessions[0].opened).toBeUndefined();
  });
});
