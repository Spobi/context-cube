import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { exists, readText, writeText } from "../core/fsutil";
import { cubePaths } from "../core/paths";

/**
 * tasks.yaml for `cube bench` (Phase 9): id, prompt, size, automated checks,
 * and the invariants a task must respect.
 */

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "ids are lowercase words joined by hyphens"),
  prompt: z.string().min(1),
  size: z.enum(["simple", "complex"]),
  /** A shell command run in the copy after the task; exit 0 means it passed. */
  check: z.string().optional(),
  /** Invariants the task must respect (box ids or free text), shown when scoring. */
  invariants: z.array(z.string()).default([]),
  /** Extra tools to allow for this task, e.g. "Bash(xcodebuild:*)". */
  allow: z.array(z.string()).default([]),
  /** True when the task depends on an older incident (the case the cube is for). */
  older: z.boolean().default(false),
});
export type Task = z.infer<typeof TaskSchema>;

export const TasksFileSchema = z.object({
  model: z.string().default("sonnet"),
  runs: z.number().int().min(1).max(10).default(3),
  allow: z.array(z.string()).default([]),
  tasks: z.array(TaskSchema).min(1),
});
export type TasksFile = z.infer<typeof TasksFileSchema>;

export function benchDir(root: string): string {
  return join(cubePaths(root).logs, "bench");
}

export function defaultTasksPath(root: string): string {
  return join(benchDir(root), "tasks.yaml");
}

export function loadTasks(path: string): TasksFile {
  if (!exists(path)) throw new Error(`No tasks file at ${path}. Create one with: cube bench init`);
  const parsed = TasksFileSchema.safeParse(parseYaml(readText(path)));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(`${path}: ${i.path.join(".")}: ${i.message}`);
  }
  const ids = parsed.data.tasks.map((t) => t.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`${path}: task id "${dup}" appears twice`);
  return parsed.data;
}

export const STARTER = `# Tasks for \`cube bench\`: each runs in two copies of this repo at the same commit,
# one with the current memory files and one with the cube, several times each.
# The plan asks for at least 5: 2 simple, 2 complex, and 1 that depends on an older incident.
model: sonnet        # the main session's model for every run
runs: 3              # runs per task per copy
allow:               # tools every run may use without asking (plus Read, Edit, Write, Grep, Glob)
  - "Bash(git status:*)"
  - "Bash(git diff:*)"
tasks:
  - id: simple-example
    size: simple
    prompt: |
      Describe a small, well-defined change here, as you'd ask your agent.
    check: "echo replace me with a test command"
    invariants: []
  - id: older-incident-example
    size: complex
    older: true
    prompt: |
      A change in an area that was broken before (the call clock, paid extensions…),
      where the reason it broke lives deep in the old history.
    check: "echo replace me with a test command"
    invariants: ["Y02.X002"]
`;

export function writeStarter(root: string): string {
  const path = defaultTasksPath(root);
  if (!exists(path)) writeText(path, STARTER);
  return path;
}
