/** The Z axis (plan 3.3): the same five drawers in every box of every row. */

export interface DrawerSpec {
  z: number;
  key: string;
  file: string;
  label: string;
}

export const DRAWERS: DrawerSpec[] = [
  { z: 0, key: "overview", file: "Z0-overview.md", label: "Overview" },
  { z: 1, key: "invariants", file: "Z1-invariants.md", label: "Invariants" },
  { z: 2, key: "code", file: "Z2-code.md", label: "Code" },
  { z: 3, key: "history", file: "Z3-history.md", label: "History" },
  { z: 4, key: "detail", file: "Z4-detail.md", label: "Detail" },
];

export function drawerFile(z: number): string {
  const d = DRAWERS.find((x) => x.z === z);
  if (!d) throw new Error(`No drawer Z${z}. Drawers are Z0–Z4.`);
  return d.file;
}

export function drawerFromFile(file: string): DrawerSpec | undefined {
  return DRAWERS.find((d) => d.file === file);
}

export const DRAWER_FILE_RE = /^Z(\d)-[a-z]+\.md$/;

export const ROW_TYPES = ["rules", "history", "invariants", "feature", "system", "catalog", "custom"] as const;
export type RowType = (typeof ROW_TYPES)[number];

export const LINK_RELS = ["touches", "governed-by", "implements", "see-also", "superseded-by"] as const;
export type LinkRel = (typeof LINK_RELS)[number];

export const STATUSES = ["ok", "stale", "needs-review", "pending", "open", "superseded"] as const;
export type Status = (typeof STATUSES)[number];

export const WRITERS = ["ai", "person", "migrated"] as const;
export type Writer = (typeof WRITERS)[number];
