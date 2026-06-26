import type {
  EnvironmentApi,
  ProjectScript,
  TerminalAttachStreamEvent,
  TerminalOpenInput,
  TerminalSummary,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { subscribe } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const ACTION_TERMINAL_ID_PREFIX = "action-";
const ACTION_TERMINAL_FALLBACK_SEPARATOR = ":";
const ACTION_TERMINAL_READY_TIMEOUT_MS = 4_000;
const MAX_TERMINAL_BUFFER_TAIL = 2_000;
const PROMPT_LINE_MAX_LENGTH = 180;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const OSC_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][\\s\\S]*?(?:${String.fromCharCode(7)}|${ESCAPE_CHARACTER}\\\\)`,
  "g",
);
const BELL_CHARACTER = String.fromCharCode(7);
const SHELL_LABELS = new Set(["bash", "zsh", "sh", "fish", "csh", "tcsh", "pwsh", "powershell"]);
const UNIX_PERCENT_PROGRESS_SUFFIX_PATTERN = /\d\s+%\s*$/;
const UNIX_PROMPT_SUFFIX_PATTERN = /(?:[$#]|(?:^|[^\d])%)\s*$/;
const POWERSHELL_PROMPT_PATTERN = /^PS\s+\S.*>\s*$/;
const WINDOWS_PROMPT_PATTERN = /^[A-Za-z]:(?:[\\/][^<>]*)?>\s*$/;

export class ProjectActionTerminalReadinessTimeoutError extends Schema.TaggedErrorClass<ProjectActionTerminalReadinessTimeoutError>()(
  "ProjectActionTerminalReadinessTimeoutError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    cwd: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Timed out waiting for project action terminal input readiness: ${this.threadId}/${this.terminalId}.`;
  }
}

export class ProjectActionTerminalAttachError extends Schema.TaggedErrorClass<ProjectActionTerminalAttachError>()(
  "ProjectActionTerminalAttachError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project action terminal attach failed: ${this.detail}`;
  }
}

export const ProjectActionTerminalReadinessError = Schema.Union([
  ProjectActionTerminalReadinessTimeoutError,
  ProjectActionTerminalAttachError,
]);
export type ProjectActionTerminalReadinessError = typeof ProjectActionTerminalReadinessError.Type;

function projectActionTerminalIdBase(scriptId: ProjectScript["id"]): string {
  return `${ACTION_TERMINAL_ID_PREFIX}${encodeURIComponent(scriptId)}`;
}

function isProjectActionTerminalFallbackId(terminalId: string, baseTerminalId: string): boolean {
  const suffix = terminalId.startsWith(`${baseTerminalId}${ACTION_TERMINAL_FALLBACK_SEPARATOR}`)
    ? terminalId.slice(baseTerminalId.length + ACTION_TERMINAL_FALLBACK_SEPARATOR.length)
    : "";
  return /^[1-9][0-9]*$/.test(suffix);
}

export function isProjectActionTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(ACTION_TERMINAL_ID_PREFIX);
}

export function projectActionTerminalId(scriptId: ProjectScript["id"], suffix?: number): string {
  const base = projectActionTerminalIdBase(scriptId);
  return suffix === undefined ? base : `${base}${ACTION_TERMINAL_FALLBACK_SEPARATOR}${suffix}`;
}

export function resolveProjectActionTerminalId(input: {
  readonly scriptId: ProjectScript["id"];
  readonly terminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string {
  const busyTerminalIds = new Set(input.runningTerminalIds);
  const baseTerminalId = projectActionTerminalId(input.scriptId);
  if (!busyTerminalIds.has(baseTerminalId)) {
    return baseTerminalId;
  }

  const idleActionTerminal = input.terminalIds.find(
    (terminalId) =>
      (terminalId === baseTerminalId ||
        isProjectActionTerminalFallbackId(terminalId, baseTerminalId)) &&
      !busyTerminalIds.has(terminalId),
  );
  if (idleActionTerminal) {
    return idleActionTerminal;
  }

  const takenTerminalIds = new Set(input.terminalIds);
  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = projectActionTerminalId(input.scriptId, suffix);
    if (!takenTerminalIds.has(candidate)) {
      return candidate;
    }
    suffix += 1;
  }

  return projectActionTerminalId(input.scriptId, Date.now());
}

function stripAnsi(value: string): string {
  return value.replace(OSC_ESCAPE_PATTERN, "").replace(ANSI_ESCAPE_PATTERN, "");
}

function stripControlCharacters(value: string): string {
  let next = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\n" || char === "\r" || code >= 32) {
      next += char;
    }
  }
  return next;
}

