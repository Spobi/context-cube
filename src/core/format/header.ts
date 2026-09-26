import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { LINK_RELS, ROW_TYPES, STATUSES, WRITERS } from "./drawers";

/**
 * The header block at the top of every Z0 (plan 3.6). Tool-owned data
 * (sizes, fingerprints, checksums) lives in .state/, never here.
 */

export const LinkSchema = z.object({
  to: z.string(),
  name: z.string().optional(),
  rel: z.enum(LINK_RELS),
  note: z.string().optional(),
});
export type Link = z.infer<typeof LinkSchema>;

export const HeaderSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  read_when: z.string().optional(),
  /** What the box covers: an invariants topic's scope, or "project-wide" for history. */
  scope: z.string().optional(),
  /** Rules only: globs of the files the rule is about. It then loads with those files instead of every session. */
  paths: z.array(z.string()).optional(),
  row_type: z.enum(ROW_TYPES).optional(),
  conventions: z.array(z.string()).optional(),
  links: z.array(LinkSchema).default([]),
  status: z.enum(STATUSES).default("ok"),
  source: z.string().optional(),
  written_by: z.enum(WRITERS).default("person"),
});
export type Header = z.infer<typeof HeaderSchema>;

const KEY_ORDER: (keyof Header)[] = ["id", "name", "summary", "read_when", "scope", "paths", "row_type", "conventions", "links", "status", "source", "written_by"];

export interface ParsedDoc {
  /** Raw header data, if a header block was found and parsed as YAML. */
  data?: Record<string, unknown>;
  header?: Header;
  error?: string;
  body: string;
}

/** Splits `---\n...\n---\n` from the body. The body is returned byte for byte. */
export function splitFrontmatter(text: string): { yaml?: string; body: string } {
  if (!text.startsWith("---\n")) return { body: text };
  const end = text.indexOf("\n---\n", 3);
  const endAtEof = text.endsWith("\n---") && text.indexOf("\n---", 3) === text.length - 4;
  if (end < 0 && !endAtEof) return { body: text };
  if (end < 0) return { yaml: text.slice(4, text.length - 4), body: "" };
  return { yaml: text.slice(4, end), body: text.slice(end + 5) };
}

export function parseDoc(text: string): ParsedDoc {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === undefined) return { body, error: "missing header block (--- ... ---)" };
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (err) {
    return { body, error: `header is not valid YAML: ${(err as Error).message.split("\n")[0]}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { body, error: "header must be a set of fields" };
  const parsed = HeaderSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join(".") || "header";
    return { body, data: data as Record<string, unknown>, error: `${where}: ${issue.message}` };
  }
  return { body, data: data as Record<string, unknown>, header: parsed.data };
}

/** Serializes a header in a fixed key order, without line folding. */
export function stringifyHeader(h: Header): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = h[k];
    if (v === undefined) continue;
    if (k === "links" && Array.isArray(v) && v.length === 0) {
      ordered.links = [];
      continue;
    }
    ordered[k] = k === "links" ? (v as Link[]).map(orderLink) : v;
  }
  return stringifyYaml(ordered, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });
}

function orderLink(l: Link): Record<string, unknown> {
  const o: Record<string, unknown> = { to: l.to };
  if (l.name !== undefined) o.name = l.name;
  o.rel = l.rel;
  if (l.note !== undefined) o.note = l.note;
  return o;
}

export function renderDoc(h: Header, body: string): string {
  return `---\n${stringifyHeader(h)}---\n${body}`;
}
