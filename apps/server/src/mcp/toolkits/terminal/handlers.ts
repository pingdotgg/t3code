import {
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  TERMINAL_READ_DEFAULT_LINES,
  TERMINAL_READ_MAX_CHARACTERS,
  TERMINAL_WAIT_DEFAULT_QUIET_MS,
  TERMINAL_WAIT_DEFAULT_TIMEOUT_MS,
  TerminalToolkit,
  type TerminalCloseToolInput,
  type TerminalOpenToolInput,
  type TerminalReadToolInput,
  type TerminalWaitToolInput,
  type TerminalWriteToolInput,
} from "./tools.ts";

/**
 * Terminal tools always act on the thread the MCP credential was minted for.
 * The thread id comes from the invocation scope and is never accepted as a tool
 * parameter, so an agent cannot name its way into another thread's terminals.
 */
const requireThreadId = Effect.fn("TerminalToolkit.requireThreadId")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  return invocation.threadId;
});

/** The roster is manager-wide, so every read is narrowed to the calling thread. */
const readThreadTerminals = Effect.fn("TerminalToolkit.readThreadTerminals")(function* (
  threadId: string,
) {
  const manager = yield* TerminalManager.TerminalManager;
  const terminals = yield* manager.readAllTerminalMetadata();
  return terminals.filter((terminal) => terminal.threadId === threadId);
});

/* eslint-disable no-control-regex -- stripping PTY escape sequences means matching them */
const OSC_SEQUENCE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\u001B[@-Z\\-_]/g;
const RESIDUAL_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/**
 * Turns raw PTY scrollback into something a model can read: drops escape
 * sequences and keeps only the final text of lines the shell rewrote in place,
 * which is how spinners and progress bars would otherwise arrive.
 */
export function stripTerminalControlSequences(history: string): string {
  const withoutEscapes = history
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESCAPE, "")
    .replace(RESIDUAL_CONTROL, "");
  return withoutEscapes
    .split("\n")
    .map((line) => line.split("\r").findLast((segment) => segment.length > 0) ?? "")
    .join("\n");
}

/** Applies the line bound first, then the absolute character ceiling, keeping the newest output. */
export function boundTerminalOutput(
  history: string,
  maxLines: number,
): { readonly output: string; readonly lines: number; readonly truncated: boolean } {
  const allLines = history.split("\n");
  const keptLines = allLines.slice(-maxLines);
  const boundedByLines = keptLines.join("\n");
  const output =
    boundedByLines.length > TERMINAL_READ_MAX_CHARACTERS
      ? boundedByLines.slice(-TERMINAL_READ_MAX_CHARACTERS)
      : boundedByLines;
  return {
    output,
    lines: output.length === 0 ? 0 : output.split("\n").length,
    truncated: keptLines.length < allLines.length || output.length < boundedByLines.length,
  };
}

const applyMetadataEvent = (
  event: TerminalMetadataStreamEvent,
  threadId: string,
  terminalId: string,
): TerminalSummary | null => {
  switch (event.type) {
    case "snapshot":
      return (
        event.terminals.find(
          (terminal) => terminal.threadId === threadId && terminal.terminalId === terminalId,
        ) ?? null
      );
    case "upsert":
      return event.terminal;
    case "remove":
      return null;
  }
};

interface TerminalIdleOutcome {
  readonly idle: boolean;
  readonly timedOut: boolean;
  readonly terminal: TerminalSummary | null;
}

/**
 * Waits until the terminal has reported no running subprocess for `quietMs`.
 * The quiet window is driven purely by metadata events, so a command whose
 * subprocess the manager has not polled yet still resets it, and a terminal
 * that was closed while waiting counts as idle.
 */
const waitForTerminalIdle = Effect.fn("TerminalToolkit.waitForTerminalIdle")(function* (
  threadId: string,
  terminalId: string,
  timeoutMs: number,
  quietMs: number,
): Effect.fn.Return<
  TerminalIdleOutcome,
  TerminalSessionLookupError,
  TerminalManager.TerminalManager
> {
  const manager = yield* TerminalManager.TerminalManager;
  const events = yield* Queue.unbounded<TerminalMetadataStreamEvent>();
  const unsubscribe = yield* manager.subscribeMetadata((event) => {
    const matches =
      event.type === "snapshot" ||
      (event.type === "upsert"
        ? event.terminal.threadId === threadId && event.terminal.terminalId === terminalId
        : event.threadId === threadId && event.terminalId === terminalId);
    return matches ? Effect.asVoid(Queue.offer(events, event)) : Effect.void;
  });

  const wait = Effect.gen(function* () {
    // Seeded after subscribing, so no transition falls between the two.
    const seed = yield* manager.readTerminalMetadata({ threadId, terminalId });
    if (!seed) {
      return yield* new TerminalSessionLookupError({ threadId, terminalId });
    }
    const latest = yield* Ref.make<TerminalSummary | null>(seed);

    // A quiet window only settles the wait while nothing is running; with a
    // subprocess still alive it just goes back to waiting for the next event.
    const settle = Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(events).pipe(Effect.timeoutOption(quietMs));
        if (Option.isNone(next)) {
          const terminal = yield* Ref.get(latest);
          if (terminal?.hasRunningSubprocess !== true) return;
          continue;
        }
        yield* Ref.set(latest, applyMetadataEvent(next.value, threadId, terminalId));
      }
    });

    const settled = yield* settle.pipe(Effect.timeoutOption(timeoutMs));
    return {
      idle: Option.isSome(settled),
      timedOut: Option.isNone(settled),
      terminal: yield* Ref.get(latest),
    };
  });

  return yield* wait.pipe(Effect.ensuring(Effect.sync(unsubscribe)));
});

