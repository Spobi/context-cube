import { createInterface } from "node:readline/promises";
import { inClaudeCode, PICKER_ASK, pickerInput } from "../adapters/claude-code/picker";

/**
 * Questions for a person. Every question has a default. With --yes, the
 * default is used and said out loud. With no terminal to ask in and no --yes
 * (an agent ran the command, say in the Claude desktop app), questions that
 * need the person's own say have a key: the run stops at the first one, prints
 * it, and the question goes to the person through the agent. Running the
 * command again with `--answer <key>=<answer>` carries on from there; the
 * build saves its place, so nothing is done twice. Questions without a key
 * take their default, said out loud, as with --yes.
 */
export interface Asker {
  interactive: boolean;
  /** No terminal and no --yes: keyed questions stop the run and go to the person through the agent. */
  relay?: boolean;
  say(text: string): void;
  confirm(question: string, def?: boolean, key?: string): Promise<boolean>;
  choose(question: string, choices: string[], def: string, key?: string): Promise<string>;
  text(question: string, def: string, key?: string): Promise<string>;
}

/** A keyed question with no answer yet, in a run without a terminal. */
export class NeedsAnswer extends Error {
  constructor(
    public key: string,
    public question: string,
    public kind: "confirm" | "choose" | "text",
    public choices: string[] = [],
    public problem?: string,
  ) {
    super(`Waiting for the person's answer to: ${question}`);
  }
}

/**
 * What an agent is told when a run stops for an answer. `rerun` names the
 * command to run again, when it isn't the one that printed this (the
 * background part of a build prints to a log). In Claude Code, the question
 * comes ready for its question box, so it pops up for the person.
 */
export function needsAnswerMessage(e: NeedsAnswer, rerun = "the same command", picker = inClaudeCode()): string[] {
  const options = e.kind === "confirm" ? " (yes / no)" : e.kind === "choose" ? ` (${e.choices.join(" / ")})` : "";
  const head = [
    "",
    "WAITING FOR THE PERSON'S ANSWER. This is running without a terminal, so its questions go to the person through you, one at a time.",
    ...(e.problem ? [`(${e.problem})`] : []),
    "",
    `  ${e.question.trim()}${options}`,
    "",
  ];
  const picks = picker ? pickerAnswers(e) : undefined;
  if (picks) {
    const typed =
      e.kind === "confirm" ? "the answer it means: yes or no" : e.kind === "choose" ? `the answer it means: ${e.choices.join(", ")}` : `--answer ${e.key}=<what they typed> (quote it if it has spaces)`;
    return [
      ...head,
      `Ask the person ${PICKER_ASK}. Don't ask it in a chat message, and don't answer it for them. In your message just before it, show them what was printed above that the question is about.`,
      "AskUserQuestion input:",
      pickerInput([{ question: e.question.trim(), header: picks.header, options: picks.answers }]),
      "",
      `Then run ${rerun} again, adding the answer for their pick:`,
      ...picks.answers.map((a) => `  "${a.label}" → ${a.followUp ?? `--answer ${e.key}=${a.answer}`}`),
      `  Something they typed instead (Other) → ${typed}`,
      "Everything done so far is saved, so it carries on from here.",
    ];
  }
  return [
    ...head,
    "Show the person this question, with what was printed above it that it's about, and ask them. Don't answer it for them.",
    `Then run ${rerun} again, adding: --answer ${e.key}=<their answer>${e.kind === "text" ? ` (quote it if it has spaces; for no answer: --answer ${e.key}=)` : ""}`,
    "Everything done so far is saved, so it carries on from here.",
  ];
}

/** One answer in the question box. `followUp`: what to do instead of answering at once (ask for the details first). */
interface PickAnswer {
  answer: string;
  label: string;
  description: string;
  followUp?: string;
}

/**
 * How each keyed question shows in Claude Code's question box: a short header,
 * and what each answer means. A question has only the answers its kind allows
 * (yes and no for a confirm, its choices for a choose). "(Recommended)" marks
 * an answer only where the tool advises it, never one that spends usage.
 */
