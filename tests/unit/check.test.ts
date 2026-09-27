import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks, unsupportedNumbers } from "../../src/core/check/check";
import { addAliases, loadAliases, resolveAlias, retire } from "../../src/core/state/state";
import { createBox, moveBox } from "../../src/core/ops";
import { getBox, loadCube } from "../../src/core/cube";
import { move, newBox } from "../../src/commands/core";
import { loadConfig, saveConfig } from "../../src/core/config";
import { reindex } from "../../src/core/index/index";
import { smallCube } from "../fixtures/build";
import { commitAll } from "../helpers";

const C = (root: string, p: string) => join(root, "context-cube", p);

function edit(path: string, fn: (s: string) => string) {
  writeFileSync(path, fn(readFileSync(path, "utf8")));
}

async function codes(root: string) {
  return (await runChecks(root)).map((i) => i.code);
}

describe("cube check", () => {
  it("passes on a cube built with commands, once it's committed", async () => {
    const root = await smallCube();
    // Uncommitted in a git repository, it exists only on this machine.
    expect((await runChecks(root)).map((i) => i.code)).toEqual(["cube-not-committed"]);
    commitAll(root);
    expect(await runChecks(root)).toEqual([]);
  });

  it("follows an old alias through a box that moved, instead of calling it broken", async () => {
    const root = await smallCube();
    addAliases(root, [{ alias: "§9", target: "Y03.X001" }]);
    moveBox(root, "Y03.X001", "Y02");
    expect(resolveAlias(loadAliases(root), "§9")).toBe("Y02.X002");
    expect(await codes(root)).not.toContain("broken-alias");
  });

  it("asks for a new read-when when a rule, read \"Always.\", leaves the rules row", async () => {
    const root = await smallCube();
    await expect(move("Y00.X001", "Y03", { cwd: root })).rejects.toThrow(/Y00\.X001's read-when line is "Always\.", which in Y03 would send agents to it on every task\. Say when a task needs it: node context-cube\/\.tool\/cube\.mjs move Y00\.X001 Y03 --read-when/);
    const out = await move("Y00.X001", "Y03", { readWhen: "Before changing timer code.", cwd: root });
    expect(out[0]).toContain("Its read-when line is updated.");
    expect(getBox(loadCube(root), "Y03.X002")!.header!.read_when).toBe("Before changing timer code.");
    // One moved some other way is still caught by check.
    const rule = createBox(root, 0, { name: "release-steps", summary: "Release steps.", readWhen: "Always.", body: "- Tag the build.\n" });
    const to = moveBox(root, rule.id, "Y03").to;
    const issue = (await runChecks(root)).find((i) => i.code === "vague-read-when" && i.message.startsWith(to));
    expect(issue?.message).toContain('read-when is "Always.", which sends an agent to it on every task');
  });

  it("won't add a rule that would put the always-loaded block over its ceiling", async () => {
    const root = await smallCube();
    const config = loadConfig(root);
    config.limits.blockTokens = 400;
    saveConfig(root, config);
    await expect(newBox("Y00", "long-procedure", { summary: "Release steps.", readWhen: "Always.", body: `${"Run every release step in order. ".repeat(40)}\n`, cwd: root })).rejects.toThrow(/over its ceiling of ~400\. If it's about one area, put it in that area's row instead.*A person can raise the ceiling: node context-cube\/\.tool\/cube\.mjs config set limits\.blockTokens/);
    expect((await newBox("Y03", "long-procedure", { summary: "Release steps.", readWhen: "When releasing.", body: "Steps.\n", cwd: root }))[0]).toMatch(/^Created Y03\.X002/);
  });

  it("flags numbers an AI-written summary gives that its text doesn't", async () => {
    expect(unsupportedNumbers("Raised the cap to 2.5 Mbps (H.264 only) at 720p; ~20s ramp.", "The cap is now 2.5 Mbps. H.264 only. 720p. A 20.7 s ramp.")).toEqual([]);
    expect(unsupportedNumbers("Migration 20260727181500 adds the busy reason; 3 steps.", "migration `20260727143000` adds the busy reason in three steps")).toEqual(["20260727181500"]);
    expect(unsupportedNumbers("Shipped in 1.0.8.", "Shipped in 1.0.8 (10).")).toEqual([]);
    expect(unsupportedNumbers("About 0.8 of calls.", "Version 1.0.8 shipped.")).toEqual(["0.8"]);
    expect(unsupportedNumbers("Costs 1,500 coins.", "It costs 1500 coins.")).toEqual([]);
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace("summary: The start-of-call handshake that fixes the shared end time.", "summary: The handshake runs within 250 ms."));
    writeFileSync(C(root, "Y03-sync/X001-clock-handshake/Z4-detail.md"), "The handshake runs within 200 ms of the call starting.\n");
    await reindex(root);
    const issue = (await runChecks(root)).find((i) => i.code === "summary-numbers");
    expect(issue).toMatchObject({ id: "Y03.X001", message: expect.stringContaining('Y03.X001\'s summary gives "250", which isn\'t in its text.') });
  });

  it("catches an invalid header", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace("summary:", "summary: [unclosed"));
    expect(await codes(root)).toContain("header-invalid");
  });

  it("catches an id that doesn't match its folder", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace("id: Y03.X001", "id: Y03.X009"));
    expect(await codes(root)).toContain("id-mismatch");
  });

  it("catches broken links and broken inline references", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace("to: Y02.X001", "to: Y02.X042"));
    writeFileSync(C(root, "Y03-sync/X001-clock-handshake/Z4-detail.md"), "See [[Y09.X001]].\n");
    const c = await codes(root);
    expect(c).toContain("broken-link");
    expect(c).toContain("broken-ref");
  });

  it("catches reused numbers and duplicate coordinates", async () => {
    const root = await smallCube();
    retire(root, "Y03.X001", "pretend it was deleted");
    cpSync(C(root, "Y03-sync/X001-clock-handshake"), C(root, "Y03-sync/X001-copied-box"), { recursive: true });
    const c = await codes(root);
    expect(c).toContain("reused-number");
    expect(c).toContain("duplicate-coordinate");
  });

  it("catches a duplicate row number", async () => {
    const root = await smallCube();
    cpSync(C(root, "Y03-sync"), C(root, "Y03-other"), { recursive: true });
    expect(await codes(root)).toContain("duplicate-coordinate");
  });

  it("catches a Z0 with no read-when line", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace(/read_when: .*\n/, ""));
    expect(await codes(root)).toContain("missing-read-when");
  });

  it("catches Z0s and root drawers over their size limits", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => `${s}${"word ".repeat(120)}\n`);
    writeFileSync(C(root, "Y03-sync/X000-root/Z4-detail.md"), "x".repeat(8000));
    const c = await codes(root);
    expect(c).toContain("z0-too-long");
    expect(c).toContain("root-drawer-too-large");
  });

  it("catches stale link names", async () => {
    const root = await smallCube();
    edit(C(root, "Y03-sync/X001-clock-handshake/Z0-overview.md"), (s) => s.replace("name: sixty-second-clock", "name: old-name"));
    expect(await codes(root)).toContain("stale-link-name");
  });

  it("catches edits inside generated sections, but not sections that are merely out of date", async () => {
    const root = await smallCube();
    const z3 = C(root, "Y03-sync/X001-clock-handshake/Z3-history.md");
    edit(z3, (s) => s.replace("re-runs on reconnect", "re-runs on reconnect (edited by hand)"));
    expect(await codes(root)).toContain("generated-edited");

    const fresh = await smallCube();
    // Change a link note without reindexing: out of date, not edited.
    edit(C(fresh, "Y01-history/X001-build-1-0-1/Z0-overview.md"), (s) => s.replace("the handshake now re-runs on reconnect", "a new note"));
    const c = await codes(fresh);
    expect(c).not.toContain("generated-edited");
    expect(c).toContain("index-outdated");
    await reindex(fresh);
    expect((await codes(fresh)).filter((c) => c !== "cube-not-committed")).toEqual([]);
  });

  it("flags stray folders and files", async () => {
    const root = await smallCube();
    mkdirSync(C(root, "notes"));
    mkdirSync(C(root, "Y03-sync/misc"));
    writeFileSync(C(root, "Y03-sync/X001-clock-handshake/Z9-extra.md"), "x");
    const c = await codes(root);
    expect(c.filter((x) => x === "bad-folder-name")).toHaveLength(2);
    expect(c).toContain("stray-file");
  });
});
