import { spawn } from "node:child_process";
import type { Asker } from "../../setup/ask";

/**
 * Starting the big part of a build later, say overnight after the person's
 * plan usage resets. The process stays open and waits; nothing is added to
 * the system's scheduler. While it runs unattended, questions get their
 * defaults, and a usage limit means waiting for the reset instead of stopping,
 * up to a cut-off so it doesn't run into the person's day.
 */

/** No new work starts more than this long after the chosen time. */
export const WINDOW_MS = 8 * 3600_000;
/** Starting later than this after the chosen time (the computer slept) needs a yes. */
export const LATE_MS = 3600_000;
/** When a limit's message doesn't say when it resets, try again after this long. */
export const RETRY_MS = 20 * 60_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Keeps the computer from sleeping on its own; returns a function that stops. */
  keepAwake?(): (() => void) | undefined;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keepAwake: () => {
    // macOS only. `-w` ends it with this process, even if the process crashes.
    if (process.platform !== "darwin") return undefined;
    try {
      const child = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return () => {
        child.kill();
      };
    } catch {
      return undefined;
    }
  },
};

export interface Schedule {
  /** When the unattended part starts. */
  at: Date;
  /** Nothing new starts after this. */
  until: Date;
  clock: Clock;
  state: "waiting" | "running" | "done";
  /** The person's asker, while a stand-in answers for them. */
  person?: Asker;
  stopAwake?: () => void;
}

export function makeSchedule(at: Date, clock: Clock = realClock): Schedule {
  return { at, until: new Date(at.getTime() + WINDOW_MS), clock, state: "waiting" };
}

/** "23:30", "11:30pm", "11 pm", "7am", "2330": the next time the clock shows it. */
export function parseClock(text: string, now: Date): Date | undefined {
  const m = /^\s*(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?\s*$/i.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (min > 59) return undefined;
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (h > 23) return undefined;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * When a usage limit resets, if Claude Code's message says: a Unix time after
 * "|", "resets in 2h 15m", or "resets 4am". Undefined when it doesn't say.
 */
export function resetTime(message: string, now: Date): Date | undefined {
  const unix = /\|\s*(\d{10})\b/.exec(message);
  if (unix) return new Date(Number(unix[1]) * 1000);
  const inM = /resets?\s+in\s+(?:(\d+)\s*h\w*)?\s*(?:(\d+)\s*m\w*)?/i.exec(message);
  if (inM && (inM[1] || inM[2])) return new Date(now.getTime() + (Number(inM[1] ?? 0) * 60 + Number(inM[2] ?? 0)) * 60_000);
  const at = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)(?![\w/])/i.exec(message);
  const t = at ? parseClock(at[1], now) : undefined;
  // A clock time that just passed reads as tomorrow; it means now.
  if (t && t.getTime() - now.getTime() > 20 * 3600_000) return now;
  return t;
}

/** When to try again after a limit, or undefined when that's past the cut-off. */
export function resumeAt(s: Schedule, message: string): { at: Date; reset?: Date } | undefined {
  const now = new Date(s.clock.now());
  const reset = resetTime(message, now);
  const at = reset && reset > now ? new Date(reset.getTime() + 60_000) : new Date(now.getTime() + RETRY_MS);
  return at <= s.until ? { at, reset } : undefined;
}

/** Sleeps in short steps, so a computer that slept wakes up on time rather than late. */
export async function sleepUntil(clock: Clock, t: Date): Promise<void> {
  for (let left = t.getTime() - clock.now(); left > 0; left = t.getTime() - clock.now()) await clock.sleep(Math.min(60_000, left));
}

/** "11:30 PM", with "tomorrow" when it isn't the same day as `now`. */
export function fmtClock(d: Date, now?: Date): string {
  const h = d.getHours();
  const t = `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return now && d.toDateString() !== now.toDateString() && d > now ? `${t} tomorrow` : t;
}

/** "4 h 10 min", "25 min". */
export function fmtWait(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}

/** Stands in for the person while they're away: every question gets its default, said out loud. */
export function awayAsker(person: Asker): Asker {
  const note = (q: string, a: string) => person.say(`${q} ${a} (the default, since you're away)`);
  return {
    interactive: false,
    say: (t) => person.say(t),
    async confirm(q, def = true) {
      note(q, def ? "yes" : "no");
      return def;
    },
    async choose(q, _choices, def) {
      note(q, def);
      return def;
    },
    async text(q, def) {
      note(q, def || "(none)");
      return def;
    },
  };
}

/**
 * Waits for the chosen time. Returns false when the start came much later than
 * chosen (the computer was asleep) and the person, asked, said not to start.
 */
export async function waitForStart(s: Schedule, ask: Asker): Promise<boolean> {
  const now = new Date(s.clock.now());
  if (now < s.at) {
    s.stopAwake = s.clock.keepAwake?.();
    // Relaying (no terminal), this is the background process.
    const bg = !!ask.relay;
    ask.say(`\nThe rest starts at ${fmtClock(s.at, now)} (in ${fmtWait(s.at.getTime() - now.getTime())}). Until then ${bg ? "this waits in the background" : "this terminal waits"}:`);
    ask.say(`  • ${bg ? "Leave" : "Leave it open, and leave"} the computer on and plugged in. Nothing runs while it's asleep, so don't close the lid.${s.stopAwake ? " It's kept from going to sleep on its own." : ""}`);
    ask.say(`  • A question that comes up while you're away gets its default answer, printed ${bg ? "in the log" : "here"}. The spot check at the end waits for you.`);
    ask.say(`  • If your plan hits its usage limit, it waits for the reset and keeps going, but starts nothing new after ${fmtClock(s.until)}.`);
    if (!bg) ask.say("  • Ctrl+C cancels. The build keeps its place: run the command again to finish it now, or add --at <time> to wait again.");
    await sleepUntil(s.clock, s.at);
  }
  const started = new Date(s.clock.now());
  if (started.getTime() - s.at.getTime() > LATE_MS) {
    const ok = await ask.confirm(`It's ${fmtClock(started)}. The rest was set to start at ${fmtClock(s.at)}, but couldn't (the computer was probably asleep). Start it now? It uses your plan's usage now.`, false, "start-late");
    if (!ok) {
      s.stopAwake?.();
      return false;
    }
  }
  ask.say(`\nStarting the rest of the build (${fmtClock(started)}).`);
  return true;
}
