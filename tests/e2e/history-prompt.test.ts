import { describe, expect, it } from "vitest";
import { runStep } from "../../src/ai/runner";
import { historyStep } from "../../src/ai/schemas/enrich";
import { recordedBackend, tempProject } from "../helpers";

// One history-summaries call, recorded live once and replayed after: summaries say only
// what an entry says and keep why something failed, while links still cover what it relied on.

describe("history summaries (recorded)", () => {
  it("keep a failed attempt and its reason, don't add reasons an entry doesn't give, and still link what an entry relied on", async () => {
    const root = tempProject({});
    const input = {
      targets: [
        { id: "Y02.X001", line: "Y02.X001 audio-session-main-thread (invariant): the audio session is only started, stopped, or reconfigured on the main thread" },
        { id: "Y03", line: "Y03 audio: the audio engine, its threads and buffers" },
        { id: "Y04", line: "Y04 settings: the settings screen" },
      ],
      items: [
        {
          id: "Y01.X001",
          title: "2025-03-02 — Audio worker thread",
          text: "### 2025-03-02 — Audio worker thread\nMoved audio decoding to a worker thread. Reverted two days later: it deadlocked the audio session whenever a call came in. Don't try this again without a lock-free queue.\n",
        },
        { id: "Y01.X002", title: "2025-04-10", text: "### 2025-04-10\nThe settings screen now has a dark mode toggle.\n" },
        {
          id: "Y01.X003",
          title: "2025-05-01 — Smaller buffers",
          text: "### 2025-05-01 — Smaller buffers\nCut the audio buffer from 40 ms to 20 ms because people heard a delay on calls.\n",
        },
      ],
    };
    const r = await runStep(historyStep, input, { root, backend: recordedBackend(), preset: "balanced" });
    const summary = (id: string) => r.output.entries.find((e) => e.id === id)!.summary;
    expect(summary("Y01.X001")).toMatch(/revert/i);
    expect(summary("Y01.X001")).toMatch(/deadlock/i);
    expect(summary("Y01.X002")).not.toMatch(/because|so that|in order to|to (improve|help|make|let|allow|give|reduce|support)|for (better|easier|users)/i);
    expect(summary("Y01.X003")).toMatch(/delay/i);
    // The reverted change broke an invariant it doesn't name; the link is routing, so it's still made.
    expect(r.output.entries.find((e) => e.id === "Y01.X001")!.touches.map((t) => t.to)).toContain("Y02.X001");
  });
});
