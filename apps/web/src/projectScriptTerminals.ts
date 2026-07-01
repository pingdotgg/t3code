import type {
  EnvironmentApi,
  ProjectScript,
  TerminalAttachStreamEvent,
  TerminalOpenInput,
  TerminalSummary,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { subscribe } from "@t3tools/client-runtime/rpc";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
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
const ACTION_TERMINAL_POST_WRITE_RESERVATION_MS = 5_000;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
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
const SHELL_LABELS = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
]);
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
    cause: Schema.optional(Schema.Defect()),
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

  const takenTerminalIds = new Set([...input.terminalIds, ...input.runningTerminalIds]);
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
  return basename.replace(/^-+/, "").replace(/\.exe$/, "");
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

export function terminalSessionShouldProbeForProjectActionInput(input: {
  readonly summary: Pick<
    TerminalSummary,
    "cwd" | "hasRunningSubprocess" | "label" | "status" | "worktreePath"
  > | null;
  readonly targetCwd: string;
  readonly targetWorktreePath: string | null;
}): boolean {
  const summary = input.summary;
  return (
    summary !== null &&
    summary.status === "running" &&
    summary.cwd === input.targetCwd &&
    summary.worktreePath === input.targetWorktreePath &&
    summary.hasRunningSubprocess &&
    SHELL_LABELS.has(normalizedShellLabel(summary.label))
  );
}

type ProjectActionTerminalCandidateSummary = Pick<
  NonNullable<KnownTerminalSession["state"]["summary"]>,
  "cwd" | "hasRunningSubprocess" | "label" | "status" | "worktreePath"
>;

export interface ProjectActionTerminalCandidateSession {
  readonly target: Pick<KnownTerminalSession["target"], "terminalId">;
  readonly state: Pick<KnownTerminalSession["state"], "buffer"> & {
    readonly summary: ProjectActionTerminalCandidateSummary | null;
  };
}

/**
 * Classifies a snapshot of known terminal sessions against the ordered running
 * terminal IDs for the target cwd/worktree. The returned collections should be
 * treated as read-only snapshots; runningTerminalIdsForSelection preserves
 * input.runningTerminalIds ordering for terminals that still count as busy.
 */
export function classifyProjectActionTerminalCandidates(input: {
  readonly sessions: ReadonlyArray<ProjectActionTerminalCandidateSession>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly targetCwd: string;
  readonly targetWorktreePath: string | null;
}): {
  readonly sessionsById: ReadonlyMap<string, ProjectActionTerminalCandidateSession>;
  readonly readyTerminalIds: ReadonlySet<string>;
  readonly probeTerminalIds: ReadonlySet<string>;
  readonly runningTerminalIdsForSelection: ReadonlyArray<string>;
} {
  const sessionsById = new Map(
    input.sessions.map((session) => [session.target.terminalId, session] as const),
  );
  const readyTerminalIds = new Set<string>();
  const probeTerminalIds = new Set<string>();
  const runningTerminalIdsForSelection: string[] = [];

  for (const terminalId of input.runningTerminalIds) {
    const session = sessionsById.get(terminalId);
    if (!session) {
      runningTerminalIdsForSelection.push(terminalId);
      continue;
    }
    if (
      terminalSessionIsReadyForProjectActionInput({
        summary: session.state.summary,
        buffer: session.state.buffer,
        targetCwd: input.targetCwd,
        targetWorktreePath: input.targetWorktreePath,
      })
    ) {
      readyTerminalIds.add(terminalId);
      // Ready terminals can be written to immediately, so they do not need a probe.
      continue;
    }
    if (
      terminalSessionShouldProbeForProjectActionInput({
        summary: session.state.summary,
        targetCwd: input.targetCwd,
        targetWorktreePath: input.targetWorktreePath,
      })
    ) {
      probeTerminalIds.add(terminalId);
      continue;
    }
    runningTerminalIdsForSelection.push(terminalId);
  }

  return {
    sessionsById,
    readyTerminalIds,
    probeTerminalIds,
    runningTerminalIdsForSelection,
  };
}

export function runningTerminalIdsWithProjectActionReservations(input: {
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly reservedTerminalIds: Iterable<string>;
}): ReadonlyArray<string> {
  const next = [...input.runningTerminalIds];
  const seen = new Set(next);
  for (const terminalId of input.reservedTerminalIds) {
    if (seen.has(terminalId)) continue;
    seen.add(terminalId);
    next.push(terminalId);
  }
  return next;
}

export type ProjectActionTerminalReservationPhase = "launching" | "awaiting-running";

export interface ProjectActionTerminalReservation {
  readonly phase: ProjectActionTerminalReservationPhase;
  readonly expiresAtMs: number;
}

export type ProjectActionTerminalReservations = Map<string, ProjectActionTerminalReservation>;

