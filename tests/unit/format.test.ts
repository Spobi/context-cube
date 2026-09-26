import { describe, expect, it } from "vitest";
import { boxId, formatCoord, idKey, parseId, widthFor } from "../../src/core/format/ids";
import { isValidName, slugify } from "../../src/core/format/names";
import { parseDoc, renderDoc, type Header } from "../../src/core/format/header";
import { joinGenerated, splitGenerated } from "../../src/core/format/generated";
import { findInlineRefs, rewriteInlineRefs } from "../../src/core/format/links";
import { removeBlock, upsertBlock, blockSeparator, extractBlock } from "../../src/core/index/block";

describe("ids", () => {
  it("parses rows, boxes, and drawers", () => {
    expect(parseId("Y05")).toEqual({ row: 5 });
    expect(parseId("Y05.X003")).toEqual({ row: 5, box: 3 });
    expect(parseId("Y05.X003.Z1")).toEqual({ row: 5, box: 3, drawer: 1 });
    expect(parseId("Y5.X003")).toBeUndefined();
    expect(parseId("Y05.X03")).toBeUndefined();
    expect(parseId("§21")).toBeUndefined();
  });
  it("formats with the row's width and compares numerically", () => {
    expect(boxId(5, 3)).toBe("Y05.X003");
    expect(boxId(5, 1000)).toBe("Y05.X1000");
    expect(boxId(5, 3, 4)).toBe("Y05.X0003");
    expect(idKey("Y05.X003")).toBe(idKey("Y05.X0003"));
    expect(formatCoord({ row: 1, box: 71, drawer: 4 })).toBe("Y01.X071.Z4");
    expect(widthFor(999)).toBe(3);
    expect(widthFor(1000)).toBe(4);
  });
});

describe("names", () => {
  it("slugifies to at most five words, dropping filler when long", () => {
    expect(slugify("Take out the resolution lift that never lifted")).toBe("take-out-resolution-lift-that");
    expect(slugify("§2 The 60-second clock")).toBe("s2-the-60-second-clock");
    expect(slugify("Build 1.0.9 (1)")).toBe("build-1-0-9-1");
    expect(slugify("!!!")).toBe("untitled");
  });
  it("validates names", () => {
    expect(isValidName("history")).toBe(true);
    expect(isValidName("take-out-resolution-lift")).toBe(true);
    expect(isValidName("Take-Out")).toBe(false);
    expect(isValidName("a-b-c-d-e-f")).toBe(false);
  });
});

describe("header block", () => {
  const h: Header = {
    id: "Y01.X071",
    name: "take-out-resolution-lift",
    summary: "Deleted resolution recovery: the lift re-sent unchanged parameters.",
    read_when: "Changing video resolution, the bitrate policy, or stats_sample fields.",
    links: [{ to: "Y05.X004", name: "video-quality", rel: "touches", note: "the component this entry changed" }],
    status: "ok",
    source: 'HISTORY.md L331-L352, "## 1.0.8 (6) — Take out the resolution lift"',
    written_by: "ai",
  };
  it("round-trips, keeping the body byte for byte", () => {
    const body = "Line one\n\n  indented: yes\n---\nnot a header\n";
    const text = renderDoc(h, body);
    const doc = parseDoc(text);
    expect(doc.error).toBeUndefined();
    expect(doc.header).toEqual(h);
    expect(doc.body).toBe(body);
    expect(text.startsWith("---\nid: Y01.X071\nname: take-out-resolution-lift\nsummary:")).toBe(true);
  });
  it("reports missing and invalid headers", () => {
    expect(parseDoc("no header").error).toMatch(/missing header/);
    expect(parseDoc("---\nid: [\n---\n").error).toMatch(/not valid YAML/);
    expect(parseDoc("---\nid: Y01.X001\n---\n").error).toMatch(/name/);
    expect(parseDoc("---\nid: Y01.X001\nname: a\nsummary: s\nlinks:\n  - to: Y02.X001\n    rel: likes\n---\n").error).toMatch(/links/);
  });
});

describe("generated sections", () => {
  it("round-trips the drawer's own text exactly", () => {
    for (const own of ["", "abc\n", "abc\n\n", "- one\n- two\n"]) {
      const joined = joinGenerated(own, "- [[Y01.X001]] a");
      const split = splitGenerated(joined);
      expect(split.own).toBe(own);
      expect(split.generated).toBe("- [[Y01.X001]] a");
    }
    expect(joinGenerated("abc\n", undefined)).toBe("abc\n");
  });
});

describe("inline references", () => {
  it("finds and rewrites them, keeping drawer suffixes", () => {
    const text = "See [[Y05.X003]] and [[Y05.X003.Z1]] and [[Y02]], not [[nope]].";
    expect(findInlineRefs(text)).toEqual(["Y05.X003", "Y05.X003.Z1", "Y02"]);
    const out = rewriteInlineRefs(text, (id) => (id.startsWith("Y05.X003") ? id.replace("Y05.X003", "Y07.X001") : undefined));
    expect(out).toBe("See [[Y07.X001]] and [[Y07.X001.Z1]] and [[Y02]], not [[nope]].");
  });
});

describe("always-loaded block", () => {
  const cases = ["", "# Title\n", "# Title\n\nNotes.", "# Title\n\n", "no newline"];
  it("preserves everything outside its markers, and removal restores the file", () => {
    for (const original of cases) {
      const sep = blockSeparator(original);
      const once = upsertBlock(original, "## Memory\n- one");
      expect(once.startsWith(original)).toBe(true);
      const twice = upsertBlock(once, "## Memory\n- two\n- three");
      expect(extractBlock(twice)).toBe("## Memory\n- two\n- three");
      expect(twice.startsWith(original)).toBe(true);
      expect(removeBlock(twice, sep)).toBe(original);
    }
  });
  it("replaces a block in the middle of a file without touching either side", () => {
    const before = "# Top\n\n<!-- context-cube:start -->\nold\n<!-- context-cube:end -->\n\n## Bottom\nkeep me\n";
    const after = upsertBlock(before, "new");
    expect(after).toBe("# Top\n\n<!-- context-cube:start -->\nnew\n<!-- context-cube:end -->\n\n## Bottom\nkeep me\n");
  });
});
