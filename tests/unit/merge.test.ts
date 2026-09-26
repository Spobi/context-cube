import { describe, expect, it } from "vitest";
import { mergeAdditions, mergeJson } from "../../src/core/merge";

describe("merging per-box state", () => {
  const base = { id: "Y03.X001", updated: "t0", approvedZ1: "aaa", code: { files: ["a.ts"], commits: [] }, names: ["x"] };

  it("keeps what only one side changed, from either side", () => {
    const alice = { ...base, updated: "t1", approvedZ1: "bbb", records: { Z4: { sha: "ccc", chars: 10, at: "t1", replaced: true } } };
    const bob = { ...base, updated: "t2", code: { files: ["a.ts", "b.ts"], commits: [] } };
    expect(mergeJson(base, alice, bob, true)).toEqual({
      id: "Y03.X001",
      updated: "t2",
      approvedZ1: "bbb",
      code: { files: ["a.ts", "b.ts"], commits: [] },
      names: ["x"],
      records: { Z4: { sha: "ccc", chars: 10, at: "t1", replaced: true } },
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

  it("takes a record's mark whole from one side, never mixing two sides' checksum and length", () => {
    const withMark = { ...base, records: { Z4: { sha: "s0", chars: 10, at: "t0" }, Z3: { sha: "z3", chars: 4, at: "t0" } } };
    // Alice replaced the text with one of the same length; Bob's replacement has another length.
    const alice = { ...withMark, records: { ...withMark.records, Z4: { sha: "sA", chars: 10, at: "t1", replaced: true } } };
    const bob = { ...withMark, records: { ...withMark.records, Z4: { sha: "sB", chars: 12, at: "t2", replaced: true } } };
    expect((mergeJson(withMark, alice, bob, true).records as any).Z4).toEqual(bob.records.Z4);
    expect((mergeJson(withMark, alice, bob, false).records as any).Z4).toEqual(alice.records.Z4);
    // Drawers still merge one by one: a mark only one side added is kept.
    const carol = { ...withMark, records: { ...withMark.records, Z1: { sha: "z1", chars: 2, at: "t3" } } };
    expect(Object.keys(mergeJson(withMark, alice, carol, true).records as object).sort()).toEqual(["Z1", "Z3", "Z4"]);
  });
});

describe("merging a drawer a side only added to", () => {
  const base = "Tried a worker thread.\n";
  const note = (d: string, t: string) => `\n**Added ${d}:**\n${t}\n`;

  it("keeps both additions, ours first, and each note its own paragraph", () => {
    expect(mergeAdditions(base, base + note("2026-09-01", "A"), base + note("2026-09-02", "B"))).toBe(`${base}${note("2026-09-01", "A")}${note("2026-09-02", "B")}`);
    const para = "Text.\n\n";
    expect(mergeAdditions(para, `${para}**Added 2026-09-01:**\nA\n`, `${para}**Added 2026-09-02:**\nB\n`)).toBe("Text.\n\n**Added 2026-09-01:**\nA\n\n**Added 2026-09-02:**\nB\n");
    expect(mergeAdditions("- a\n", "- a\n- b\n", "- a\n- c\n")).toBe("- a\n- b\n- c\n");
  });

  it("puts one side's addition after the other side's edit, even right next to it", () => {
    const edited = "Tried a worker thread (and a timer).\n";
    expect(mergeAdditions(base, edited, base + note("2026-09-02", "B"))).toBe(edited + note("2026-09-02", "B"));
    expect(mergeAdditions(base, base + note("2026-09-01", "A"), edited)).toBe(edited + note("2026-09-01", "A"));
  });

  it("leaves the rest to git, and never doubles an addition", () => {
    expect(mergeAdditions(base, "Tried a thread.\n", "Tried threads.\n")).toBeUndefined();
    expect(mergeAdditions(base, base, base + "B\n")).toBeUndefined();
    expect(mergeAdditions(base, base + "B\n", base + "B\n")).toBe(base + "B\n");
    expect(mergeAdditions(base, base + "B\n", base + "B\nC\n")).toBe(base + "B\nC\n");
  });
});
