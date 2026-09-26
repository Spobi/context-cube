import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "../../src/commands/core";
import { addLink, createBox } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { installAgents } from "../../src/core/install";
import { getBox, loadCube, readDrawer } from "../../src/core/cube";
import { runChecks } from "../../src/core/check/check";
import { addFragment, openEntry } from "../../src/core/history";
import { loadAliases } from "../../src/core/state/state";
import { FIXED_GIT_ENV, tempProject } from "../helpers";

function g(root: string, args: string[], date = FIXED_GIT_ENV.GIT_AUTHOR_DATE) {
  const env = { ...process.env, ...FIXED_GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function teamRepo() {
  const root = tempProject({ "src/app.ts": "export const x = 1;\n", "CLAUDE.md": "# Team notes\n" });
  await init({ cwd: root, historyUnit: "build" });
  const { createRow } = await import("../../src/core/ops");
  createRow(root, { type: "feature", name: "calls", summary: "Calls.", readWhen: "Changing calls." });
  createBox(root, 3, { name: "ringing", summary: "Ringing.", readWhen: "Changing ringing." });
  await installAgents(root);
  await reindex(root);
  g(root, ["add", "-A"]);
  g(root, ["commit", "-q", "-m", "base"]);
  g(root, ["branch", "-M", "main"]);
  return root;
}

describe("teams sharing a repo", () => {
  it("resolves a duplicate number from a two-person branch merge automatically", async () => {
    const root = await teamRepo();
    // Alice adds a box on her branch: Y03.X002.
    g(root, ["checkout", "-q", "-b", "alice"]);
    createBox(root, 3, { name: "alice-voicemail", summary: "Voicemail.", readWhen: "Changing voicemail." });
    await reindex(root);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-q", "-m", "alice: voicemail"], "2026-02-01T10:00:00Z");
    // Bob, from main, adds a different box that also gets Y03.X002, and links a history entry to it.
    g(root, ["checkout", "-q", "main"]);
    g(root, ["checkout", "-q", "-b", "bob"]);
    const bob = createBox(root, 3, { name: "bob-call-waiting", summary: "Call waiting.", readWhen: "Changing call waiting." });
    expect(bob.id).toBe("Y03.X002");
    const h = createBox(root, 1, { name: "build-2-1", summary: "Added call waiting.", readWhen: "Debugging call waiting." });
    addLink(root, h.id, bob.id, "touches", "added call waiting");
    await reindex(root);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-q", "-m", "bob: call waiting"], "2026-02-02T10:00:00Z");
    // Merge Bob into Alice's branch: the merge drivers and post-merge hook take care of the rest.
    g(root, ["checkout", "-q", "alice"]);
    const out = spawnSync("git", ["-c", "commit.gpgsign=false", "merge", "--no-edit", "bob"], { cwd: root, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } });
    expect(out.status, out.stdout + out.stderr).toBe(0);

    const cube = loadCube(root);
    const row = cube.rows.find((r) => r.name === "calls")!;
    expect(row.boxes.map((b) => `${b.id} ${b.name}`)).toEqual(["Y03.X001 ringing", "Y03.X002 alice-voicemail", "Y03.X003 bob-call-waiting"]);
    // Bob's link followed his box to its new number.
    expect(getBox(cube, h.id)!.header!.links[0]).toMatchObject({ to: "Y03.X003", name: "bob-call-waiting" });
    expect(loadAliases(root).some((a) => a.target === "Y03.X003")).toBe(true);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("combines two people's history fragments on the same open entry", async () => {
    const root = await teamRepo();
    addFragment(root, "Opened build 2.2.", { key: "2.2 (1)", by: "Jordan", now: new Date("2026-03-01T09:00:00Z") });
    await reindex(root);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-q", "-m", "open 2.2"]);
    g(root, ["checkout", "-q", "-b", "cole"]);
    addFragment(root, "Cole fixed the ring timeout.", { key: "2.2 (1)", by: "Cole", now: new Date("2026-03-01T15:00:00Z") });
    await reindex(root);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-q", "-m", "cole: ring timeout"], "2026-03-01T15:00:00Z");
    g(root, ["checkout", "-q", "main"]);
    addFragment(root, "Jordan changed the dial tone.", { key: "2.2 (1)", by: "Jordan", now: new Date("2026-03-01T14:00:00Z") });
    await reindex(root);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-q", "-m", "jordan: dial tone"], "2026-03-01T14:00:00Z");
    const out = spawnSync("git", ["-c", "commit.gpgsign=false", "merge", "--no-edit", "cole"], { cwd: root, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } });
    expect(out.status, out.stdout + out.stderr).toBe(0);

    const open = openEntry(loadCube(root))!;
    expect(readdirSync(join(open.dir, "fragments"))).toEqual(["2026-03-01T0900-jordan.md", "2026-03-01T1400-jordan.md", "2026-03-01T1500-cole.md"]);
    const z4 = readDrawer(open, 4)!;
    expect(z4).toContain("Jordan changed the dial tone.");
    expect(z4).toContain("Cole fixed the ring timeout.");
    expect(z4.indexOf("dial tone")).toBeLessThan(z4.indexOf("ring timeout"));
    expect(z4).not.toContain("<<<<<<<");
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
    expect(readFileSync(join(root, "context-cube/.gitattributes"), "utf8")).toContain("merge=cube-drawer");
  });
});
