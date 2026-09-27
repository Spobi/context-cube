import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { exists, isDir } from "../core/fsutil";
import { cubePaths, findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { gitRoot, hasGit } from "../core/git";
import { allBoxes, loadCube } from "../core/cube";
import { loadConfig, saveConfig, defaultConfig, type CubeConfig } from "../core/config";
import { init } from "../commands/core";
import { build } from "../commands/build";
import { createBox } from "../core/ops";
import { reindex } from "../core/index/index";
import { addAgents, installAgents } from "../core/install";
import { compareVersions, installTool, readToolVersion, version } from "../core/tool";
import { linkCode } from "../core/code/links";
import { applyStatus, computeStatus } from "../core/code/status";
import { scanCandidates } from "../core/build/scan";
import { listProjectFiles } from "../core/scan";
import { loadRecipe } from "../core/build/recipe";
import { placedCoverage } from "../core/build/coverage";
import { logInstall } from "../commands/log";
import { loadManifest } from "../core/installs";
import { isAgentFile } from "../core/logs/memoryFiles";
import { hasBuildState, loadState, saveState } from "../core/build/pipeline";
import { loadBoxState } from "../core/state/state";
import { UsageLimitError } from "../ai/runner";
import { NeedsAnswer, needsAnswerMessage, parseAnswers, terminalAsker, type Asker } from "./ask";
import { findClaude, hasClaudeDesktop, inClaudeDesktop, type ClaudeBin } from "../adapters/claude-code/bin";
import { codexOnMachine, inCodexSession } from "../adapters/codex/index";
import { interview } from "./interview";
import { applyRuleRewrites, ruleRewrites } from "./originals";
import { archiveSources, orphanPlaceholders, sourceHomes } from "../core/archive";
import { isArchived, listArchived } from "../core/build/sources";
import type { AIBackend } from "../ai/backends";
import type { Preset } from "../ai/tiers";

/**
 * The guided setup, `npx context-cube` (plan 7). One command runs everything,
 * pausing only to confirm sources, before spending usage, to review rows, and
 * for questions the tool can't answer. Every question has a default.
 */

export interface SetupOptions {
  cwd?: string;
  yes?: boolean;
  preset?: string;
  /** Start the part of the build after the row review at this time (see cube build --at). */
  at?: string;
  shared?: boolean;
  logger?: boolean;
  /** The person's answers, relayed by an agent when there's no terminal: `--answer key=value`. */
  answer?: string[];
  ask?: Asker;
  backend?: AIBackend;
  /** For tests: see BuildOptions.startBackground. */
  startBackground?: (root: string, args: string[]) => number | undefined;
}

export interface Preflight {
  node: string;
  nodeOk: boolean;
  git: boolean;
  gitRepo: boolean;
  /** Claude Code as a program the build can run: the CLI, or the desktop app's own copy. */
  claude?: { installed: boolean; loggedIn?: boolean; plan?: string; from?: ClaudeBin["from"] };
  /** The project already has Claude Code files (.claude/, CLAUDE.md). */
  claudeProject: boolean;
  /** The Claude desktop app is on this machine. */
  claudeDesktop: boolean;
  /** Codex is on this machine. */
  codex: boolean;
  /** The project already has Codex files (.codex/). */
  codexProject: boolean;
  cubeExists: boolean;
  buildInProgress: boolean;
  /** Setup started a build that's done now (say, in the background), and its own last steps are left. */
  setupPending: boolean;
}

export function preflight(root: string): Preflight {
  const major = Number(process.versions.node.split(".")[0]);
  const bin = findClaude();
  let claude: Preflight["claude"] = { installed: false };
  if (bin) {
    const r = spawnSync(bin.path, ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
    claude = { installed: r.status !== null && !r.error, from: bin.from };
    if (claude.installed) {
      try {
        const d = JSON.parse(r.stdout);
        claude = { ...claude, loggedIn: !!d.loggedIn, plan: d.subscriptionType };
      } catch {
        // an older Claude Code without --json: logged in or not, the build will say
      }
    }
  }
  const cube = loadCube(root);
  const state = hasBuildState(root) ? loadState(root) : undefined;
  return {
    node: process.versions.node,
    nodeOk: major >= 20,
    git: hasGit(),
    gitRepo: !!gitRoot(root),
    claude,
    claudeProject: isDir(join(root, ".claude")) || exists(join(root, "CLAUDE.md")),
    claudeDesktop: hasClaudeDesktop(),
    codex: codexOnMachine(),
    codexProject: isDir(join(root, ".codex")),
    cubeExists: allBoxes(cube).some((b) => !b.isRoot) || (cube.rows.length > 0 && !state),
    buildInProgress: !!state && !state.done.includes("install"),
    setupPending: !!state?.viaSetup && state.done.includes("install") && !state.setupDone,
  };
}

/**
 * The agents to set the cube up for. Claude Code when it's here in any form
 * (the CLI, the desktop app's own copy, a desktop session, or files in the
 * project); Codex when the project uses it, setup runs in a Codex session, or
 * it's the only agent here, else if the person says so.
 */
async function chooseAgents(root: string, pf: Preflight, ask: Asker): Promise<string[]> {
  if (exists(cubePaths(root).config)) {
    const configured = loadConfig(root).agents;
    if (configured.length) return configured;
  }
  const agents: string[] = [];
  // The desktop app alone doesn't mean Claude Code: many use it only to chat. Its own copy of Claude Code does.
  if (pf.claude?.installed || pf.claudeProject || inClaudeDesktop()) agents.push("claude-code");
  if (pf.codex || pf.codexProject || inCodexSession()) {
    const withCodex =
      pf.codexProject || inCodexSession() || !agents.length || (await ask.confirm("Codex is on this machine too. Also set the cube up for Codex (a block in AGENTS.md, and hooks in .codex/)?", false));
    if (withCodex) agents.push("codex");
  }
  return agents.length ? agents : ["generic"];
}

function say(ask: Asker, lines: string | string[]): void {
  for (const l of Array.isArray(lines) ? lines : [lines]) ask.say(l);
}

export async function setup(opts: SetupOptions = {}): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const ask = opts.ask ?? terminalAsker({ yes: opts.yes, answers: parseAnswers(opts.answer) });
  try {
    return await runSetup(root, ask, opts);
  } catch (err) {
    if (err instanceof NeedsAnswer) return needsAnswerMessage(err);
    throw err;
  }
}

async function runSetup(root: string, ask: Asker, opts: SetupOptions): Promise<string[]> {
  // Rewriting the person's rules needs an explicit yes: in a terminal, with --yes, or relayed by an agent.
  const mayEditOriginals = ask.interactive || !!opts.yes || !!ask.relay;
  const pf = preflight(root);

  say(ask, [`Context Cube setup in ${root}`, ""]);
  if (!pf.nodeOk) return [`Context Cube needs Node 20 or newer; this is Node ${pf.node}. Install a newer Node and run it again.`];
  if (!pf.git) say(ask, "  Git isn't installed. The cube still works, with fewer features: no history from commits, and updates happen at the end of work.");
  else if (!pf.gitRepo) say(ask, "  This folder isn't a git repository. The cube works without git; history can't come from commits, and updates happen at the end of work.");
  if (!pf.claude?.installed) {
    say(
      ask,
      pf.claudeDesktop
        ? "  Claude Code isn't installed as a command here. The cube will still be set up, but building it from existing files needs Claude Code for its AI steps: ask Claude to run this setup in a Claude desktop app session (it uses the app's own Claude Code), or install the command-line tool (https://code.claude.com)."
        : "  Claude Code isn't installed. The cube will still be set up, but building it from existing files needs Claude Code for its AI steps (https://code.claude.com; the Claude desktop app works too).",
    );
  } else if (pf.claude.loggedIn === false) {
    return [pf.claude.from === "desktop" || pf.claude.from === "session" ? "Claude Code isn't logged in. Open the Claude desktop app and log in, then run this again." : "Claude Code isn't logged in. Run `claude` once and log in, then run this again."];
  } else if (pf.claude.plan) {
    const which = pf.claude.from === "desktop" ? " (the copy that comes with the Claude desktop app)" : pf.claude.from === "session" ? " (the one running this session)" : "";
    say(ask, `  Claude Code${which}: logged in (${pf.claude.plan} plan). AI steps use your plan's usage; before any big step it shows how much, by model, and you can have it start later, like overnight. If usage runs out mid-way, run this again after it resets and it picks up where it stopped.`);
  }
  if (ask.relay) say(ask, "  No terminal here, so questions that need the person stop this command one at a time, and the long part of a build runs in the background.");

  // A build that stopped partway (say, at a usage limit) has boxes already; finish it rather than "update" it.
  if (pf.cubeExists && !pf.buildInProgress && !pf.setupPending) return updateExisting(root, ask, opts, pf);

  const files = listProjectFiles(root);
  const orphans = orphanPlaceholders(root, files);
  if (orphans.length) {
    const one = orphans.length === 1;
    return [
      `${orphans.join(", ")} ${one ? "is a placeholder" : "are placeholders"} left by an earlier Context Cube: ${one ? "its original was" : "their originals were"} archived in a context-cube/ folder that isn't here any more.`,
      `Put ${one ? "it" : "them"} back first: return that context-cube/ folder and run \`${TOOL_COMMAND} restore --all\`, or get the originals from git history. (Or delete the placeholder${one ? "" : "s"} to build without ${one ? "it" : "them"}.) Then run this again.`,
    ];
  }
  const candidates = scanCandidates(root, files);
  const hasMemory = candidates.length > 0;
  const situation = pf.buildInProgress || pf.setupPending || hasMemory ? "existing" : "fresh";
  if (situation === "existing" && pf.claude?.installed && inCodexSession() && process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    // Claude Code's AI steps need the network. Stop before changing anything, rather than build an empty cube.
    return [
      "Building the cube from your files runs Claude Code's AI steps, which need the network, and Codex's sandbox has it switched off here. Nothing was changed.",
      "Run this setup in a terminal instead (or let Codex run it with network access). Codex can read the cube once it's built.",
    ];
  }
  const agents = await chooseAgents(root, pf, ask);

  if (!pf.claude?.installed && situation === "existing") {
    say(ask, "  Without Claude Code, the build can't read your existing files. Setting up an empty cube instead.");
  }
  if (situation === "existing" && pf.claude?.installed) {
    saveAgents(root, agents);
    say(ask, pf.setupPending ? "The build is done; finishing the setup.\n" : pf.buildInProgress ? "Continuing the build that was in progress.\n" : `Found ${candidates.length} file${candidates.length === 1 ? "" : "s"} that could hold project memory. Building the cube from them.\n`);
    const buildOut = await build({ cwd: root, ask, backend: opts.backend, preset: opts.preset, at: opts.at, shared: opts.shared, viaSetup: true, startBackground: opts.startBackground });
    const state = loadState(root);
    if (!state.done.includes("install")) return buildOut; // paused, stopped, or carrying on in the background; it said why
    await handleOriginals(root, ask, mayEditOriginals);
  } else {
    await fresh(root, ask, opts, pf, agents);
  }

  // The read logger, for `cube stats` (Claude Code's hooks only, for now).
  const wantLogger = opts.logger ?? (await ask.confirm("Also log which files your agent reads, so `cube stats` can compare that with reading the same areas in full? (The log stays on this machine.)", true));
  if (wantLogger && loadConfig(root).agents.includes("claude-code")) logInstall({ cwd: root });

  if (hasBuildState(root)) {
    const state = loadState(root);
    state.setupDone = true;
    saveState(root, state);
  }
  return finish(root);
}

/** Records the agents before a build, which sets them up when it installs. */
function saveAgents(root: string, agents: string[]): void {
  const c = exists(cubePaths(root).config) ? loadConfig(root) : defaultConfig();
  if (c.agents.length) return;
  c.agents = agents;
  saveConfig(root, c);
}

async function fresh(root: string, ask: Asker, opts: SetupOptions, pf: Preflight, agents: string[]): Promise<void> {
  const config = exists(cubePaths(root).config) ? loadConfig(root) : defaultConfig();
  say(ask, "No memory files yet, so this starts a fresh cube: rules, history, and invariants rows that fill up as work happens.");
  if (ask.relay && pf.claude?.installed) say(ask, `  The first rules come from a few questions that need a terminal, so the rules row starts empty. Add a rule any time: ${TOOL_COMMAND} new-box Y00 "short-name" --summary "The rule, in one line." --read-when "Always."`);
  let unit: CubeConfig["history"]["unit"] = config.history.unit;
  const drafted = pf.claude?.installed ? await interview(root, ask, { backend: opts.backend, preset: opts.preset as Preset | undefined }).catch((err) => {
    if (err instanceof UsageLimitError) say(ask, "  Your plan hit a usage limit, so the rules can wait; add them later with `cube new-box Y00 ...`.");
    else throw err;
    return undefined;
  }) : undefined;
  if (!unit) {
    unit = (await ask.choose("How should history be grouped? One entry per:", ["day", "commit", "build", "release", "pr", "session"], drafted?.historyUnit ?? (pf.gitRepo ? "day" : "session"))) as CubeConfig["history"]["unit"];
  }
  await init({ cwd: root, agents, historyUnit: unit });
  if (drafted?.rules.length) {
    say(ask, "\nDrafted rules:");
    drafted.rules.forEach((r, i) => say(ask, `  ${i + 1}. ${r.text}`));
    if (await ask.confirm("Add these rules?", true)) {
      for (const r of drafted.rules) createBox(root, 0, { name: r.name, summary: r.text.slice(0, 200), readWhen: "Always.", body: `${r.text}\n`, writtenBy: "ai" });
    }
  }
  const c = loadConfig(root);
  if (!pf.gitRepo) c.update.trigger = "stop";
  saveConfig(root, c);
  await installAgents(root, undefined, { shared: opts.shared });
}

/** Plan 7.4: original files. Rule rewrites need a yes; archiving doesn't (plan 18, 2026-09-26). */
async function handleOriginals(root: string, ask: Asker, allowed: boolean): Promise<void> {
  const recipe = loadRecipe(root);
  const sources = recipe?.sources.map((s) => s.path) ?? [];
  if (!sources.length) return;
  const homes = sourceHomes(root, sources);

  const rewrites = ruleRewrites(root, homes);
  if (rewrites.length) {
    say(ask, `\n${rewrites.length} rule${rewrites.length === 1 ? " points" : "s point"} at files whose content is now in the cube:`);
    for (const r of rewrites.slice(0, 8)) say(ask, `  ${r.box}: ${r.oldText.trim().split("\n")[0].slice(0, 110)}\n     → ${r.newText.trim().split("\n")[0].slice(0, 110)}`);
    if (rewrites.length > 8) say(ask, `  …and ${rewrites.length - 8} more`);
    if (allowed && (await ask.confirm("Rewrite them to point at the cube? (The original words stay in the cube; they just stop loading.)", true, "rewrite-rules"))) {
      const created = applyRuleRewrites(root, rewrites);
      say(ask, `  Rewrote ${created.length}.`);
    }
  }

  // Archive the originals without asking: nothing is lost, one command puts any back,
  // and the agent stops reading the same things twice. finish() tells the person where they are.
  const toArchive = sources.filter((p) => !isArchived(root, p));
  if (toArchive.length) {
    const r = archiveSources(root, toArchive);
    if (r.archived.length) say(ask, `\nArchived ${r.archived.length} original file${r.archived.length === 1 ? "" : "s"}; their content is in the cube.`);
    for (const s of r.skipped) say(ask, `  Left ${s.path} in place: ${s.why}.`);
  }
  await reindex(root);
}

/** A cube is already here: bring it up to date instead of rebuilding (plan 7.1). */
async function updateExisting(root: string, ask: Asker, opts: SetupOptions, pf: Preflight): Promise<string[]> {
  say(ask, "A cube already exists here.");
  const configured = loadConfig(root).agents;
  let addCodex = false;
  if ((pf.codex || pf.codexProject) && configured.length && !configured.includes("codex")) {
    addCodex = pf.codexProject || (await ask.confirm("Codex is on this machine. Also set the cube up for Codex (a block in AGENTS.md, and hooks in .codex/)?", false));
  }
  const theirs = readToolVersion(root);
  const upgrade = theirs && compareVersions(version(), theirs) > 0 ? ` and update the project's copy of Context Cube from ${theirs} to ${version()}` : "";
  const ok = await ask.confirm(`Update it (check which boxes are stale, refresh code links and indexes, and reinstall the hooks${upgrade}) instead of rebuilding?`, true);
  if (!ok) return [`Nothing changed. To rebuild from scratch: take the cube out of your agent and put your original files back (${TOOL_COMMAND} uninstall, then ${TOOL_COMMAND} restore --all), then move context-cube/ out of the way and run this again.`];
  // Hooks in personal settings reach only this machine; offer to share them, so a teammate who pulls gets them.
  let shared = opts.shared;
  if (shared === undefined && loadConfig(root).hooks.scope === "local" && gitRoot(root)) {
    shared = await ask.confirm("Move the cube's hooks from your personal settings to the shared project settings (.claude/settings.json), so teammates who pull get them too?", true);
  }
  const tool = installTool(root);
  if (addCodex) addAgents(root, ["codex"]);
  linkCodeForStale(root);
  const marked = applyStatus(root, computeStatus(root));
  const installed = await installAgents(root, undefined, { shared });
  const cube = loadCube(root);
  return [
    ...(tool.updatedFrom ? [`Updated the project's copy of Context Cube from ${tool.updatedFrom} to ${version()}. Commit context-cube/ so teammates get it too.`] : []),
    `Updated: ${cube.rows.length} rows, ${allBoxes(cube).filter((b) => !b.isRoot).length} boxes${marked ? `; ${marked} box${marked === 1 ? " is" : "es are"} now marked stale or needs-review (see: ${TOOL_COMMAND} status)` : ""}.`,
    "Hooks, path rules, and the always-loaded block are current.",
    ...(addCodex ? installed.filter((l) => l.startsWith("codex:") || l.startsWith("  Codex")) : []),
  ];
}

function linkCodeForStale(root: string): void {
  // Re-link every box, so a newer version's code search (which skips comments,
  // for one) replaces old links; files already linked keep their fingerprints,
  // so a change since a box was last checked still shows as stale.
  linkCode(root, undefined, { keepFingerprints: true });
}

function finish(root: string): string[] {
  const cube = loadCube(root);
  const boxes = allBoxes(cube).filter((b) => !b.isRoot).length;
  const config = loadConfig(root);
  const recipe = loadRecipe(root);
  const out = ["", "All set.", `  The cube: ${cube.rows.length} rows and ${boxes} boxes in context-cube/ (start at context-cube/CUBE.md).`];
  if (recipe?.sources.length) {
    const cov = placedCoverage(root, recipe.sources.map((s) => s.path));
    const ok = cov.filter((c) => c.ok).length;
    out.push(`  Coverage: ${ok} of ${cov.length} source files recombine exactly from the cube.`);
  }
  const archived = listArchived(root);
  if (archived.length) {
    const who = config.agents.includes("claude-code") ? "Claude" : "Your agent";
    out.push(
      "",
      `Your original files are stored safely, unchanged, in context-cube/.state/archive/:`,
      `  ${archived.join(", ")}`,
      `  ${who} is kept out of that folder, so it reads their content from the cube and doesn't read the same things twice.`,
      "  Each file's old spot now holds a short note saying where its content went.",
      `  To get a file back: ${TOOL_COMMAND} restore <file> (or --all for every file).`,
    );
  }
  const logger = loadManifest(root, "claude-code", "local")?.features.includes("log") || loadManifest(root, "claude-code", "shared")?.features.includes("log");
  const codex = config.agents.includes("codex");
  const commitAlso = [
    archived.length ? `${config.agents.includes("claude-code") ? "CLAUDE.md" : "AGENTS.md"} and the placeholders` : "",
    config.hooks.scope === "shared" && config.agents.includes("claude-code") ? ".claude/ (the hooks teammates get)" : "",
    codex ? "AGENTS.md, .codex/, and .agents/ (for Codex)" : "",
  ].filter(Boolean);
  out.push(
    "",
    "From now on:",
    "  • Every session starts with the rules and the row list. The agent opens rows and boxes only when a task needs them.",
    `  • ${config.update.trigger === "commit" ? "After each commit" : config.update.trigger === "stop" ? "At the end of each session's work" : "When you run /cube-update"}, the agent writes a short note and a cheaper helper updates the cube.`,
    "  • Invariant changes need a person's approval by default. You can change this anytime by asking your AI to turn off invariant approvals (it will ask you to confirm).",
    logger ? "  • What the agent reads is logged on this machine; see it with: node context-cube/.tool/cube.mjs stats" : "",
    codex ? "  • Codex reads the cube from AGENTS.md. It runs the project's hooks (the guard, notices, and updates) only once each person trusts the project's .codex/ folder: in Codex, run /hooks." : "",
    !codex && codexOnMachine() ? `  • Codex is on this machine too. To have it read the cube: ${TOOL_COMMAND} install --agent codex` : "",
    gitRoot(root)
      ? `  • Commit context-cube/ now${commitAlso.length ? `, with ${commitAlso.join(" and ")},` : ""} like any other folder: until you do, the cube${archived.length ? " and the archived originals" : ""} exist only on this machine, and your team doesn't share the memory.`
      : "  • Keep context-cube/ with the project (and in version control if you add it), so the memory travels with the code.",
  );
  return out.filter((l) => l !== "");
}
