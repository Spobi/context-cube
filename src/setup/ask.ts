import { createInterface } from "node:readline/promises";

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
 * background part of a build prints to a log).
 */
export function needsAnswerMessage(e: NeedsAnswer, rerun = "the same command"): string[] {
  const options = e.kind === "confirm" ? " (yes / no)" : e.kind === "choose" ? ` (${e.choices.join(" / ")})` : "";
  return [
    "",
    "WAITING FOR THE PERSON'S ANSWER. This is running without a terminal, so its questions go to the person through you, one at a time.",
    ...(e.problem ? [`(${e.problem})`] : []),
    "",
    `  ${e.question}${options}`,
    "",
    "Show the person this question, with what was printed above it that it's about, and ask them. Don't answer it for them.",
    `Then run ${rerun} again, adding: --answer ${e.key}=<their answer>${e.kind === "text" ? ` (quote it if it has spaces; for no answer: --answer ${e.key}=)` : ""}`,
    "Everything done so far is saved, so it carries on from here.",
  ];
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
    const a = answers.get(key)!;
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