const PICKS: Record<string, { header: string; answers: PickAnswer[]; recommended?: string }> = {
  "read-sample": {
    header: "Read sample",
    answers: [
      { answer: "yes", label: "Read them", description: "Spend the tokens shown above to see what each file holds" },
      { answer: "no", label: "Stop here", description: "Nothing is spent; run it again when you're ready" },
    ],
  },
  "use-files": {
    header: "Files",
    answers: [
      { answer: "yes", label: "Use them all", description: "Build the cube from every file listed above" },
      { answer: "no", label: "Choose each", description: "Ask about each file in turn" },
    ],
  },
  "use:": {
    header: "Use file",
    answers: [
      { answer: "yes", label: "Use it", description: "Its text goes into the cube" },
      { answer: "no", label: "Leave it out", description: "The cube doesn't use it, and the file stays as it is" },
    ],
  },
  "go-ahead": {
    header: "Go ahead",
    answers: [
      { answer: "now", label: "Now", description: "Start now, using about the usage estimated above" },
      { answer: "yes", label: "Go ahead", description: "Start now, using about the usage estimated above" },
      { answer: "later", label: "Later", description: "The steps before your row review run now; the rest starts at a time you pick" },
      { answer: "no", label: "Stop", description: "Nothing more is spent; run it again when you're ready" },
    ],
  },
  "start-at": {
    header: "Start time",
    answers: [
      { answer: "11:30pm", label: "11:30pm", description: "The next 11:30pm" },
      { answer: "7am", label: "7am", description: "The next 7am" },
    ],
  },
  "rules-as-notes": {
    header: "Rules",
    recommended: "yes",
    answers: [
      { answer: "yes", label: "File as notes", description: "They load only when a task needs them" },
      { answer: "no", label: "Keep as rules", description: "They load into every session" },
    ],
  },
  rows: {
    header: "Rows",
    answers: [
      { answer: "accept", label: "Accept", description: "Build the cube with these rows" },
      { answer: "redo", label: "Redo", description: "Propose the rows again; you'll say what should change" },
      { answer: "edit", label: "Edit the file", description: "Stop so you can edit the proposal file yourself, then run it again" },
    ],
  },
  "rows-feedback": {
    header: "Row changes",
    answers: [
      { answer: '"Fewer, broader rows: merge related areas."', label: "Fewer, broader rows", description: "Merge related areas into one row" },
      { answer: '"More, narrower rows: split big areas apart."', label: "More, narrower rows", description: "Split big areas into rows of their own" },
    ],
  },
  "add-rules": {
    header: "First rules",
    answers: [
      { answer: "yes", label: "Add them", description: "They load into every session" },
      { answer: "no", label: "Skip them", description: "Start with no rules; add any later" },
    ],
  },
  "spot-check": {
    header: "Spot check",
    answers: [
      { answer: "", label: "All look right", description: "Every summary, read-when line, and link matched its text" },
      { answer: "", label: "Some look wrong", description: "You'll say which ones", followUp: 'ask which ids look wrong, then --answer spot-check="<the ids, separated by spaces>"' },
    ],
  },
  "rewrite-rules": {
    header: "Rewrite",
    recommended: "yes",
    answers: [
      { answer: "yes", label: "Rewrite them", description: "They point at the cube; the original words stay in the cube" },
      { answer: "no", label: "Leave them", description: "They keep pointing at the archived files" },
    ],
  },
  "start-late": {
    header: "Late start",
    answers: [
      { answer: "yes", label: "Start now", description: "Uses your plan's usage now" },
      { answer: "no", label: "Don't start", description: "Nothing runs; run the command again when you're ready" },
    ],
  },
};

/** The question box's header and answers for a question, or undefined to ask it in the chat (a typed answer with nothing to pick). */
function pickerAnswers(e: NeedsAnswer): { header: string; answers: PickAnswer[] } | undefined {
  const pick = PICKS[e.key] ?? PICKS[e.key.replace(/:.*$/, ":")];
  const allowed = e.kind === "confirm" ? ["yes", "no"] : e.kind === "choose" ? e.choices : undefined;
  let answers = pick?.answers.filter((a) => !allowed || allowed.includes(a.answer)) ?? [];
  if (!pick || (allowed && answers.length < allowed.length)) {
    if (!allowed) return undefined;
    answers = allowed.map((a) => ({ answer: a, label: a[0].toUpperCase() + a.slice(1), description: `Answer ${a}` }));
  }
  if (answers.length < 2 || answers.length > 4) return undefined;
  // The recommended answer goes first, labeled the way Claude Code's question box expects.
  const rec = answers.find((a) => a.answer === pick?.recommended);
  if (rec) answers = [{ ...rec, label: `${rec.label} (Recommended)` }, ...answers.filter((a) => a !== rec)];
  return { header: pick?.header ?? e.key, answers };
}

