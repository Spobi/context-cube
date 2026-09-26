import { join } from "node:path";
import { appendLine, readJsonl } from "../fsutil";
import { cubePaths } from "../paths";
import type { ReadRecord } from "./extract";
import type { TranscriptUsage } from "./transcript";

export interface SessionRecord {
  t: string;
  event: "start" | "end";
  session: string;
  source?: string;
  reason?: string;
  cwd?: string;
  /** The agent's session transcript, for signals of what was used (stats). */
  transcript?: string;
  usage?: TranscriptUsage;
}

export function logFiles(root: string) {
  const logs = cubePaths(root).logs;
  return {
    dir: logs,
    reads: join(logs, "reads.jsonl"),
    sessions: join(logs, "sessions.jsonl"),
    errors: join(logs, "errors.log"),
    aiCalls: join(logs, "ai-calls.jsonl"),
    edits: join(logs, "edits.jsonl"),
  };
}

export interface EditRecord {
  t: string;
  session: string;
  tool: string;
  file: string;
}

export function appendEdit(root: string, e: EditRecord): void {
  appendLine(logFiles(root).edits, JSON.stringify(e));
}

export function loadEdits(root: string): EditRecord[] {
  return readJsonl<EditRecord>(logFiles(root).edits);
}

export function appendReads(root: string, records: ReadRecord[]): void {
  if (!records.length) return;
  const path = logFiles(root).reads;
  appendLine(path, records.map((r) => JSON.stringify(r)).join("\n"));
}

export function appendSession(root: string, record: SessionRecord): void {
  appendLine(logFiles(root).sessions, JSON.stringify(record));
}

export function loadReads(root: string): ReadRecord[] {
  return readJsonl<ReadRecord>(logFiles(root).reads);
}

export function loadSessions(root: string): SessionRecord[] {
  return readJsonl<SessionRecord>(logFiles(root).sessions);
}

export function logError(root: string, where: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    appendLine(logFiles(root).errors, `${new Date().toISOString()} ${where}: ${msg.replace(/\n/g, "\n  ")}`);
  } catch {
    // Logging must never break the agent's session.
  }
}
