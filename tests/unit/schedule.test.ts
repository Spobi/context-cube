import { describe, expect, it } from "vitest";
import { fmtClock, fmtWait, makeSchedule, parseClock, resetTime, resumeAt, RETRY_MS, type Clock } from "../../src/core/build/schedule";
import { byModel, describeEstimate, estimateBuild, fmtByModel } from "../../src/core/build/sources";
import { cli, tempProject } from "../helpers";

// Local times, so the tests pass in any time zone.
const at = (h: number, m = 0, day = 26) => new Date(2026, 8, day, h, m);
const clockAt = (d: Date): Clock => ({ now: () => d.getTime(), sleep: async () => {} });

describe("start times", () => {
  it("reads 24-hour and am/pm times as the next time the clock shows them", () => {
    const now = at(18, 5);
    expect(parseClock("23:30", now)).toEqual(at(23, 30));
    expect(parseClock("11:30pm", now)).toEqual(at(23, 30));
    expect(parseClock("11:30 p.m.", now)).toEqual(at(23, 30));
    expect(parseClock("11 PM", now)).toEqual(at(23));
    expect(parseClock("2330", now)).toEqual(at(23, 30));
    expect(parseClock("12am", now)).toEqual(at(0, 0, 27));
    // Earlier than now means tomorrow.
    expect(parseClock("7am", now)).toEqual(at(7, 0, 27));
    expect(parseClock("18:05", now)).toEqual(at(18, 5, 27));
  });

  it("rejects what isn't a time", () => {
    const now = at(18);
    for (const t of ["", "tonight", "25:00", "13pm", "11:75", "0am"]) expect(parseClock(t, now)).toBeUndefined();
  });

  it("formats times and waits for people", () => {
    expect(fmtClock(at(23, 30))).toBe("11:30 PM");
    expect(fmtClock(at(0, 5))).toBe("12:05 AM");
    expect(fmtClock(at(1, 0, 27), at(22))).toBe("1:00 AM tomorrow");
    expect(fmtWait(4 * 3600_000 + 10 * 60_000)).toBe("4 h 10 min");
    expect(fmtWait(25 * 60_000)).toBe("25 min");
    expect(fmtWait(2 * 3600_000)).toBe("2 h");
  });
});

describe("usage limit resets", () => {
  it("reads when a limit resets from Claude Code's message", () => {
    const now = at(1, 42, 27);
    expect(resetTime("Claude AI usage limit reached|1790000000", now)).toEqual(new Date(1790000000 * 1000));
    expect(resetTime("5-hour limit reached ∙ resets 4:20am (America/Los_Angeles)", now)).toEqual(at(4, 20, 27));
    expect(resetTime("You've hit your limit · resets at 4am", now)).toEqual(at(4, 0, 27));
    expect(resetTime("Usage limit reached, resets in 2h 15m", now)).toEqual(new Date(now.getTime() + 135 * 60_000));
    expect(resetTime("rate limit: resets in 45 minutes", now)).toEqual(new Date(now.getTime() + 45 * 60_000));
    // A reset time that just passed means now, not tomorrow.
    expect(resetTime("limit reached, resets 1:40am", now)).toEqual(now);
    expect(resetTime("Weekly limit reached, resets Oct 3", now)).toBeUndefined();
    expect(resetTime("API Error: 529 overloaded", now)).toBeUndefined();
  });

  it("waits for the reset only within the window after the chosen start", () => {
    const s = makeSchedule(at(23, 30), clockAt(at(1, 42, 27)));
    expect(s.until).toEqual(at(7, 30, 27));
    expect(resumeAt(s, "limit reached · resets 4:20am")).toEqual({ at: at(4, 21, 27), reset: at(4, 20, 27) });
    // No reset time given: try again in a while.
    expect(resumeAt(s, "API Error: 429 Too Many Requests")!.at).toEqual(new Date(at(1, 42, 27).getTime() + RETRY_MS));
    // A reset after the cut-off: stop instead.
    expect(resumeAt(s, "limit reached · resets 9am")).toBeUndefined();
  });
});

describe("the estimate, by model", () => {
  const root = tempProject({ "HISTORY.md": `# History\n\n${Array.from({ length: 60 }, (_, i) => `## ${i}\nSomething happened.\n`).join("\n")}` });
  const sources = [{ path: "HISTORY.md", role: "history", lines: 180, bytes: 2000 }];

  it("names the model each step runs on, and which steps can start later", () => {
    const est = estimateBuild(root, sources, 10, "balanced");
    expect(est.steps.map((s) => [s.step, s.tier, s.later])).toEqual([
      ["recipe", "sonnet", false],
      ["row structure", "opus", false],
      ["history summaries", "haiku", true],
    ]);
    expect(byModel(est.steps).map((m) => m.tier)).toEqual(["haiku", "sonnet", "opus"]);
    // Headings, when known, count the entries better than line counts do.
    const heads = { path: "HISTORY.md", bytes: 2000, lines: 180, headings: Array.from({ length: 60 }, (_, i) => ({ level: 2, line: 3 + i * 3, text: String(i) })), hints: {} } as any;
    expect(estimateBuild(root, sources, 10, "balanced", [heads]).steps.find((s) => s.step === "history summaries")!.tokens).toBeGreaterThan(est.steps.find((s) => s.step === "history summaries")!.tokens);
    expect(byModel(est.steps).reduce((n, m) => n + m.tokens, 0)).toBe(est.total);
    // The economy preset uses no Opus at all.
    expect(estimateBuild(root, sources, 10, "economy").steps.some((s) => s.tier === "opus")).toBe(false);
  });

  it("says it by model first, then by step", () => {
    const est = estimateBuild(root, sources, 10, "balanced");
    const text = describeEstimate(est).join("\n");
    expect(text).toMatch(/By model:\n {2}Haiku \(smallest\) +~[\d,]+ {2}history summaries\n {2}Sonnet \(mid-size\) +~[\d,]+ {2}recipe\n {2}Opus \(largest\) +~[\d,]+ {2}row structure\n/);
    expect(text).toContain("--preset economy");
    expect(text).toMatch(/ {2}history summaries: ~[\d,]+ on Haiku \(reads each history entry once\)/);
    expect(describeEstimate(estimateBuild(root, sources, 10, "economy")).join("\n")).not.toContain("--preset economy");
    expect(fmtByModel(est.steps.filter((s) => !s.later))).toMatch(/^~[\d,]+ \(Sonnet ~[\d,]+, Opus ~[\d,]+\)$/);
  });
});

describe("the command line", () => {
  it("gives --at, --preset, and --yes after `build` to build, not to setup", () => {
    const r = cli(["build", "--at", "tonight", "--preset", "max", "--yes"], { cwd: tempProject() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`"tonight" isn't a time this understands.`);
  });
});