export function terminalOutputLooksReadyForInput(value: string): boolean {
  const tail = stripControlCharacters(stripAnsi(value))
    .slice(-MAX_TERMINAL_BUFFER_TAIL)
    .replaceAll(BELL_CHARACTER, "");
  const lines = tail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\r/g, "") ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (line.length > PROMPT_LINE_MAX_LENGTH) {
      return false;
    }
    if (UNIX_PROMPT_SUFFIX_PATTERN.test(line) && !UNIX_PERCENT_PROGRESS_SUFFIX_PATTERN.test(line)) {
      return true;
    }
    return POWERSHELL_PROMPT_PATTERN.test(line) || WINDOWS_PROMPT_PATTERN.test(line);
  }
  return false;
}

function normalizedShellLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  const basename = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
  return basename.replace(/^-+/, "");
}

export function terminalSessionIsReadyForProjectActionInput(input: {
  readonly summary: Pick<
    TerminalSummary,
    "cwd" | "hasRunningSubprocess" | "label" | "status" | "worktreePath"
  > | null;
  readonly buffer: string;
  readonly targetCwd: string;
  readonly targetWorktreePath: string | null;
}): boolean {
  const summary = input.summary;
  if (
    !summary ||
    summary.status !== "running" ||
    summary.cwd !== input.targetCwd ||
    summary.worktreePath !== input.targetWorktreePath
  ) {
    return false;
  }
  if (!summary.hasRunningSubprocess || SHELL_LABELS.has(normalizedShellLabel(summary.label))) {
    return terminalOutputLooksReadyForInput(input.buffer);
  }
  return false;
}

function terminalAttachInputFromOpenInput(input: TerminalOpenInput) {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    restartIfNotRunning: true,
  };
}

function terminalAttachEventCompletesReadyWait(
  event: TerminalAttachStreamEvent,
  appendAndCheck: (data: string) => boolean,
): boolean {
  if (event.type === "snapshot") {
    return appendAndCheck(event.snapshot.history);
  }
  if (event.type === "output") {
    return appendAndCheck(event.data);
  }
  return event.type === "error";
}

export function projectActionTerminalReadinessFailureFromEvent(
  input: TerminalOpenInput,
  event: TerminalAttachStreamEvent,
): ProjectActionTerminalAttachError | null {
  if (event.type === "error") {
    return new ProjectActionTerminalAttachError({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      detail: event.message,
    });
  }
  if (event.type === "closed") {
    return new ProjectActionTerminalAttachError({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      detail: "Terminal closed before it was ready for input.",
    });
  }
  if (event.type === "exited") {
    return new ProjectActionTerminalAttachError({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      detail: "Terminal process exited before it was ready for input.",
    });
  }
  return null;
}

function projectActionTerminalAttachErrorFromCause(
  input: TerminalOpenInput,
  cause: Cause.Cause<unknown>,
): ProjectActionTerminalAttachError {
  return new ProjectActionTerminalAttachError({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    detail: `Terminal attach failed before it was ready for input: ${Cause.pretty(cause)}`,
  });
}

function projectActionTerminalReadinessTimeoutError(
  input: TerminalOpenInput,
  timeoutMs: number,
): ProjectActionTerminalReadinessTimeoutError {
  return new ProjectActionTerminalReadinessTimeoutError({
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    timeoutMs,
  });
}

