import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function exists(path: string): boolean {
  return existsSync(path);
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readTextOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Writes through a temp file and rename, so a crash never leaves half a file. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Writes only when the content differs. Returns true if the file changed. */
export function writeIfChanged(path: string, text: string): boolean {
  if (readTextOr(path, "\u0000missing") === text) return false;
  writeText(path, text);
  return true;
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`);
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads a JSON-lines file, skipping blank or malformed lines. */
export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  const text = readTextOr(path, "");
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A partial line from a crash; skip it.
    }
  }
  return out;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Normalizes CRLF and CR line endings to LF. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function countLines(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}
