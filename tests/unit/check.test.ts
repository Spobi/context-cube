import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks } from "../../src/core/check/check";
import { retire } from "../../src/core/state/state";
import { reindex } from "../../src/core/index/index";
import { smallCube } from "../fixtures/build";

const C = (root: string, p: string) => join(root, "context-cube", p);

function edit(path: string, fn: (s: string) => string) {
  writeFileSync(path, fn(readFileSync(path, "utf8")));
}

async function codes(root: string) {
  return (await runChecks(root)).map((i) => i.code);
}

describe("cube check", () => {
  it("passes on a cube built with commands", async () => {
    const root = await smallCube();
    expect(await runChecks(root)).toEqual([]);
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
    expect(await codes(fresh)).toEqual([]);
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
