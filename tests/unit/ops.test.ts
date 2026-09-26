import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCube, getBox, readDrawer } from "../../src/core/cube";
import { addLink, createBox, deleteBox, moveBox, renameBox, writeDrawer } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { loadAliases, loadRetired, resolveAlias, retire } from "../../src/core/state/state";
import { resolve as resolveCmd } from "../../src/commands/core";
import { smallCube } from "../fixtures/build";
import { splitGenerated } from "../../src/core/format/generated";

describe("building a cube with commands", () => {
  it("creates the starting rows and the boxes", async () => {
    const root = await smallCube();
    const cube = loadCube(root);
    expect(cube.rows.map((r) => `${r.id} ${r.name} ${r.type}`)).toEqual([
      "Y00 rules rules",
      "Y01 history history",
      "Y02 invariants invariants",
      "Y03 sync system",
    ]);
    expect(getBox(cube, "Y03.X001")!.header!.links[0]).toEqual({
      to: "Y02.X001",
      name: "sixty-second-clock",
      rel: "governed-by",
      note: "the handshake sets the clock",
    });
  });

  it("generates backlinks: Z1 for invariants a box links to, Z3 for history that touched it", async () => {
    const root = await smallCube();
    const cube = loadCube(root);
    const handshake = getBox(cube, "Y03.X001")!;
    expect(readDrawer(handshake, 1)).toContain("- [[Y02.X001]] sixty-second-clock: the handshake sets the clock");
    expect(readDrawer(handshake, 3)).toContain("- [[Y01.X001]] build-1-0-1: the handshake now re-runs on reconnect");
    const clock = getBox(cube, "Y02.X001")!;
    // The invariant's own Z1 text stays exactly as written, with no generated section.
    expect(readDrawer(clock, 1)).toBe("- Both sides compute the same end time.\n- Never restart the clock mid-call.\n");
    expect(readDrawer(clock, 3)).toContain("[[Y01.X001]] build-1-0-1: Fixed a drift");
  });

  it("never reuses a number, even after a delete", async () => {
    const root = await smallCube();
    const a = createBox(root, 3, { name: "one-more", summary: "x", readWhen: "y" });
    expect(a.id).toBe("Y03.X002");
    deleteBox(root, "Y03.X002", "test");
    expect(loadRetired(root).map((r) => r.id)).toContain("Y03.X002");
    const b = createBox(root, 3, { name: "another", summary: "x", readWhen: "y" });
    expect(b.id).toBe("Y03.X003");
  });

  it("move renumbers, rewrites links and inline references, records an alias, and retires the old number", async () => {
    const root = await smallCube();
    writeDrawer(root, "Y01.X001", 4, "## 1.0.1\nSee [[Y03.X001]] and [[Y03.X001.Z1]].\n");
    const r = moveBox(root, "Y03.X001", "Y02");
    expect(r).toEqual({ from: "Y03.X001", to: "Y02.X002" });
    await reindex(root);
    const cube = loadCube(root);
    const hist = getBox(cube, "Y01.X001")!;
    expect(hist.header!.links.map((l) => l.to)).toEqual(["Y02.X002", "Y02.X001"]);
    expect(splitGenerated(readDrawer(hist, 4)!).own).toBe("## 1.0.1\nSee [[Y02.X002]] and [[Y02.X002.Z1]].\n");
    expect(splitGenerated(readDrawer(hist, 4)!).generated).toMatch(/^Past record: /);
    expect(resolveAlias(loadAliases(root), "Y03.X001")).toBe("Y02.X002");
    expect(loadRetired(root).map((x) => x.id)).toContain("Y03.X001");
    expect(getBox(cube, "Y02.X002")!.header!.id).toBe("Y02.X002");
    expect(resolveCmd("Y03.X001", { cwd: root })[0]).toMatch(/^Y02\.X002 clock-handshake/);
  });

  it("rename keeps the coordinate and syncs link names everywhere", async () => {
    const root = await smallCube();
    renameBox(root, "Y02.X001", "shared-end-time");
    await reindex(root);
    const cube = loadCube(root);
    expect(getBox(cube, "Y02.X001")!.relDir).toBe("Y02-invariants/X001-shared-end-time");
    expect(getBox(cube, "Y03.X001")!.header!.links[0].name).toBe("shared-end-time");
    expect(readFileSync(join(root, "context-cube/Y03-sync/X001-clock-handshake/Z1-invariants.md"), "utf8")).toContain("[[Y02.X001]] shared-end-time");
  });

  it("re-pads a row automatically when it passes 999", async () => {
    const root = await smallCube();
    retire(root, "Y03.X999", "test: pretend 999 boxes existed");
    const box = createBox(root, 3, { name: "the-thousandth", summary: "x", readWhen: "y" });
    expect(box.id).toBe("Y03.X1000");
    const cube = loadCube(root);
    expect(getBox(cube, "Y03.X0001")!.relDir).toBe("Y03-sync/X0001-clock-handshake");
    expect(getBox(cube, "Y03.X001")!.header!.id).toBe("Y03.X0001");
    expect(getBox(cube, "Y01.X001")!.header!.links[0].to).toBe("Y03.X0001");
    expect(existsSync(join(root, "context-cube/.state/boxes/Y03.X0001.json"))).toBe(true);
  });

  it("link adds a named header link", async () => {
    const root = await smallCube();
    const l = addLink(root, "Y00.X001", "Y02.X001", "governed-by", "why the rule exists");
    expect(l).toEqual({ to: "Y02.X001", name: "sixty-second-clock", rel: "governed-by", note: "why the rule exists" });
  });
});
