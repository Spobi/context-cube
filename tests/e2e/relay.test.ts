import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../../src/setup/setup";
import { build, buildStatus } from "../../src/commands/build";
import { NeedsAnswer, needsAnswerMessage, parseAnswers, relayAsker } from "../../src/setup/ask";
import { runChecks } from "../../src/core/check/check";
import { loadState } from "../../src/core/build/pipeline";
import { findClaude } from "../../src/adapters/claude-code/bin";
import { claudeDialect } from "../../src/adapters/claude-code/index";
import { FakeBackend, type AIBackend } from "../../src/ai/backends";
import { answer } from "../fixtures/scripted";
import { loadCube } from "../../src/core/cube";
import { commitAll, recordedBackend, tempProject } from "../helpers";
import * as fx from "../fixtures/projects";

// A stand-in for `claude auth status`, so tests never touch the real login.
let fakeClaude = "";
beforeAll(() => {
  const dir = tempProject({}, { git: false });
  fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh\necho '{"loggedIn":true,"subscriptionType":"pro"}'\n`);
  chmodSync(fakeClaude, 0o755);
  process.env.CUBE_CLAUDE_BIN = fakeClaude;
});
afterAll(() => {
  delete process.env.CUBE_CLAUDE_BIN;
});

/** Counts the AI calls made, so a test can see that nothing was spent before the person said yes. */
function counting(inner: AIBackend): AIBackend & { calls: number } {
  const b = { calls: 0, run: (c: Parameters<AIBackend["run"]>[0]) => (b.calls++, inner.run(c)) };
  return b;
}

const keyOf = (out: string[]) => /--answer ([^=\s]+)=/.exec(out.join("\n"))?.[1];

describe("questions without a terminal", () => {
  it("stops at a keyed question and names how to answer; takes defaults for the rest", async () => {
    const log: string[] = [];
    const ask = relayAsker({ rows: "redo" }, log);
    expect(await ask.confirm("Log reads?", true)).toBe(true);
    expect(log).toContain("Log reads? yes (default)");
    await expect(ask.confirm("Go ahead?", true, "go-ahead")).rejects.toBeInstanceOf(NeedsAnswer);
    expect(await ask.choose("Accept these rows?", ["accept", "redo", "edit"], "accept", "rows")).toBe("redo");
    // Each answer is used once: asked again (after a redo), it stops for a new one.
    const again = await ask.choose("Accept these rows?", ["accept", "redo", "edit"], "accept", "rows").catch((e) => e);
    expect(again).toBeInstanceOf(NeedsAnswer);
    const msg = needsAnswerMessage(again).join("\n");
    expect(msg).toContain("  Accept these rows? (accept / redo / edit)");
    expect(msg).toContain("Don't answer it for them.");
    expect(msg).toContain("--answer rows=<their answer>");
    const bad = await relayAsker({ "go-ahead": "maybe" }).confirm("Go ahead?", true, "go-ahead").catch((e) => e);
    expect(needsAnswerMessage(bad).join("\n")).toContain(`("maybe" isn't yes or no)`);
    expect(parseAnswers(["spot-check=", "use:docs/a.md=yes", "rows-feedback=split sync=engine"])).toEqual({ "spot-check": "", "use:docs/a.md": "yes", "rows-feedback": "split sync=engine" });
  });

  it("in Claude Code, puts each question in its question box, with what each answer means", async () => {
    /** The question a run stops at. */
    const stop = (f: (a: ReturnType<typeof relayAsker>) => Promise<unknown>): Promise<NeedsAnswer> =>
      f(relayAsker({})).then(
        () => Promise.reject(new Error("it didn't stop")),
        (e) => e as NeedsAnswer,
      );
    const box = (msg: string[]) => JSON.parse(msg[msg.indexOf("AskUserQuestion input:") + 1]).questions[0];
    const labels = (msg: string[]) => box(msg).options.map((o: { label: string }) => o.label);

    const rows = needsAnswerMessage(await stop((a) => a.choose("Accept these rows?", ["accept", "redo", "edit"], "accept", "rows")), undefined, true);
    expect(box(rows)).toMatchObject({ question: "Accept these rows?", header: "Rows", multiSelect: false });
    expect(labels(rows)).toEqual(["Accept", "Redo", "Edit the file"]);
    expect(rows).toContain('  "Redo" → --answer rows=redo');
    expect(rows).toContain("  Something they typed instead (Other) → the answer it means: accept, redo, edit");
    expect(rows.join("\n")).toContain("Ask the person with your AskUserQuestion tool");

    // The tool's advice goes first, marked the way the box expects; a copied label still counts.
    const rewrite = needsAnswerMessage(await stop((a) => a.confirm("Rewrite them?", true, "rewrite-rules")), undefined, true);
    expect(labels(rewrite)).toEqual(["Rewrite them (Recommended)", "Leave them"]);
    expect(rewrite).toContain('  "Rewrite them (Recommended)" → --answer rewrite-rules=yes');
    expect(await relayAsker({ "rewrite-rules": "Yes (Recommended)" }).confirm("Rewrite them?", true, "rewrite-rules")).toBe(true);

    // A question offers only the answers its kind allows, and never recommends spending.
    expect(labels(needsAnswerMessage(await stop((a) => a.choose("Go ahead?", ["now", "later", "no"], "now", "go-ahead")), undefined, true))).toEqual(["Now", "Later", "Stop"]);
    expect(labels(needsAnswerMessage(await stop((a) => a.confirm("Go ahead?", true, "go-ahead")), undefined, true))).toEqual(["Go ahead", "Stop"]);
    expect(box(needsAnswerMessage(await stop((a) => a.confirm("  Use docs/a.md?", true, "use:docs/a.md")), undefined, true))).toMatchObject({ question: "Use docs/a.md?", header: "Use file" });

    // A typed answer: suggestions to pick, or details asked for first; with nothing to pick, it's asked in the chat.
    const spot = needsAnswerMessage(await stop((a) => a.text("Type the ids of any that look wrong:", "", "spot-check")), undefined, true);
    expect(spot).toContain('  "All look right" → --answer spot-check=');
    expect(spot).toContain('  "Some look wrong" → ask which ids look wrong, then --answer spot-check="<the ids, separated by spaces>"');
    const at = needsAnswerMessage(await stop((a) => a.text("Start the rest at what time?", "", "start-at")), undefined, true);
    expect(at).toContain('  "11:30pm" → --answer start-at=11:30pm');
    const open = needsAnswerMessage(await stop((a) => a.text("Anything else?", "", "notes")), undefined, true);
    expect(open.join("\n")).not.toContain("AskUserQuestion");
    expect(open).toContain("Then run the same command again, adding: --answer notes=<their answer> (quote it if it has spaces; for no answer: --answer notes=)");
  });

  it("runs the whole setup one answer at a time, the long part in the background, and spends nothing before a yes", async () => {
    const root = tempProject(fx.constitutionNotes);
    commitAll(root, "init");
    const backend = counting(recordedBackend());
    const started: string[][] = [];
    const startBackground = (_root: string, args: string[]) => (started.push(args), process.pid);
    const answers: Record<string, string> = { "read-sample": "yes", "use-files": "yes", "go-ahead": "now", "rules-as-notes": "yes", rows: "accept", "spot-check": "", "rewrite-rules": "yes" };
    const run = (given: Record<string, string>) => setup({ cwd: root, ask: relayAsker(given, []), backend, startBackground });

    // The first run stops before any AI use.
    let out = await run({});
    expect(keyOf(out)).toBe("read-sample");
    expect(out.join("\n")).toContain("WAITING FOR THE PERSON'S ANSWER");
    expect(backend.calls).toBe(0);
    expect(loadState(root).waitingFor).toMatchObject({ key: "read-sample" });

    const asked: string[] = ["read-sample"];
    let backgroundRuns = 0;
    for (let i = 0; i < 30; i++) {
      const key = keyOf(out);
      if (key) {
        expect(answers).toHaveProperty(key);
        out = await run({ [key]: answers[key] });
        asked.push(keyOf(out) ?? "");
        continue;
      }
      if (out.join("\n").includes("carries on in the background")) {
        // What the background process does: the long stages, until the next question.
        backgroundRuns++;
        const child = await build({ cwd: root, ask: relayAsker({}, []), backend, backgroundChild: true });
        const status = buildStatus({ cwd: root }).join("\n");
        const waiting = keyOf(child);
        if (waiting) {
          asked.push(waiting);
          expect(status).toContain(`--answer ${waiting}=<their answer>`);
        }
        out = waiting ? child : await run({});
        continue;
      }
      break;
    }
    const text = out.join("\n");
    expect(text).toContain("All set.");
    expect(started.length).toBe(backgroundRuns);
    expect(backgroundRuns).toBeGreaterThanOrEqual(2);
    expect(started[0]).toEqual(["build", "--background-child"]);
    // The questions came in order: the go-ahead before any big step, the rows before the long part.
    const order = asked.filter(Boolean).filter((k, i, a) => a.indexOf(k) === i);
    expect(order.slice(0, 3)).toEqual(["read-sample", "use-files", "go-ahead"]);
    expect(order.indexOf("rows")).toBeGreaterThan(2);
    expect(order.indexOf("spot-check")).toBeGreaterThan(order.indexOf("rows"));
    // The relayed yes counts as the person's: the rules were rewritten, and the originals archived.
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).not.toContain("- Y00.X003 Read CONSTITUTION.md before touching the sync engine.");
    expect(readFileSync(join(root, "context-cube/.state/archive/CONSTITUTION.md"), "utf8")).toBe(fx.constitutionNotes["CONSTITUTION.md"]);
    expect((await runChecks(root)).filter((i) => i.level === "error")).toEqual([]);
    expect(loadState(root).setupDone).toBe(true);
    // Running it again now offers an update, not a rebuild.
    expect((await run({})).join("\n")).toMatch(/^Updated: \d+ rows/m);
  });
});

