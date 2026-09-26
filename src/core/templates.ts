import type { NewRowInput } from "./ops";
import type { CubeConfig } from "./config";
import { TOOL_COMMAND } from "./paths";

/** Root boxes for the three rows every cube starts with (plan 3.4, 3.5). */

export function rulesRoot(): NewRowInput {
  return {
    type: "rules",
    name: "rules",
    summary: "Instructions that always apply in this project. Every rule is loaded at the start of every session.",
    readWhen: "Always. This row is loaded automatically, so there is nothing to open.",
    conventions: [
      "Read all of this row.",
      "One instruction per box, in the words the person wrote it.",
      "Z1 links to the invariants behind a rule; Z3 links to when and why it was added.",
    ],
    body: "The project's standing instructions. Each box holds one rule; the always-loaded block copies every rule here.\n",
  };
}

export function historyRoot(unit?: CubeConfig["history"]["unit"]): NewRowInput {
  const per = unit ? `one entry per ${unit}` : "one entry per unit of work";
  return {
    type: "history",
    name: "history",
    summary: `What changed and why, ${per}, newest first.`,
    readWhen: "Debugging, revisiting a decision, or changing something that was changed before.",
    conventions: [
      `${per[0].toUpperCase()}${per.slice(1)}. The oldest entry is X001; the newest has the highest number.`,
      "The row index lists entries newest first.",
      "Z0 summarizes an entry and links to every row it touched; Z4 holds the full entry, word for word.",
      `One entry is open at a time; add to it with \`${TOOL_COMMAND} history add\`.`,
    ],
    body: "The project's timeline. Entries are never rewritten; corrections go in later entries.\n",
  };
}

export function invariantsRoot(): NewRowInput {
  return {
    type: "invariants",
    name: "invariants",
    summary: "Rules that must never be broken, by topic: what must hold, why, and what breaks otherwise.",
    readWhen: "Before changing code that a box's Z2 lists, or anything the rules say needs the invariants.",
    conventions: [
      "One topic per box. Z1 holds the invariant text, word for word.",
      `Never edit Z1 directly. Propose changes with \`${TOOL_COMMAND} propose\`; a person approves them.`,
      "Z2 lists the code the invariants govern; Z3 lists the history entries that created or changed them.",
    ],
    body: "Load-bearing rules. A future change could quietly break any of these.\n",
  };
}
