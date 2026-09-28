import { proposalTitle, renderProposal, type Proposal } from "../../core/approvals";
import { TOOL_COMMAND } from "../../core/paths";

/**
 * Claude Code's question box: its AskUserQuestion tool, which pops a question
 * up for the person to pick an answer (arrow keys, or type one under "Other").
 * Only the agent can open it; a command the agent runs can't. So a command
 * that needs the person's say prints the box's input ready to use, and tells
 * the agent to open it rather than ask in a chat message.
 */
export interface PickerOption {
  label: string;
  description: string;
  /** Shown beside the options while this one is highlighted. */
  preview?: string;
}

export interface PickerQuestion {
  question: string;
  /** A short tag, at most 12 characters. */
  header: string;
  /** Two to four. The box adds "Other", for a typed answer, on its own. */
  options: PickerOption[];
}

/** Is this a command the agent ran in a Claude Code session (the terminal, the desktop app, an IDE)? */
export function inClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === "1";
}

/** The AskUserQuestion input for these questions (at most four), on one line. */
export function pickerInput(questions: PickerQuestion[]): string {
  return JSON.stringify({
    questions: questions.slice(0, 4).map((q) => ({
      question: q.question,
      header: q.header.slice(0, 12),
      multiSelect: false,
      options: q.options.slice(0, 4).map((o) => ({ label: o.label, description: o.description, ...(o.preview ? { preview: o.preview } : {}) })),
    })),
  });
}

/** How the agent is told to ask: "Ask the person <PICKER_ASK>." */
export const PICKER_ASK = "with your AskUserQuestion tool, so the question pops up for them to pick an answer";

/**
 * Asks the person about pending invariant changes, in the question box: at
 * most four at a time. Approving still runs `cube approve`, whose permission
 * prompt is the approval itself: the question box is only the question, since
 * the agent relays its answer.
 */
export function askAboutProposals(proposals: Proposal[]): string[] {
  const ask = proposals.slice(0, 4);
  if (!ask.length) return [];
  const questions: PickerQuestion[] = ask.map((p) => {
    // Why, and the text it adds or removes (renderProposal's lines after its two heading lines).
    const change = renderProposal(p).split("\n").slice(2, 30).map((l) => l.replace(/^  /, ""));
    const preview = [`Why: ${p.reason}`, `Proposed by ${p.by} on ${p.created.slice(0, 10)}`, "", ...change].join("\n");
    const approve = p.kind === "new" ? "It becomes a rule agents must follow" : p.kind === "delete" ? "The invariant is removed; its text is kept in the archive" : "The new text replaces the rule";
    const reject = p.kind === "new" ? "The candidate is removed" : p.kind === "delete" ? "The invariant stays" : "The rule stays as it is";
    return {
      question: `Approve ${proposalTitle(p)}?${p.kind === "new" ? " Until then it's a candidate, not a rule." : ""}`,
      header: p.box,
      options: [
        { label: "Approve", description: `${approve}. Claude Code asks you to confirm once more.`, preview },
        { label: "Reject", description: reject, preview },
        { label: "Decide later", description: p.kind === "new" ? "It stays a candidate, and nothing enforces it" : "The rule stays as it is for now" },
      ],
    };
  });
  return [
    `Now ask the person whether to approve ${ask.length === 1 ? "it" : "them"}, ${PICKER_ASK}. Don't ask in a chat message, and never approve or reject a change yourself.`,
    "AskUserQuestion input:",
    pickerInput(questions),
    "",
    "Then, for each answer, run its command on its own (nothing before or after it):",
    ...ask.flatMap((p) => [
      `  ${p.box} "Approve" → ${TOOL_COMMAND} approve ${p.id}   (Claude Code asks them to confirm; that yes is the approval)`,
      `  ${p.box} "Reject" → ${TOOL_COMMAND} reject ${p.id} --reason "<their reason, or: rejected when asked>"`,
    ]),
    `  "Decide later" → nothing: it stays pending, and ${TOOL_COMMAND} pending lists it.`,
    "  Something they typed instead (Other) → do what it says; a change to the text is a new proposal.",
    ...(proposals.length > ask.length ? [`${proposals.length - ask.length} more ${proposals.length - ask.length === 1 ? "is" : "are"} waiting: after these, run ${TOOL_COMMAND} pending to ask about the next ones.`] : []),
  ];
}