export function projectActionTerminalReservationIds(
  reservedTerminalIds: ProjectActionTerminalReservations,
): ReadonlyArray<string> {
  return [...reservedTerminalIds.keys()];
}

export function pruneExpiredProjectActionTerminalReservations(input: {
  readonly reservedTerminalIds: ProjectActionTerminalReservations;
  readonly nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  for (const [terminalId, reservation] of input.reservedTerminalIds) {
    if (reservation.phase === "awaiting-running" && reservation.expiresAtMs <= nowMs) {
      input.reservedTerminalIds.delete(terminalId);
    }
  }
}

export function releaseProjectActionTerminalReservationsSeenRunning(input: {
  readonly runningTerminalIds: Iterable<string>;
  readonly reservedTerminalIds: ProjectActionTerminalReservations;
  readonly nowMs?: number;
}): void {
  const runningTerminalIds = new Set(input.runningTerminalIds);
  const nowMs = input.nowMs ?? Date.now();
  for (const [terminalId, reservation] of input.reservedTerminalIds) {
    if (reservation.phase !== "awaiting-running") continue;
    if (runningTerminalIds.has(terminalId) || reservation.expiresAtMs <= nowMs) {
      input.reservedTerminalIds.delete(terminalId);
    }
  }
}

export type ProjectActionTerminalCommandResult = AtomCommandResult<unknown, unknown>;

export type RunProjectScriptInTerminalResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Interrupted" }
  | {
      readonly _tag: "Failure";
      readonly result: Extract<ProjectActionTerminalCommandResult, { readonly _tag: "Failure" }>;
    };

function projectActionOpenInput(input: {
  readonly threadId: TerminalOpenInput["threadId"];
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: NonNullable<TerminalOpenInput["env"]>;
  readonly isKnownServerTerminal: boolean;
}): TerminalOpenInput {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    ...(input.worktreePath !== null ? { worktreePath: input.worktreePath } : {}),
    env: input.env,
    ...(!input.isKnownServerTerminal
      ? { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS }
      : {}),
  };
}