export const terminalToolkitHandlers = {
  terminal_open: Effect.fn("TerminalToolkit.terminal_open")(function* (
    input: TerminalOpenToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const options = {
      threadId,
      cwd: input.cwd,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.cols === undefined ? {} : { cols: input.cols }),
      ...(input.rows === undefined ? {} : { rows: input.rows }),
    };
    // Allocating an id here would race a concurrent open: both callers would pick
    // the same free id and the second would silently reattach to the first
    // session. `openNewTerminal` allocates under the manager's thread lock.
    const snapshot =
      input.terminalId === undefined
        ? yield* manager.openNewTerminal(options)
        : yield* manager.open({ ...options, terminalId: input.terminalId });
    const terminalId = snapshot.terminalId;
    // `open` leaves the session in the roster; only a concurrent close can lose it.
    const terminal = yield* manager.readTerminalMetadata({ threadId, terminalId });
    if (!terminal) {
      return yield* new TerminalSessionLookupError({ threadId, terminalId });
    }
    return { terminalId, terminal };
  }),

  terminal_write: Effect.fn("TerminalToolkit.terminal_write")(function* (
    input: TerminalWriteToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const endsWithNewline = input.data.endsWith("\n") || input.data.endsWith("\r");
    const submit = input.submit ?? true;
    const data = submit && !endsWithNewline ? `${input.data}\r` : input.data;
    // `TerminalManager.write` is a deliberate no-op once a session has exited, so
    // writing blind would report success for input that reached no shell.
    const before = yield* manager.readTerminalMetadata({
      threadId,
      terminalId: input.terminalId,
    });
    if (!before) {
      return yield* new TerminalSessionLookupError({ threadId, terminalId: input.terminalId });
    }
    if (before.status !== "running") {
      return yield* new TerminalNotRunningError({ threadId, terminalId: input.terminalId });
    }
    yield* manager.write({ threadId, terminalId: input.terminalId, data });
    return { terminalId: input.terminalId, submitted: submit || endsWithNewline };
  }),

  terminal_read: Effect.fn("TerminalToolkit.terminal_read")(function* (
    input: TerminalReadToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const terminalId = input.terminalId;
    const snapshot = yield* manager.readTerminalSnapshot({ threadId, terminalId });
    if (!snapshot) {
      return yield* new TerminalSessionLookupError({ threadId, terminalId });
    }
    const terminal = yield* manager.readTerminalMetadata({ threadId, terminalId });
    const history =
      input.stripAnsi === false
        ? snapshot.history
        : stripTerminalControlSequences(snapshot.history);
    return {
      terminalId,
      status: snapshot.status,
      hasRunningSubprocess: terminal?.hasRunningSubprocess ?? false,
      ...boundTerminalOutput(history, input.lines ?? TERMINAL_READ_DEFAULT_LINES),
    };
  }),

  terminal_list: Effect.fn("TerminalToolkit.terminal_list")(function* () {
    const threadId = yield* requireThreadId();
    return { terminals: yield* readThreadTerminals(threadId) };
  }),

  terminal_wait: Effect.fn("TerminalToolkit.terminal_wait")(function* (
    input: TerminalWaitToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const outcome = yield* waitForTerminalIdle(
      threadId,
      input.terminalId,
      input.timeoutMs ?? TERMINAL_WAIT_DEFAULT_TIMEOUT_MS,
      input.quietMs ?? TERMINAL_WAIT_DEFAULT_QUIET_MS,
    );
    return { terminalId: input.terminalId, ...outcome };
  }),

  terminal_close: Effect.fn("TerminalToolkit.terminal_close")(function* (
    input: TerminalCloseToolInput,
  ) {
    const threadId = yield* requireThreadId();
    const manager = yield* TerminalManager.TerminalManager;
    const terminal = yield* manager.readTerminalMetadata({
      threadId,
      terminalId: input.terminalId,
    });
    if (!terminal) {
      return { terminalId: input.terminalId, closed: false };
    }
    yield* manager.close({
      threadId,
      terminalId: input.terminalId,
      ...(input.deleteHistory === undefined ? {} : { deleteHistory: input.deleteHistory }),
    });
    return { terminalId: input.terminalId, closed: true };
  }),
} satisfies Parameters<typeof TerminalToolkit.toLayer>[0];

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer(terminalToolkitHandlers);
