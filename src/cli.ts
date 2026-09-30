import { Command, Option } from "commander";
import { olderThanProject, version } from "./core/tool";
import { hookCommand, readStdin } from "./commands/hook";
import { logInstall, logReport, logUninstall } from "./commands/log";
import * as core from "./commands/core";
import { aiTest, statsAi } from "./commands/ai";
import { build, buildStatus, recipeCheck } from "./commands/build";
import { links, ok, status } from "./commands/code";
import "./hooks/handlers";
import * as living from "./commands/living";
import { setup } from "./setup/setup";
import * as bench from "./commands/bench";
import { archiveCmd, restoreCmd } from "./commands/archive";
import { mergeFile } from "./core/merge";

function run(fn: (...args: any[]) => unknown | Promise<unknown>) {
  return async (...args: any[]) => {
    try {
      const older = olderThanProject(process.cwd());
      if (older) throw new Error(older);
      const out = await fn(...args);
      if (Array.isArray(out)) console.log(out.join("\n"));
      else if (typeof out === "string") console.log(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`cube: ${msg}`);
      if (process.env.CUBE_DEBUG && err instanceof Error) console.error(err.stack);
      process.exitCode = 1;
    }
  };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

async function stdinIfNeeded(opts: Record<string, unknown>): Promise<string | undefined> {
  return Object.values(opts).includes("-") ? readStdin() : undefined;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cube")
    .description("Context Cube: a structured project memory that AI coding agents read top-down.")
    .version(version(), "-v, --version")
    .showHelpAfterError()
    // Setup's options (--yes, --preset, --at) belong to the command they follow;
    // without this, `cube build --preset max` gave them to setup instead.
    .enablePositionalOptions();

  // ---------- setup (the default: `npx context-cube`) ----------
  const setupOpts = (c: Command) =>
    c
      .option("-y, --yes", "accept every default without asking (including the offer to rewrite rules that point at your original files)")
      .option("--preset <preset>", "economy, balanced (default), or max: how capable a model each AI step uses")
      .option("--at <time>", "start the big part of the build (after you review the rows) at this time, like 23:30 or 11:30pm, say after your plan's usage resets; the terminal waits until then")
      .option("--shared", "put the cube's hooks in the shared, committed .claude/settings.json (the default for a new cube)")
      .option("--personal", "put the cube's hooks in your personal .claude/settings.local.json instead, so teammates don't get them")
      .option("--without-logger", "don't log what the agent reads")
      .option("--answer <key=answer>", "the person's answer to a question it stopped at, when running without a terminal (repeatable)", collect);
  const runSetup = run((opts) => setup({ ...opts, shared: opts.personal ? false : opts.shared ? true : undefined, logger: opts.withoutLogger ? false : undefined }));
  setupOpts(program.command("setup").description("Guided setup: build a cube from what exists, or start a fresh one. The same as running with no command.")).action(runSetup);
  setupOpts(program).action(runSetup);

  // ---------- the cube ----------
  program
    .command("init")
    .description("Create an empty cube: the rules, history, and invariants rows.")
    .option("--agent <id>", "agent to set the cube up for: claude-code, codex, or generic (a plain AGENTS.md block) (repeatable)", collect)
    .option("--history-unit <unit>", "one history entry per: build, release, pr, day, commit, session")
    .action(run((opts) => core.init({ agents: opts.agent, historyUnit: opts.historyUnit })));

  program
    .command("new-row <name>")
    .description("Create a row. The tool picks its number.")
    .requiredOption("--type <type>", "rules, history, invariants, feature, system, catalog, custom")
    .requiredOption("--summary <text>", "what this row is, in one line")
    .requiredOption("--read-when <text>", "when an agent should open this row")
    .option("--convention <text>", "a row-wide convention (repeatable)", collect)
    .option("--body <text>", "root overview text; @file reads a file, - reads stdin")
    .action(run(async (name, opts) => core.newRow(name, { ...opts, body: core.readBody(opts.body, await stdinIfNeeded(opts)) })));

  program
    .command("new-box <row> <name>")
    .description("Create a box in a row. The tool picks its number.")
    .requiredOption("--summary <text>", "what this box is, in one line")
    .option("--read-when <text>", "when an agent should open this box (required by cube check)")
    .option("--body <text>", "Z0 overview text; @file reads a file, - reads stdin")
    .option("--z1 <text>", "Z1 invariants text (@file, -)")
    .option("--z2 <text>", "Z2 code text (@file, -)")
    .option("--z3 <text>", "Z3 history text (@file, -)")
    .option("--z4 <text>", "Z4 detail text (@file, -)")
    .option("--link <spec>", "Y02.X007[:rel[:note]] (repeatable); rel is touches, governed-by, implements, see-also", collect)
    .option("--source <text>", "where the content came from")
    .option("--written-by <who>", "ai, person, or migrated", "person")
    .option("--reason <text>", "for the invariants row: why (goes in the approvals log)")
    .action(run(async (row, name, opts) => core.newBox(row, name, opts, await stdinIfNeeded(opts))));

  program
    .command("link <from> <to>")
    .description("Add a header link from one box to another box or row.")
    .option("--rel <rel>", "touches, governed-by, implements, see-also", "see-also")
    .requiredOption("--note <text>", "why an agent would follow this link")
    .action(run((from, to, opts) => core.link(from, to, opts)));

  program
    .command("unlink <from> <to>")
    .description("Remove header links from one box to another.")
    .option("--rel <rel>", "only links of this type")
    .action(run((from, to, opts) => core.unlink(from, to, opts)));

  program
    .command("move <box> <row>")
    .description("Move a box to a row (or renumber it in its own row). Links are rewritten and an alias recorded.")
    .option("--read-when <text>", "a new read-when line (needed when a rule, read \"Always.\", leaves the rules row)")
    .action(run((box, row, opts) => core.move(box, row, opts)));

  program
    .command("rename <id> <name>")
    .description("Rename a row or box. Its coordinate doesn't change.")
    .action(run((id, name, opts) => core.rename(id, name, opts)));

  program
    .command("delete <box>")
    .description("Delete a box. Its number is retired and never reused. A box that holds a record needs a person and a reason.")
    .option("--reason <text>", "why (required for a box that holds a record; goes in the approvals log)")
    .action(run((box, opts) => core.remove(box, opts)));

  program
    .command("index")
    .description("Rebuild CUBE.md, the row indexes, backlinks, and the always-loaded block.")
    .action(run((opts) => core.index(opts)));

  program
    .command("check")
    .description("Validate the cube.")
    .option("--fix", "fix what can be fixed automatically (duplicate numbers after a merge)")
    .option("--invariants", "only check that invariant text matches what was approved (used by the pre-commit check)")
    .option("--json", "print issues as JSON")
    .action(
      run(async (opts) => {
        const r = await core.check(opts);
        if (r.errors) process.exitCode = 1;
        return r.text;
      }),
    );

  program
    .command("related <path-or-name>")
    .description("What the cube holds about a file, folder, or code name: invariants to read first, boxes, history, rules. No AI.")
    .option("--json", "print as JSON")
    .action(run((q, opts) => core.relatedCmd(q, opts)));

  program
    .command("find <words...>")
    .description("Search the cube's text: boxes containing every word, most mentions first.")
    .option("--json", "print as JSON")
    .action(run((words, opts) => core.findCmd(words, opts)));

  program
    .command("resolve <ref>")
    .description('Find a coordinate: an id, a legacy reference like "§21", or a name.')
    .action(run((ref, opts) => core.resolve(ref, opts)));

  // ---------- original files ----------
  program
    .command("archive [files...]")
    .description("Move original files the cube was built from into its archive (context-cube/.state/archive/), leaving a short placeholder. With no files: every one not archived yet.")
    .option("--force", "archive even if the cube no longer holds the file's current text word for word")
    .action(run((files, opts) => archiveCmd(files, opts)));
  program
    .command("restore [files...]")
    .description("Put archived original files back where they were (a person does this).")
    .option("--all", "every archived file")
    .option("--to <folder>", "copy them into this folder instead, leaving the archive as it is")
    .action(run((files, opts) => restoreCmd(files, opts)));

  // ---------- keeping the cube current ----------
  const history = program.command("history").description("The open history entry and its fragments.");
  history
    .command("add [text]")
    .description("Add a note to the open history entry (opens one if none is open). Text, @file, or - for stdin.")
    .option("--key <key>", 'the build, release, or date this is for (e.g. "1.0.9 (2)"); a new key closes the open entry and starts another')
    .option("--touches <ids>", "boxes this change touched, comma-separated")
    .option("--by <name>", "who wrote it (default: your git name)")
    .action(run(async (text, opts) => living.historyAdd(text, opts, text === undefined || text === "-" ? await readStdin() : undefined)));
  history
    .command("open")
    .description("Open a new history entry.")
    .option("--key <key>", "the build, release, or date it's for")
    .option("--name <name>", "a short name")
    .action(run((opts) => living.historyOpen(opts)));
  history
    .command("close")
    .description("Close the open entry: its fragments become its Z4, and it gets a summary.")
    .option("--summary <text>", "one-line summary")
    .option("--read-when <text>", "when to open it")
    .option("--name <name>", "a short name")
    .action(run((opts) => living.historyClose(opts)));
  history
    .command("show")
    .description("Show the open entry and its fragments.")
    .action(run((opts) => living.historyShow(opts)));

  program
    .command("write <id> <drawer> [text]")
    .description("Write a drawer's text (Z0 body, Z3, Z4; Z1 outside the invariants row). Text, @file, or - for stdin. Records (text moved from the original files, closed history entries) are added to with --append, never rewritten.")
    .option("--append", "add the text below what's there, under a dated label")
    .action(run(async (id, drawer, text, opts) => living.write(id, drawer, text, opts, text === undefined || text === "-" ? await readStdin() : undefined)));

  program
    .command("replace <id> <drawer> [text]")
    .description("For a person: replace a record's text on purpose (text, @file, or - for stdin). With no text, records the drawer's current text as a change made on purpose. Logged in the approvals log.")
    .option("--reason <text>", "why (required; goes in the approvals log)")
    .action(run(async (id, drawer, text, opts) => living.replace(id, drawer, text, opts, text === "-" ? await readStdin() : undefined)));

  program
    .command("edit <id>")
    .description("Change a box's header lines.")
    .option("--summary <text>", "one-line summary")
    .option("--read-when <text>", "when to open it")
    .option("--scope <text>", "what it covers")
    .option("--status <status>", "ok, stale, or needs-review (to mark a box replaced by a later decision, use supersede)")
    .option("--paths <globs>", 'rules only: comma-separated file globs (e.g. "src/ui/**"); the rule then loads with those files, not every session. "" undoes it')
    .action(run((id, opts) => living.edit(id, opts)));

  program
    .command("supersede <id>")
    .description("Mark a note, plan, or review as replaced by a later decision. Its text stays; a dated note says what's true now.")
    .option("--by <id>", "the history entry or box that replaced it")
    .option("--note <text>", "what's true now, in a sentence")
    .option("--undo", "mark it current again")
    .action(run((id, opts) => living.supersede(id, opts)));

  program
    .command("propose <kind> <target>")
    .description("Propose an invariant change: propose edit <id>, propose delete <id>, or propose new <name>. A person approves it.")
    .option("--text <text>", "the new Z1 text: @file, - for stdin, or text")
    .option("--reason <text>", "why (required; goes in the approvals log)")
    .option("--summary <text>", "for new: one-line label")
    .option("--read-when <text>", "for new: which changes must read it first")
    .action(run(async (kind, target, opts) => living.propose(kind, target, opts, opts.text === "-" ? await readStdin() : undefined)));
  program
    .command("pending")
    .description("List invariant changes waiting for approval (weakenings and deletions first).")
    .action(run((opts) => living.pending(opts)));
  program
    .command("approve <id>")
    .description("Approve a pending invariant change (a person does this).")
    .option("--reason <text>", "a note for the log")
    .action(run((id, opts) => living.approveCmd(id, opts)));
  program
    .command("reject <id>")
    .description("Reject a pending invariant change.")
    .requiredOption("--reason <text>", "why")
    .action(run((id, opts) => living.rejectCmd(id, opts)));

  program
    .command("update-plan")
    .description("Show what to update in the cube after a change: linked boxes, the open entry, and the commands.")
    .option("--commit <ref>", "a commit (default: the last one)")
    .option("--agent <id>", "word the plan for this agent (claude-code, codex)")
    .action(run((opts) => living.planCmd(opts)));

  program
    .command("install")
    .description("Install the cube into the agent: always-loaded block, path rules, hooks, permission rules, updater helper, pre-commit check.")
    .option("--shared", "put hooks in the shared, committed settings (.claude/settings.json; for Codex, .codex/hooks.json)")
    .option("--agent <id>", "also set the cube up for this agent: codex, claude-code, or generic (a plain AGENTS.md block) (repeatable)", collect)
    .action(run((opts) => living.install(opts)));
  program
    .command("uninstall")
    .description("Remove everything `cube install` added. The cube's files stay.")
    .option("--agent <id>", "remove only what was installed for this agent (claude-code, codex)")
    .action(run((opts) => living.uninstall(opts)));

  program
    .command("status")
    .description("Find boxes whose code changed near what they mention (stale) or whose code names are gone (needs review). No AI; changes nothing.")
    .option("--json", "print results as JSON")
    .option("--mark", "also mark the boxes found in their headers, and clear marks that no longer apply")
    .addOption(new Option("--no-write", "report only (the default now)").hideHelp())
    .action(run((opts) => status(opts)));

  program
    .command("ok <ids...>")
    .description("Mark boxes as checked: refresh their code links and fingerprints and set them back to ok.")
    .action(run((ids, opts) => ok(ids, opts)));

  program
    .command("links [ids...]")
    .description("Re-link boxes to the code they mention (all boxes if none given).")
    .action(run((ids, opts) => links(ids ?? [], opts)));

  const config = program.command("config").description("Read or change settings (cube.config.json).");
  config
    .command("get [key]")
    .description("Show one setting, or all of them.")
    .action(run((key, opts) => core.configGet(key, opts)));
  config
    .command("set <key> <value>")
    .description("Change a setting.")
    .action(run((key, value, opts) => core.configSet(key, value, opts)));

  // ---------- building from existing files ----------
  program
    .command("build")
    .description("Build the cube from the project's existing memory files, git history, and code. Resumes if stopped.")
    .option("-y, --yes", "accept every default without asking")
    .option("--stop-after <stage>", "stop after a stage: scan, classify, confirm, estimate, recipe, split, rows, review, place, enrich, codelinks, backlinks, check, spotcheck, install")
    .option("--restart", "throw away the build in progress and start over")
    .option("--source <path>", "only consider this file (repeatable)", collect)
    .option("--add <path>", "include this file even if it doesn't look like memory (repeatable)", collect)
    .option("--preset <preset>", "economy, balanced, or max (default: the cube's setting)")
    .option("--at <time>", "start the big part of the build (after you review the rows) at this time, like 23:30 or 11:30pm, say after your plan's usage resets; the terminal waits until then")
    .option("--answer <key=answer>", "the person's answer to a question it stopped at, when running without a terminal (repeatable)", collect)
    .addOption(new Option("--background-child", "the build's background process (internal)").hideHelp())
    .action(run((opts) => build({ ...opts, backgroundChild: !!opts.backgroundChild })));
  program
    .command("recipe")
    .description("recipe.json: how the source files are structured.")
    .command("check")
    .description("Dry-run recipe.json and report what it would produce. Changes nothing.")
    .action(run((opts) => recipeCheck(opts)));
  program
    .command("build-status")
    .description("Show how a build is going: the stages done, a build running in the background, and any question waiting for the person.")
    .option("--stop", "stop a build running in the background (it keeps its place)")
    .action(run((opts) => buildStatus(opts)));

  // ---------- the A/B experiment ----------
  const b = program.command("bench").description("The A/B experiment: the same tasks in a copy with your current files and a copy with the cube.");
  b.command("init").description("Write a starter tasks file.").action(run((opts) => bench.benchInit(opts)));
  b.command("run")
    .description("Run every task several times in each copy (uses a lot of your plan's usage).")
    .option("--tasks <file>", "tasks file (default: context-cube/.logs/bench/tasks.yaml)")
    .option("--only <id>", "only this task (repeatable)", collect)
    .option("--runs <n>", "runs per task per copy")
    .option("--model <model>", "the main session's model")
    .action(run((opts) => bench.benchRun(opts)));
  b.command("score")
    .description("Score each run blind, 1–5, without seeing which copy made it.")
    .option("--results <dir>", "results folder (default: the latest)")
    .option("--ai", "let Opus score the runs blind instead of you")
    .option("--yes", "with --ai, don't ask before starting")
    .action(run((opts) => bench.benchScore(opts)));
  b.command("report").description("Write the report (unblinded).").option("--results <dir>", "results folder (default: the latest)").action(run((opts) => bench.benchReportCmd(opts)));
  b.command("clean").description("Remove the two bench copies (git worktrees).").action(run((opts) => bench.benchClean(opts)));

  // ---------- AI ----------
  const ai = program.command("ai").description("The AI runner.");
  ai.command("test")
    .description("Run a trivial AI step live, to check the agent works at each tier. Uses a little of your plan's usage.")
    .option("--tier <tier>", "haiku, sonnet, opus, or all", "all")
    .option("--force-fail", "make the first tier fail, to see retry and escalation")
    .action(run((opts) => aiTest(opts)));

  program
    .command("stats")
    .description("What the agent read, compared with reading the same areas in full (estimates). --ai for AI use per step.")
    .option("--all", "every session, not just the last")
    .option("--ai", "AI use per step, with quality signals")
    .option("--export", "with --ai: write a shareable file with per-step numbers only")
    .option("--json", "print as JSON")
    .action(run((opts) => statsAi(opts)));

  // ---------- the read logger ----------
  const log = program.command("log").description("The read logger: see what your agent reads from memory files.");
  log
    .command("install")
    .description("Install hooks that log every file your agent reads (no AI tokens used).")
    .option("--shared", "install into the shared, committed .claude/settings.json instead of your personal settings")
    .action(run((opts) => logInstall({ shared: opts.shared })));
  log
    .command("report")
    .description("Show tokens per session spent on memory files, and which lines were ever read.")
    .option("--json", "print the report as JSON")
    .action(run((opts) => logReport({ json: opts.json })));
  log
    .command("uninstall")
    .description("Remove exactly what `cube log install` added. Your logs are kept unless you pass --delete-logs.")
    .option("--delete-logs", "also delete the logs")
    .action(run((opts) => logUninstall({ deleteLogs: opts.deleteLogs })));

  program
    .command("merge-file <kind> <base> <ours> <theirs>", { hidden: true })
    .description("Git merge driver for cube files (internal).")
    .action((kind: string, base: string, ours: string, theirs: string) => {
      process.exitCode = mergeFile(kind as any, base, ours, theirs);
    });

  program
    .command("hook <event>", { hidden: true })
    .description("Entry point for agent hooks (internal).")
    .option("--features <list>", "comma-separated features", "log")
    .option("--agent <id>", "the agent whose hook this is (claude-code, codex)", "claude-code")
    .action(async (event: string, opts: { features?: string; agent?: string }) => {
      process.exitCode = await hookCommand(event, opts);
    });

  return program;
}

const isMain = (() => {
  // Run when executed directly (the bundle), not when imported by tests.
  const arg = process.argv[1] ?? "";
  return /cube\.mjs$|cli\.(ts|js)$|[\\/](cube|context-cube)$/.test(arg);
})();

if (isMain) {
  buildProgram().parseAsync(process.argv);
}
