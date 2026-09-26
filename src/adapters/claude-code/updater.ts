import { join } from "node:path";
import { exists, isDir, remove, writeIfChanged } from "../../core/fsutil";
import { emptyManifest, loadManifest, saveManifest } from "../../core/installs";
import { TOOL_COMMAND } from "../../core/paths";
import type { UpdaterSpec } from "../types";
import { ADAPTER_ID } from "./hooks";
import { readdirSync } from "node:fs";

/**
 * The note-plus-helper split (plan 8.2): the main session writes a short note;
 * a subagent on the cheap tier does the mechanical work. Verified 2026-09-23:
 * `model: haiku` in .claude/agents/*.md runs the subagent on Haiku with only the
 * listed tools. Also installs /cube-update, the manual trigger (plan 8.1).
 */

export const AGENT_FILE = ".claude/agents/cube-updater.md";
export const COMMAND_FILE = ".claude/commands/cube-update.md";

export function updaterAgent(spec: UpdaterSpec): string {
  return `---
name: cube-updater
description: ${spec.description}
model: ${spec.tier}
tools: Bash, Read, Grep, Glob
---
${spec.prompt}
`;
}

export function updateCommand(): string {
  return `---
description: Update the project's Context Cube for the work in this session.
---
Update the project memory (Context Cube) for the work done in this session.

1. Run \`${TOOL_COMMAND} update-plan\` to see which boxes are linked to what changed and which commands to use.
2. Write a short note (2–4 sentences): what changed and why.
3. Hand the note and the plan to the cube-updater agent (subagent_type "cube-updater"). It runs on a cheap model and does the mechanical updates.
4. If the helper reports a possible new invariant, propose it with \`${TOOL_COMMAND} propose new ...\`; a person approves it.
`;
}

export function installUpdater(root: string, spec: UpdaterSpec): void {
  const manifest = loadManifest(root, ADAPTER_ID, "shared") ?? emptyManifest(ADAPTER_ID, "shared");
  const dirs = new Set(manifest.dirs);
  for (const d of [".claude", ".claude/agents", ".claude/commands"]) if (!isDir(join(root, d))) dirs.add(d);
  const files = new Set(manifest.files);
  for (const [rel, text] of [
    [AGENT_FILE, updaterAgent(spec)],
    [COMMAND_FILE, updateCommand()],
  ] as const) {
    if (!exists(join(root, rel))) files.add(rel);
    writeIfChanged(join(root, rel), text);
  }
  manifest.files = [...files];
  manifest.dirs = [...dirs];
  saveManifest(root, manifest);
}

export function uninstallUpdater(root: string): void {
  const manifest = loadManifest(root, ADAPTER_ID, "shared");
  if (!manifest) return;
  for (const f of manifest.files.filter((x) => x === AGENT_FILE || x === COMMAND_FILE)) remove(join(root, f));
  manifest.files = manifest.files.filter((x) => x !== AGENT_FILE && x !== COMMAND_FILE);
  for (const d of [".claude/agents", ".claude/commands"]) {
    const abs = join(root, d);
    if (manifest.dirs.includes(d) && isDir(abs) && readdirSync(abs).length === 0) remove(abs);
  }
  saveManifest(root, manifest);
}

export const UPDATER_PROMPT = `You keep this project's Context Cube (the project memory in context-cube/) current after a change. You get a short note from the main session about what changed and why, and an update plan listing the commands to use.

Work only through the cube's commands (run from the project root):

1. Add the note to the open history entry, exactly as the plan shows:
   ${TOOL_COMMAND} history add "<the note>" [--key "<key from the plan>"] [--touches <box ids>]
2. For each box the plan lists as linked to the changed files: read its Z0-overview.md (and Z4-detail.md if there is one) and compare with the change. A changed file doesn't mean the box is wrong; fix only what the change made wrong or incomplete:
   ${TOOL_COMMAND} edit <id> --summary "<one line>" --read-when "<one line>"
   ${TOOL_COMMAND} write <id> Z4 --append @<file saying what changed>
   The summary is what agents read first, so it should be true now. Never rewrite or shorten text that's already in a drawer. It may be the project's original notes, kept word for word, and its old details (why something failed, what not to try again) are what the cube is for. --append puts your note below it, dated. An agent reads the older text above it first, so make the note stand on its own: what changed, and what's true now. Only a box with no Z4 yet gets a new one: ${TOOL_COMMAND} write <id> Z4 @<file>
   When you've checked them all, mark them checked in one command: ${TOOL_COMMAND} ok <id> <id> ...
3. If the change added a component or feature worth remembering and no box covers it, create one:
   ${TOOL_COMMAND} new-box <row id> <short-name> --summary "..." --read-when "..."
   and link it: ${TOOL_COMMAND} link <new id> <related id> --rel see-also --note "<why someone would follow this link>"
   Link only when the note gives a real reason to follow it.
   A read-when line decides whether an agent opens the box, so name the changes and symptoms that need it ("Before changing replay order or reconnect handling in src/sync/queue.ts, or when edits arrive out of order"), not a topic ("Working on sync").
4. Never edit invariant text (Z1 in the invariants row); you can't, and shouldn't try. If the change seems to create or change a rule that must never be broken, don't write it: describe it in your reply so the main session can propose it.
5. Reply with a short report: what you updated, and any possible new invariants.

Keep it brief. Read only the files the plan names; don't explore the code.`;