export async function runProjectScriptInTerminal(input: {
  readonly script: Pick<ProjectScript, "id" | "command">;
  readonly threadId: TerminalOpenInput["threadId"];
  readonly targetCwd: string;
  readonly targetWorktreePath: string | null;
  readonly runtimeEnv: NonNullable<TerminalOpenInput["env"]>;
  readonly preferNewTerminal: boolean;
  readonly knownTerminalIds: ReadonlyArray<string>;
  readonly serverTerminalIds: ReadonlyArray<string>;
  readonly visibleTerminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly sessions: ReadonlyArray<ProjectActionTerminalCandidateSession>;
  readonly reservedTerminalIds: ProjectActionTerminalReservations;
  readonly isCommandInterrupted: (result: ProjectActionTerminalCommandResult) => boolean;
  readonly showTerminal: (
    terminalId: string,
    state: { readonly isVisibleTerminal: boolean },
  ) => void;
  readonly openTerminal: (input: TerminalOpenInput) => Promise<ProjectActionTerminalCommandResult>;
  readonly writeTerminal: (
    input: TerminalWriteInput,
  ) => Promise<ProjectActionTerminalCommandResult>;
  readonly waitForInputReady: (
    input: TerminalOpenInput,
  ) => Promise<ProjectActionTerminalCommandResult>;
  readonly requireInputReady: (
    input: TerminalOpenInput,
  ) => Promise<ProjectActionTerminalCommandResult>;
}): Promise<RunProjectScriptInTerminalResult> {
  const projectActionTerminalCandidates = classifyProjectActionTerminalCandidates({
    sessions: input.sessions,
    runningTerminalIds: input.runningTerminalIds,
    targetCwd: input.targetCwd,
    targetWorktreePath: input.targetWorktreePath,
  });
  const reservedProjectActionTerminalIds = input.reservedTerminalIds;
  pruneExpiredProjectActionTerminalReservations({
    reservedTerminalIds: reservedProjectActionTerminalIds,
  });
  let targetTerminalId =
    input.preferNewTerminal === true
      ? nextTerminalId([
          ...input.knownTerminalIds,
          ...projectActionTerminalReservationIds(reservedProjectActionTerminalIds),
        ])
      : resolveProjectActionTerminalId({
          scriptId: input.script.id,
          terminalIds: input.knownTerminalIds,
          runningTerminalIds: runningTerminalIdsWithProjectActionReservations({
            runningTerminalIds: projectActionTerminalCandidates.runningTerminalIdsForSelection,
            reservedTerminalIds: projectActionTerminalReservationIds(
              reservedProjectActionTerminalIds,
            ),
          }),
        });
  let isKnownServerTerminal = input.serverTerminalIds.includes(targetTerminalId);
  let isVisibleTerminal = input.visibleTerminalIds.includes(targetTerminalId);
  let targetSession = projectActionTerminalCandidates.sessionsById.get(targetTerminalId) ?? null;
  let canWriteImmediately = projectActionTerminalCandidates.readyTerminalIds.has(targetTerminalId);
  let waitAfterOpen = true;
  let openTerminalInput = projectActionOpenInput({
    threadId: input.threadId,
    terminalId: targetTerminalId,
    cwd: input.targetCwd,
    worktreePath: input.targetWorktreePath,
    env: input.runtimeEnv,
    isKnownServerTerminal,
  });
  let reservedProjectActionTerminalId: string | null = null;
  let keepReservationAfterWrite = false;
  const reserveProjectActionTerminalId = (terminalId: string) => {
    if (reservedProjectActionTerminalId === terminalId) return;
    if (reservedProjectActionTerminalId !== null) {
      reservedProjectActionTerminalIds.delete(reservedProjectActionTerminalId);
    }
    reservedProjectActionTerminalIds.set(terminalId, {
      phase: "launching",
      expiresAtMs: Number.POSITIVE_INFINITY,
    });
    reservedProjectActionTerminalId = terminalId;
  };

  reserveProjectActionTerminalId(targetTerminalId);
  try {
    if (
      !canWriteImmediately &&
      projectActionTerminalCandidates.probeTerminalIds.has(targetTerminalId)
    ) {
      const readyResult = await input.requireInputReady(openTerminalInput);
      if (readyResult._tag === "Success") {
        waitAfterOpen = true;
      } else {
        if (input.isCommandInterrupted(readyResult)) {
          return { _tag: "Interrupted" };
        }
        targetTerminalId = resolveProjectActionTerminalId({
          scriptId: input.script.id,
          terminalIds: input.knownTerminalIds,
          runningTerminalIds: runningTerminalIdsWithProjectActionReservations({
            runningTerminalIds: input.runningTerminalIds.filter(
              (terminalId) => !projectActionTerminalCandidates.readyTerminalIds.has(terminalId),
            ),
            reservedTerminalIds: projectActionTerminalReservationIds(
              reservedProjectActionTerminalIds,
            ).filter((terminalId) => terminalId !== reservedProjectActionTerminalId),
          }),
        });
        reserveProjectActionTerminalId(targetTerminalId);
        isKnownServerTerminal = input.serverTerminalIds.includes(targetTerminalId);
        isVisibleTerminal = input.visibleTerminalIds.includes(targetTerminalId);
        targetSession = projectActionTerminalCandidates.sessionsById.get(targetTerminalId) ?? null;
        canWriteImmediately = terminalSessionIsReadyForProjectActionInput({
          summary: targetSession?.state.summary ?? null,
          buffer: targetSession?.state.buffer ?? "",
          targetCwd: input.targetCwd,
          targetWorktreePath: input.targetWorktreePath,
        });
        waitAfterOpen = true;
        openTerminalInput = projectActionOpenInput({
          threadId: input.threadId,
          terminalId: targetTerminalId,
          cwd: input.targetCwd,
          worktreePath: input.targetWorktreePath,
          env: input.runtimeEnv,
          isKnownServerTerminal,
        });
      }
    }

    input.showTerminal(targetTerminalId, { isVisibleTerminal });

    const openResult = await input.openTerminal(openTerminalInput);
    if (openResult._tag === "Failure") {
      if (!input.isCommandInterrupted(openResult)) {
        return { _tag: "Failure", result: openResult };
      }
      return { _tag: "Interrupted" };
    }

    if (waitAfterOpen) {
      const readyResult = await input.waitForInputReady(openTerminalInput);
      if (readyResult._tag === "Failure") {
        // Prompt readiness is advisory after opening; keep the action usable on timeouts,
        // but never write into a terminal when the readiness wait was explicitly interrupted.
        if (input.isCommandInterrupted(readyResult)) {
          return { _tag: "Interrupted" };
        }
      }
    }

    const writeResult = await input.writeTerminal({
      threadId: input.threadId,
      terminalId: targetTerminalId,
      data: `${input.script.command}\r`,
    });
    if (writeResult._tag === "Failure") {
      if (!input.isCommandInterrupted(writeResult)) {
        return { _tag: "Failure", result: writeResult };
      }
      return { _tag: "Interrupted" };
    }
    reservedProjectActionTerminalIds.set(targetTerminalId, {
      phase: "awaiting-running",
      expiresAtMs: Date.now() + ACTION_TERMINAL_POST_WRITE_RESERVATION_MS,
    });
    keepReservationAfterWrite = true;
    return { _tag: "Success" };
  } finally {
    if (reservedProjectActionTerminalId !== null && !keepReservationAfterWrite) {
      reservedProjectActionTerminalIds.delete(reservedProjectActionTerminalId);
    }
  }
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
    detail: "Terminal attach failed before it was ready for input.",
    cause,
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