describe("a background build that drafts the first rules", () => {
  it("asks before adding them, and doesn't draft them twice", async () => {
    const root = tempProject(fx.codeOnly);
    commitAll(root, "init");
    const backend = new FakeBackend((c) => {
      if (c.step === "interview-rules") return { rules: [{ name: "run-tests", text: "Run `npm test` before every commit." }], historyUnit: "commit" };
      if (c.step === "candidate-invariants") return { candidates: [] };
      return answer(c);
    });
    const startBackground = () => process.pid;
    const fg = (given: Record<string, string>) => build({ cwd: root, ask: relayAsker(given, []), backend, startBackground });
    const bg = () => build({ cwd: root, ask: relayAsker({}, []), backend, backgroundChild: true });
    let out = await fg({});
    // No memory files: nothing to read, so the first question is the go-ahead.
    expect(keyOf(out)).toBe("go-ahead");
    out = await fg({ "go-ahead": "now" });
    expect(out.join("\n")).toContain("carries on in the background");
    out = await bg();
    if (keyOf(out) === "rows") {
      await fg({ rows: "accept" });
      out = await bg();
    }
    expect(keyOf(out)).toBe("add-rules");
    expect(out.join("\n")).toContain("run the build command (node context-cube/.tool/cube.mjs build) again");
    const drafts = backend.calls.filter((c) => c.step === "interview-rules").length;
    expect(drafts).toBe(1);
    out = await fg({ "add-rules": "no" });
    expect(out.join("\n")).toContain("carries on in the background");
    out = await bg();
    expect(backend.calls.filter((c) => c.step === "interview-rules").length).toBe(drafts);
    expect(loadCube(root).rows.find((r) => r.type === "rules")!.boxes).toHaveLength(0);
  });
});