/** Parses `--answer key=value` options. */
export function parseAnswers(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i < 1) throw new Error(`"--answer ${item}" needs the form --answer <key>=<answer>.`);
    out[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return out;
}

const YES = /^(y|yes|true|ok|sure)$/i;
const NO = /^(n|no|false)$/i;

export function terminalAsker(opts: { yes?: boolean; answers?: Record<string, string>; relay?: boolean; say?: (t: string) => void } = {}): Asker {
  const interactive = !opts.yes && !opts.relay && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const relay = opts.relay ?? (!opts.yes && !interactive);
  const answers = new Map(Object.entries(opts.answers ?? {}));
  const say = opts.say ?? ((t: string) => console.log(t));
  async function ask(q: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  }
  /** The person's answer, given with --answer; each is used once. Undefined: use the default. */
  function relayed(key: string | undefined, question: string, kind: NeedsAnswer["kind"], choices: string[] = []): string | undefined {
    if (!relay || !key) return undefined;
    if (!answers.has(key)) throw new NeedsAnswer(key, question, kind, choices);
    // An answer copied from Claude Code's question box may keep its label's "(Recommended)".
    const a = answers.get(key)!.replace(/\s*\(recommended\)\s*$/i, "");
    answers.delete(key);
    say(`${question} ${a || "(no answer)"} (the person's answer)`);
    return a;
  }
  return {
    interactive,
    relay,
    say,
    async confirm(question, def = true, key) {
      if (!interactive) {
        const a = relayed(key, question, "confirm");
        if (a !== undefined) {
          if (YES.test(a)) return true;
          if (NO.test(a)) return false;
          throw new NeedsAnswer(key!, question, "confirm", [], `"${a}" isn't yes or no`);
        }
        say(`${question} ${def ? "yes" : "no"} (default)`);
        return def;
      }
      const a = (await ask(`${question} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
      if (!a) return def;
      return a.startsWith("y");
    },
    async choose(question, choices, def, key) {
      if (!interactive) {
        const a = relayed(key, question, "choose", choices);
        if (a !== undefined) {
          const hit = pick(choices, a);
          if (hit) return hit;
          throw new NeedsAnswer(key!, question, "choose", choices, `"${a}" isn't one of the choices`);
        }
        say(`${question} ${def} (default)`);
        return def;
      }
      const a = await ask(`${question} (${choices.map((c) => (c === def ? `[${c}]` : c)).join(" / ")}) `);
      if (!a) return def;
      return pick(choices, a) ?? def;
    },
    async text(question, def, key) {
      if (!interactive) {
        const a = relayed(key, question, "text");
        if (a !== undefined) return a || def;
        say(`${question} ${def || "(none)"} (default)`);
        return def;
      }
      const a = await ask(`${question}${def ? ` [${def}]` : ""} `);
      return a || def;
    },
  };
}

function pick(choices: string[], a: string): string | undefined {
  if (!a) return undefined;
  return choices.find((c) => c.toLowerCase() === a.toLowerCase()) ?? choices.find((c) => c.toLowerCase().startsWith(a.toLowerCase()));
}

/** A scripted asker for tests: answers from a list, then defaults. */
export function scriptedAsker(answers: Record<string, string | boolean> = {}, log: string[] = []): Asker {
  const find = (q: string) => Object.entries(answers).find(([k]) => q.includes(k))?.[1];
  return {
    interactive: false,
    say: (t) => log.push(t),
    async confirm(q, def = true) {
      log.push(`? ${q}`);
      const a = find(q);
      return a === undefined ? def : a === true || a === "yes" || a === "y";
    },
    async choose(q, _choices, def) {
      log.push(`? ${q}`);
      const a = find(q);
      return typeof a === "string" ? a : def;
    },
    async text(q, def) {
      log.push(`? ${q}`);
      const a = find(q);
      return typeof a === "string" ? a : def;
    },
  };
}

/**
 * A relaying asker for tests: like a run with no terminal, it stops at keyed
 * questions without an answer. `answers` are keyed like --answer.
 */
export function relayAsker(answers: Record<string, string> = {}, log: string[] = []): Asker {
  return terminalAsker({ answers, relay: true, say: (t) => log.push(t) });
}
