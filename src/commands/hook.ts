import { extractInstructions, extractReads, type HookInput } from "../core/logs/extract";
import { appendEdit, appendReads, appendSession, logError } from "../core/logs/store";
import { relToRoot } from "../core/paths";
import { resolve } from "node:path";
import { readTranscriptUsage } from "../core/logs/transcript";
import { loadConfig } from "../core/config";
import { hookRoot } from "../core/tool";

/**
 * `cube hook <event> --features a,b`: the entry point Claude Code hooks call.
 * Logging must never disturb the session, so every error is swallowed and
 * written to .logs/errors.log. Only guard hooks may exit with code 2 (block).
 */

export interface HookOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type HookHandler = (event: string, input: HookInput, root: string, features: Set<string>) => Promise<HookOutcome | void>;

/** Handlers added by later phases (session notice, guards, update trigger). */
const extraHandlers: HookHandler[] = [];

export function registerHookHandler(h: HookHandler): void {
  extraHandlers.push(h);
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleHook(event: string, input: HookInput, root: string, features: Set<string>): Promise<HookOutcome> {
  let charsPerToken = 4;
  try {
    charsPerToken = loadConfig(root).tokens.charsPerToken;
  } catch {
    // A broken config must not stop logging.
  }
  const outcome: HookOutcome = { exitCode: 0 };
  if (features.has("log")) {
    try {
      logEvent(event, input, root, charsPerToken);
    } catch (err) {
      logError(root, `hook ${event}`, err);
    }
  }
  for (const h of extraHandlers) {
    try {
      const r = await h(event, input, root, features);
      if (!r) continue;
      if (r.stdout) outcome.stdout = [outcome.stdout, r.stdout].filter(Boolean).join("\n");
      if (r.stderr) outcome.stderr = [outcome.stderr, r.stderr].filter(Boolean).join("\n");
      if (r.exitCode !== 0) outcome.exitCode = r.exitCode;
    } catch (err) {
      logError(root, `hook ${event}`, err);
    }
  }
  return outcome;
}

function logEvent(event: string, input: HookInput, root: string, charsPerToken: number): void {
  const now = new Date();
  switch (event) {
    case "post-tool-use": {
      const tool = input.tool_name ?? "";
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
        const ti = (input.tool_input ?? {}) as Record<string, unknown>;
        const file = String(ti.file_path ?? ti.notebook_path ?? "");
        if (file) appendEdit(root, { t: now.toISOString(), session: String(input.session_id ?? "unknown"), tool, file: relToRoot(root, resolve(input.cwd ?? root, file)) });
        break;
      }
      appendReads(root, extractReads(input, root, charsPerToken, now));
      break;
    }
    case "instructions-loaded":
      appendReads(root, extractInstructions(input, root, charsPerToken, now));
      break;
    case "session-start":
      appendSession(root, {
        t: now.toISOString(),
        event: "start",
        session: String(input.session_id ?? "unknown"),
        source: typeof input.source === "string" ? input.source : undefined,
        cwd: input.cwd,
        transcript: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
      });
      break;
    case "session-end": {
      const transcript = typeof input.transcript_path === "string" ? input.transcript_path : undefined;
      appendSession(root, {
        t: now.toISOString(),
        event: "end",
        session: String(input.session_id ?? "unknown"),
        reason: typeof input.reason === "string" ? input.reason : undefined,
        transcript,
        usage: transcript ? readTranscriptUsage(transcript) : undefined,
      });
      break;
    }
  }
}

export async function hookCommand(event: string, opts: { features?: string }): Promise<number> {
  let input: HookInput = {};
  let root: string;
  try {
    const raw = await readStdin();
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    input = {};
  }
  try {
    root = hookRoot(input.cwd);
  } catch {
    return 0;
  }
  const features = new Set((opts.features ?? "log").split(",").map((s) => s.trim()).filter(Boolean));
  const outcome = await handleHook(event, input, root, features);
  if (outcome.stdout) process.stdout.write(outcome.stdout.endsWith("\n") ? outcome.stdout : `${outcome.stdout}\n`);
  if (outcome.stderr) process.stderr.write(outcome.stderr.endsWith("\n") ? outcome.stderr : `${outcome.stderr}\n`);
  return outcome.exitCode;
}