describe("finding Claude Code", () => {
  it("looks in CUBE_CLAUDE_BIN, the PATH, the program running this session, then the desktop app", () => {
    const dir = tempProject({ "bin/claude": "#!/bin/sh\n", "session/claude": "#!/bin/sh\n" }, { git: false });
    expect(findClaude({ CUBE_CLAUDE_BIN: "/x/claude", PATH: join(dir, "bin") })).toEqual({ path: "/x/claude", from: "env" });
    expect(findClaude({ PATH: join(dir, "bin"), CLAUDE_CODE_EXECPATH: join(dir, "session/claude") })).toEqual({ path: join(dir, "bin/claude"), from: "path" });
    expect(findClaude({ PATH: "/nowhere", CLAUDE_CODE_EXECPATH: join(dir, "session/claude") })).toEqual({ path: join(dir, "session/claude"), from: "session" });
    expect(findClaude({ PATH: "/nowhere" })).toBeUndefined();
  });

  it("tells a desktop app session to use the app's terminal, not Claude Code's `!`", () => {
    const before = process.env.CLAUDE_CODE_ENTRYPOINT;
    try {
      process.env.CLAUDE_CODE_ENTRYPOINT = "claude-desktop";
      expect(claudeDialect.personRuns("cube approve P-1")).toContain("the desktop app has one: the Views menu, or Ctrl+`");
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      expect(claudeDialect.personRuns("cube approve P-1")).toContain("they can type: ! cube approve P-1");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = before;
    }
  });
});
