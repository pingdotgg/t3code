import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { TerminalEvent } from "@t3tools/contracts";

// Line editors (zsh, fish, nu, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Longer than one subprocess poll plus its ps timeout, so a startup prompt is seen as busy first.
const SHELL_QUIET_FALLBACK = "3 seconds";

function lineEditorReading(text: string, previous: boolean): boolean {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return on === off ? previous : on > off;
}

// Input typed during shell startup can be read by an rc-file prompt (fnm, nvm) instead of the
// shell, which loses the command. Subscribe before the terminal opens so no activity is missed.
// Untraced: each caller owns the span around the wait.
export const watchShellReadiness = Effect.fnUntraced(function* (input: {
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly threadId: string;
  readonly terminalId: string;
  readonly onStartupPrompt: Effect.Effect<void>;
}) {
  const outcome = yield* Deferred.make<"ready" | "exited">();
  let reading = false;
  let carry = "";
  let busy = false;
  let activity = 0;
  const unsubscribe = yield* input.subscribe((event) => {
    if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
      return Effect.void;
    }
    activity += 1;
    // A new shell process starts idle; the manager resets its subprocess state without an event.
    if (event.type === "started" || event.type === "restarted") {
      busy = false;
      reading = false;
      carry = "";
    }
    if (event.type === "activity") busy = event.hasRunningSubprocess;
    if (event.type === "output") {
      const text = carry + event.data;
      carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
      reading = lineEditorReading(text, reading);
    }
    if (event.type === "exited" || event.type === "closed") {
      return Deferred.succeed(outcome, "exited").pipe(Effect.asVoid);
    }
    return reading ? Deferred.succeed(outcome, "ready").pipe(Effect.asVoid) : Effect.void;
  });
  // A startup prompt runs as a child process, so a busy shell keeps waiting for the user.
  const quiet = Effect.gen(function* () {
    while (true) {
      const seen = activity;
      yield* Effect.sleep(SHELL_QUIET_FALLBACK);
      if (activity !== seen) continue;
      if (!busy) return "ready" as const;
      yield* input.onStartupPrompt;
    }
  });
  // Restored history can hold a previous shell's line editor state, so only live output counts.
  const wait = Deferred.await(outcome).pipe(Effect.raceFirst(quiet));
  return { wait, unsubscribe };
});
