import { spawnSync } from "node:child_process";
import { exists } from "../core/fsutil";
import { cubePaths, findProjectRoot, TOOL_COMMAND } from "../core/paths";
import { gitRoot, hasGit } from "../core/git";
import { allBoxes, loadCube } from "../core/cube";
import { loadConfig, saveConfig, defaultConfig, type CubeConfig } from "../core/config";
import { init } from "../commands/core";
import { build } from "../commands/build";
import { createBox } from "../core/ops";
import { reindex } from "../core/index/index";
import { installAgents } from "../core/install";
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
import { hasBuildState, loadState } from "../core/build/pipeline";
import { loadBoxState } from "../core/state/state";
import { UsageLimitError } from "../ai/runner";
import { terminalAsker, type Asker } from "./ask";
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
  ask?: Asker;
  backend?: AIBackend;
}

export interface Preflight {
  node: string;
  nodeOk: boolean;
  git: boolean;
  gitRepo: boolean;
  claude?: { installed: boolean; loggedIn?: boolean; plan?: string };
  cubeExists: boolean;
  buildInProgress: boolean;
}

export function preflight(root: string): Preflight {
  const major = Number(process.versions.node.split(".")[0]);
  const r = spawnSync(process.env.CUBE_CLAUDE_BIN || "claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
  let claude: Preflight["claude"] = { installed: r.status !== null && !r.error };
  if (claude.installed) {
    try {
      const d = JSON.parse(r.stdout);
      claude = { installed: true, loggedIn: !!d.loggedIn, plan: d.subscriptionType };
    } catch {
      claude = { installed: true };
    }
  }
  const cube = loadCube(root);
  return {
    node: process.versions.node,
    nodeOk: major >= 20,
    git: hasGit(),
    gitRepo: !!gitRoot(root),
    claude,
    cubeExists: allBoxes(cube).some((b) => !b.isRoot) || (cube.rows.length > 0 && !hasBuildState(root)),
    buildInProgress: hasBuildState(root) && !loadState(root).done.includes("install"),
  };
}

function say(ask: Asker, lines: string | string[]): void {
  for (const l of Array.isArray(lines) ? lines : [lines]) ask.say(l);
}

export async function setup(opts: SetupOptions = {}): Promise<string[]> {
  const root = findProjectRoot(opts.cwd);
  const ask = opts.ask ?? terminalAsker({ yes: opts.yes });
  // Rewriting the person's rules needs an explicit yes: in a terminal, or with --yes.
  const mayEditOriginals = ask.interactive || !!opts.yes;
  const pf = preflight(root);

  say(ask, [`Context Cube setup in ${root}`, ""]);
  if (!pf.nodeOk) return [`Context Cube needs Node 20 or newer; this is Node ${pf.node}. Install a newer Node and run it again.`];
  if (!pf.git) say(ask, "  Git isn't installed. The cube still works, with fewer features: no history from commits, and updates happen at the end of work.");
  else if (!pf.gitRepo) say(ask, "  This folder isn't a git repository. The cube works without git; history can't come from commits, and updates happen at the end of work.");
  if (!pf.claude?.installed) say(ask, "  Claude Code isn't installed. The cube will still be written as plain files (with an AGENTS.md block), but building it from existing files needs Claude Code for its AI steps.");
  else if (pf.claude.loggedIn === false) return ["Claude Code isn't logged in. Run `claude` once and log in, then run this again."];
  else if (pf.claude.plan) say(ask, `  Claude Code: logged in (${pf.claude.plan} plan). AI steps use your plan's usage; before any big step it shows how much, by model, and you can have it start later, like overnight. If usage runs out mid-way, run this again after it resets and it picks up where it stopped.`);

  // A build that stopped partway (say, at a usage limit) has boxes already; finish it rather than "update" it.
  if (pf.cubeExists && !pf.buildInProgress) return updateExisting(root, ask, opts);

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
  const situation = pf.buildInProgress || hasMemory ? "existing" : "fresh";

  if (!pf.claude?.installed && situation === "existing") {
    say(ask, "  Without Claude Code, the build can't read your existing files. Setting up an empty cube instead.");
  }
  if (situation === "existing" && pf.claude?.installed) {
    say(ask, pf.buildInProgress ? "Continuing the build that was in progress.\n" : `Found ${candidates.length} file${candidates.length === 1 ? "" : "s"} that could hold project memory. Building the cube from them.\n`);
    const buildOut = await build({ cwd: root, ask, backend: opts.backend, preset: opts.preset, at: opts.at });
    const state = loadState(root);
    if (!state.done.includes("install")) return buildOut; // paused or stopped; it said why
    await handleOriginals(root, ask, mayEditOriginals);
  } else {
    await fresh(root, ask, opts, pf);
  }

  // The read logger, for `cube stats`.
  const wantLogger = opts.logger ?? (await ask.confirm("Also log which files your agent reads, so `cube stats` can compare that with reading the same areas in full? (The log stays on this machine.)", true));
  if (wantLogger && pf.claude?.installed) logInstall({ cwd: root });

  return finish(root);
}

async function fresh(root: string, ask: Asker, opts: SetupOptions, pf: Preflight): Promise<void> {
  const config = exists(cubePaths(root).config) ? loadConfig(root) : defaultConfig();
  const agents = pf.claude?.installed ? ["claude-code"] : ["generic"];
  say(ask, "No memory files yet, so this starts a fresh cube: rules, history, and invariants rows that fill up as work happens.");
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
    if (allowed && (await ask.confirm("Rewrite them to point at the cube? (The original words stay in the cube; they just stop loading.)", true))) {
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
async function updateExisting(root: string, ask: Asker, opts: SetupOptions): Promise<string[]> {
  say(ask, "A cube already exists here.");
  const theirs = readToolVersion(root);
  const upgrade = theirs && compareVersions(version(), theirs) > 0 ? ` and update the project's copy of Context Cube from ${theirs} to ${version()}` : "";
  const ok = await ask.confirm(`Update it (check which boxes are stale, refresh code links and indexes, and reinstall the hooks${upgrade}) instead of rebuilding?`, true);
  if (!ok) return [`Nothing changed. To rebuild from scratch: take the cube out of your agent and put your original files back (${TOOL_COMMAND} uninstall, then ${TOOL_COMMAND} restore --all), then move context-cube/ out of the way and run this again.`];
  const tool = installTool(root);
  linkCodeForStale(root);
  const marked = applyStatus(root, computeStatus(root));
  await installAgents(root, undefined, { shared: opts.shared });
  const cube = loadCube(root);
  return [
    ...(tool.updatedFrom ? [`Updated the project's copy of Context Cube from ${tool.updatedFrom} to ${version()}. Commit context-cube/ so teammates get it too.`] : []),
    `Updated: ${cube.rows.length} rows, ${allBoxes(cube).filter((b) => !b.isRoot).length} boxes${marked ? `; ${marked} box${marked === 1 ? " is" : "es are"} now marked stale or needs-review (see: ${TOOL_COMMAND} status)` : ""}.`,
    "Hooks, path rules, and the always-loaded block are current.",
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
  out.push(
    "",
    "From now on:",
    "  • Every session starts with the rules and the row list. The agent opens rows and boxes only when a task needs them.",
    `  • ${config.update.trigger === "commit" ? "After each commit" : config.update.trigger === "stop" ? "At the end of each session's work" : "When you run /cube-update"}, the agent writes a short note and a cheaper helper updates the cube.`,
    "  • Invariant changes need a person's approval by default. You can change this anytime by asking your AI to turn off invariant approvals (it will ask you to confirm).",
    logger ? "  • What the agent reads is logged on this machine; see it with: node context-cube/.tool/cube.mjs stats" : "",
    gitRoot(root)
      ? `  • Commit context-cube/ now${archived.length ? ", with CLAUDE.md and the placeholders," : ""} like any other folder: until you do, the cube${archived.length ? " and the archived originals" : ""} exist only on this machine, and your team doesn't share the memory.`
      : "  • Keep context-cube/ with the project (and in version control if you add it), so the memory travels with the code.",
  );
  return out.filter((l) => l !== "");
}
