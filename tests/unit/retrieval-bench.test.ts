import { describe, expect, it } from "vitest";
import { measureRetrieval, type Required } from "../../src/bench/retrieval";
import type { ReadRecord } from "../../src/core/logs/extract";

const req: Required[] = [
  { id: "Y02.X003", cube: [{ file: "context-cube/Y02-invariants/X003-tombstones/Z1-invariants.md", start: 1, end: 10 }], files: [{ file: "INVARIANTS.md", start: 101, end: 120 }] },
];
const at = (m: number) => `2099-01-01T10:${String(m).padStart(2, "0")}:00.000Z`;
const read = (m: number, file: string, ranges?: [number, number][], tokens = 100): ReadRecord => ({ t: at(m), session: "s", tool: "Read", file, ranges, chars: tokens * 4, tokens });

describe("bench retrieval measures", () => {
  it("finds an invariant in the files copy once half its lines were shown, before the first edit", () => {
    const reads = [
      read(1, "src/a.ts", [[1, 50]]),
      read(2, "INVARIANTS.md", [[1, 100]], 2000), // the top of the file: not the invariant
      read(3, "INVARIANTS.md", [[100, 112]], 300), // 12 of its 20 lines
      read(9, "src/b.ts", [[1, 10]]),
    ];
    const r = measureRetrieval("files", req, reads, [{ t: at(5), session: "s", tool: "Edit", file: "src/a.ts" }], ["INVARIANTS.md"]);
    expect(r).toEqual({ required: 1, found: 1, readsToFind: 3, readsBeforeEdit: 3, memoryBeforeEdit: 2300 });
  });

  it("doesn't count what was read only after the first edit", () => {
    const reads = [read(1, "src/a.ts", [[1, 5]]), read(6, "context-cube/Y02-invariants/X003-tombstones/Z1-invariants.md", [[1, 10]], 80)];
    const r = measureRetrieval("cube", req, reads, [{ t: at(5), session: "s", tool: "Edit", file: "src/a.ts" }], []);
    expect(r).toEqual({ required: 1, found: 0, readsToFind: undefined, readsBeforeEdit: 1, memoryBeforeEdit: 0 });
  });

  it("counts cube reads as memory in the cube copy", () => {
    const reads = [read(1, "context-cube/Y02-invariants/ROW.md", [[1, 40]], 400), read(2, "context-cube/Y02-invariants/X003-tombstones/Z1-invariants.md", [[1, 10]], 80)];
    const r = measureRetrieval("cube", req, reads, [], []);
    expect(r).toEqual({ required: 1, found: 1, readsToFind: 2, readsBeforeEdit: 2, memoryBeforeEdit: 480 });
  });
});
