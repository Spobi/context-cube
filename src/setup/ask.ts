import { createInterface } from "node:readline/promises";

/**
 * Questions for a person. Every question has a default; with --yes, or when
 * there's no terminal to ask in, the default is used and said out loud.
 */
export interface Asker {
  interactive: boolean;
  say(text: string): void;
  confirm(question: string, def?: boolean): Promise<boolean>;
  choose(question: string, choices: string[], def: string): Promise<string>;
  text(question: string, def: string): Promise<string>;
}

export function terminalAsker(opts: { yes?: boolean } = {}): Asker {
  const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const say = (t: string) => console.log(t);
  async function ask(q: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  }
  return {
    interactive,
    say,
    async confirm(question, def = true) {
      if (!interactive) {
        say(`${question} ${def ? "yes" : "no"} (default)`);
        return def;
      }
      const a = (await ask(`${question} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
      if (!a) return def;
      return a.startsWith("y");
    },
    async choose(question, choices, def) {
      if (!interactive) {
        say(`${question} ${def} (default)`);
        return def;
      }
      const a = await ask(`${question} (${choices.map((c) => (c === def ? `[${c}]` : c)).join(" / ")}) `);
      if (!a) return def;
      const hit = choices.find((c) => c.toLowerCase() === a.toLowerCase()) ?? choices.find((c) => c.toLowerCase().startsWith(a.toLowerCase()));
      return hit ?? def;
    },
    async text(question, def) {
      if (!interactive) {
        say(`${question} ${def || "(none)"} (default)`);
        return def;
      }
      const a = await ask(`${question}${def ? ` [${def}]` : ""} `);
      return a || def;
    },
  };
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
