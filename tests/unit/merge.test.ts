import { describe, expect, it } from "vitest";
import { mergeJson } from "../../src/core/merge";

describe("merging per-box state", () => {
  const base = { id: "Y03.X001", updated: "t0", approvedZ1: "aaa", code: { files: ["a.ts"], commits: [] }, names: ["x"] };

  it("keeps what only one side changed, from either side", () => {
    const alice = { ...base, updated: "t1", approvedZ1: "bbb", replaced: { Z4: { at: "t1", sha: "ccc" } } };
    const bob = { ...base, updated: "t2", code: { files: ["a.ts", "b.ts"], commits: [] } };
    expect(mergeJson(base, alice, bob, true)).toEqual({
      id: "Y03.X001",
      updated: "t2",
      approvedZ1: "bbb",
      code: { files: ["a.ts", "b.ts"], commits: [] },
      names: ["x"],
      replaced: { Z4: { at: "t1", sha: "ccc" } },
    });
  });

  it("merges nested objects the same way, and lets the newer side win where both changed a field", () => {
    const alice = { ...base, names: ["x", "y"], code: { files: ["a.ts"], commits: ["c1"] } };
    const bob = { ...base, names: ["z"], code: { files: ["b.ts"], commits: [] } };
    // Inside code, Bob changed only files and Alice only commits: both kept, whichever side is newer.
    expect(mergeJson(base, alice, bob, false)).toMatchObject({ names: ["x", "y"], code: { files: ["b.ts"], commits: ["c1"] } });
    expect(mergeJson(base, alice, bob, true)).toMatchObject({ names: ["z"], code: { files: ["b.ts"], commits: ["c1"] } });
  });

  it("drops a field one side removed and the other left alone", () => {
    const alice = { ...base } as Record<string, unknown>;
    delete alice.approvedZ1;
    expect(mergeJson(base, alice, { ...base, updated: "t2" }, true)).not.toHaveProperty("approvedZ1");
  });
});
