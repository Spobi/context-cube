import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { init } from "../../src/commands/core";
import { createBox, createRow } from "../../src/core/ops";
import { reindex } from "../../src/core/index/index";
import { renderDoc } from "../../src/core/format/header";
import { boxDirName, boxId } from "../../src/core/format/ids";
import { loadCube, getRow } from "../../src/core/cube";
import { tempProject } from "../helpers";

/** A small synthetic cube built entirely with the tool's own operations. */
export async function smallCube(files: Record<string, string> = { "CLAUDE.md": "# Demo project\n\nHouse notes stay here.\n" }): Promise<string> {
  const root = tempProject(files);
  await init({ cwd: root, historyUnit: "build" });
  createBox(root, 0, {
    name: "read-invariants-first",
    summary: "Read the invariants before touching timer code.",
    readWhen: "Always.",
    body: "Read the invariants before touching timer or sync code.\n",
  });
  createBox(root, 2, {
    name: "sixty-second-clock",
    summary: "Both phones agree on one end time for every call.",
    readWhen: "Changing call timing, extensions, or the end-of-call path.",
    drawers: { 1: "- Both sides compute the same end time.\n- Never restart the clock mid-call.\n" },
    writtenBy: "migrated",
  });
  createRow(root, { type: "system", name: "sync", summary: "How two devices stay in step.", readWhen: "Changing anything that both devices must agree on." });
  createBox(root, 3, {
    name: "clock-handshake",
    summary: "The start-of-call handshake that fixes the shared end time.",
    readWhen: "Changing the call start sequence.",
    links: [{ to: "Y02.X001", rel: "governed-by", note: "the handshake sets the clock" }],
    writtenBy: "ai",
  });
  createBox(root, 1, {
    name: "build-1-0-1",
    summary: "Fixed a drift between the two clocks after reconnecting.",
    readWhen: "Debugging timing after reconnects.",
    links: [
      { to: "Y03.X001", rel: "touches", note: "the handshake now re-runs on reconnect" },
      { to: "Y02.X001", rel: "touches" },
    ],
    drawers: { 4: "## 1.0.1 — Fixed clock drift\n- Re-run the handshake on reconnect.\n" },
    writtenBy: "migrated",
  });
  await reindex(root);
  return root;
}

/** Writes a history row with `n` entries directly to disk (fast), for paging tests. */
export async function bigHistory(n: number): Promise<string> {
  const root = tempProject({});
  await init({ cwd: root, historyUnit: "build" });
  const row = getRow(loadCube(root), 1)!;
  for (let i = 1; i <= n; i++) {
    const name = `build-${i}`;
    const dir = join(row.dir, boxDirName(i, name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "Z0-overview.md"),
      renderDoc(
        {
          id: boxId(1, i),
          name,
          summary: `Build ${i}: changed the thing that build ${i} was about, and fixed a bug found in build ${i - 1}.`,
          read_when: `Debugging anything introduced around build ${i}.`,
          links: [],
          status: "ok",
          written_by: "migrated",
        },
        "",
      ),
    );
    writeFileSync(join(dir, "Z4-detail.md"), `## Build ${i}\n${"- a change\n".repeat(10)}`);
  }
  await reindex(root, { adapters: false });
  return root;
}
