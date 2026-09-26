import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AICall, AIResult } from "../types";
import { LIMIT_RE, UsageLimitError } from "../../ai/runner";

/**
 * One non-interactive Claude Code call (`claude -p`) at a given tier, with no
 * tools, a replaced system prompt, and structured output checked against a
 * JSON Schema. It runs in an empty temporary folder so no project instructions
 * or project hooks load (verified 2026-09-23, Claude Code 2.1.280; plan 18).
 * `--bare` isn't used: it refuses subscription logins.
 */
export async function runClaude(call: AICall): Promise<AIResult> {
  const cwd = mkdtempSync(join(tmpdir(), "cube-ai-"));
  const args = [
    "-p",
    "--model",
    call.tier,
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    call.system,
    "--json-schema",
    JSON.stringify(call.jsonSchema),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, CUBE_AI_CALL: "1" };
  delete env.CLAUDE_PROJECT_DIR;
  const started = Date.now();
  try {
    const { stdout, stderr, code } = await runProcess(process.env.CUBE_CLAUDE_BIN || "claude", args, call.prompt, cwd, env, call.timeoutMs ?? 15 * 60_000);
    let d: any;
    try {
      d = JSON.parse(stdout);
    } catch {
      const msg = (stderr || stdout).slice(0, 300);
      if (LIMIT_RE.test(msg)) throw new UsageLimitError(`Claude Code reported a usage limit: ${msg}`);
      throw new Error(`claude -p returned something that isn't JSON (exit ${code}): ${msg}`);
    }
    if (d.is_error || d.subtype !== "success") {
      const msg = String(d.result ?? d.subtype ?? stderr).slice(0, 300);
      if (LIMIT_RE.test(msg) || LIMIT_RE.test(String(d.api_error_status ?? ""))) throw new UsageLimitError(`Claude Code reported a usage limit: ${msg}`);
      throw new Error(`claude -p reported an error: ${msg}`);
    }
    let output: unknown = d.structured_output;
    if (output === undefined && typeof d.result === "string") {
      try {
        output = JSON.parse(stripFence(d.result));
      } catch {
        output = d.result;
      }
    }
    const usage = d.usage ?? {};
    const models = Object.entries(d.modelUsage ?? {}) as [string, any][];
    const main = models.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];
    return {
      output,
      raw: typeof d.result === "string" ? d.result : JSON.stringify(output),
      model: main ? main[1].canonicalModel ?? main[0] : undefined,
      tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      tokensOut: usage.output_tokens ?? 0,
      costUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined,
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function stripFence(s: string): string {
  const m = /```(?:json)?\n([\s\S]*?)\n```/.exec(s);
  return m ? m[1] : s;
}

function runProcess(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't run Claude Code (${bin}): ${err.message}. Is it installed and logged in?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}