type ProjectActionTerminalReadinessOutcome =
  | { readonly _tag: "ready" }
  | { readonly _tag: "failed"; readonly error: ProjectActionTerminalReadinessError };

export function waitForProjectActionTerminalInputReadyStrict(
  input: TerminalOpenInput,
  timeoutMs = ACTION_TERMINAL_READY_TIMEOUT_MS,
) {
  let bufferTail = "";
  const appendAndCheck = (data: string) => {
    bufferTail = `${bufferTail}${data}`.slice(-MAX_TERMINAL_BUFFER_TAIL);
    return terminalOutputLooksReadyForInput(bufferTail);
  };

  return Stream.suspend(() =>
    subscribe(WS_METHODS.terminalAttach, terminalAttachInputFromOpenInput(input)),
  ).pipe(
    Stream.catchCause((cause) =>
      Stream.fail(projectActionTerminalAttachErrorFromCause(input, cause)),
    ),
    Stream.filterMap((event) => {
      const error = projectActionTerminalReadinessFailureFromEvent(input, event);
      if (error) {
        return Result.succeed<ProjectActionTerminalReadinessOutcome>({
          _tag: "failed",
          error,
        });
      }
      return terminalAttachEventCompletesReadyWait(event, appendAndCheck)
        ? Result.succeed<ProjectActionTerminalReadinessOutcome>({ _tag: "ready" })
        : Result.failVoid;
    }),
    Stream.runHead,
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap((result) => {
      if (Option.isNone(result)) {
        return Effect.fail(projectActionTerminalReadinessTimeoutError(input, timeoutMs));
      }
      if (Option.isNone(result.value)) {
        return Effect.fail(
          new ProjectActionTerminalAttachError({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
            detail: "Terminal attach stream ended before it was ready for input.",
          }),
        );
      }
      const outcome = result.value.value;
      return outcome._tag === "failed" ? Effect.fail(outcome.error) : Effect.void;
    }),
  );
}

// The strict path exposes typed readiness failures for callers that need diagnostics;
// the best-effort path preserves the UI fallback and still writes after failures.
export function waitForProjectActionTerminalInputReady(
  input: TerminalOpenInput,
  timeoutMs = ACTION_TERMINAL_READY_TIMEOUT_MS,
) {
  return waitForProjectActionTerminalInputReadyStrict(input, timeoutMs).pipe(
    Effect.catchCause(() => Effect.void),
  );
}

export async function openTerminalAndWaitForInputReady(
  api: Pick<EnvironmentApi, "terminal">,
  input: TerminalOpenInput,
  timeoutMs = ACTION_TERMINAL_READY_TIMEOUT_MS,
): Promise<void> {
  let bufferTail = "";
  let unsubscribe: (() => void) | undefined;
  let shouldUnsubscribe = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(settle, timeoutMs);

    function cleanup() {
      if (unsubscribe) {
        const dispose = unsubscribe;
        unsubscribe = undefined;
        dispose();
      } else {
        shouldUnsubscribe = true;
      }
    }

    function settle() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    }

    function appendAndCheck(data: string) {
      bufferTail = `${bufferTail}${data}`.slice(-MAX_TERMINAL_BUFFER_TAIL);
      if (terminalOutputLooksReadyForInput(bufferTail)) {
        settle();
      }
    }

    function onEvent(event: TerminalAttachStreamEvent) {
      if (event.type === "snapshot") {
        appendAndCheck(event.snapshot.history);
        return;
      }
      if (event.type === "output") {
        appendAndCheck(event.data);
        return;
      }
      if (event.type === "closed" || event.type === "error" || event.type === "exited") {
        settle();
      }
    }

    function attach(): boolean {
      try {
        unsubscribe = api.terminal.attach(terminalAttachInputFromOpenInput(input), onEvent);
        if (shouldUnsubscribe) {
          cleanup();
        }
        return true;
      } catch {
        return false;
      }
    }

    if (!attach()) {
      void api.terminal.open(input).then(
        () => {
          if (!settled && !attach()) {
            settle();
          }
        },
        () => settle(),
      );
    }
  });
}
