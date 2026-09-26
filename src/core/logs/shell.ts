/**
 * A small shell-command splitter, just enough to recognize file reads such as
 * `cat a.md`, `head -n 40 notes.md`, `sed -n '10,20p' f | cat`, `cd x && tail f`.
 * It is not a full shell parser; anything it can't read is ignored.
 */

export type Separator = "|" | "&&" | "||" | ";" | "\n";

export interface ShellPart {
  words: string[];
  /** The separator that follows this command (undefined for the last one). */
  next?: Separator;
}

/** Splits a command line into simple commands, respecting quotes. */
export function splitCommand(command: string): ShellPart[] | undefined {
  const parts: ShellPart[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const pushWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const pushPart = (next?: Separator) => {
    pushWord();
    if (words.length) parts.push({ words, next });
    words = [];
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) {
          buf += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === "$" || command[j] === "`") return undefined; // expansions: give up
        buf += command[j];
        j++;
      }
      if (j >= command.length) return undefined;
      word += buf;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      pushWord();
      i++;
      continue;
    }
    if (c === "\n") {
      pushPart("\n");
      i++;
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      pushPart("&&");
      i += 2;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      pushPart("||");
      i += 2;
      continue;
    }
    if (c === "|") {
      pushPart("|");
      i++;
      continue;
    }
    if (c === ";") {
      pushPart(";");
      i++;
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "<" || c === ">" || c === "&") {
      // Subshells, expansions, and redirections: too complex to attribute reliably.
      // Allow the common `2>/dev/null` and `2>&1` forms.
      const rest = command.slice(i);
      if (inWord && word === "2" && c === ">") {
        const m2 = /^>(?:\/dev\/null|&1)/.exec(rest);
        if (m2) {
          word = "";
          inWord = false;
          i += m2[0].length;
          continue;
        }
      }
      const m = /^(?:>\/dev\/null|&>\/dev\/null)/.exec(rest);
      if (m) {
        i += m[0].length;
        continue;
      }
      return undefined;
    }
    word += c;
    inWord = true;
    i++;
  }
  pushPart();
  return parts;
}
