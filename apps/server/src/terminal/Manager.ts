/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_TERMINAL_REPLAY_BYTES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { splitStringByUtf8Bytes } from "@t3tools/shared/utf8";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_HISTORY_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_REPLAY_HISTORY_TARGET_BYTES = 48 * 1024;
const DEFAULT_REPLAY_HISTORY_MAX_BYTES = DEFAULT_TERMINAL_REPLAY_BYTES;
const DEFAULT_OUTPUT_BATCH_WINDOW_MS = 8;
// Full-screen terminal apps commonly emit 20-40 KB synchronized updates. Keep
// typical frames in one event while retaining a bounded live-subscriber queue.
const DEFAULT_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;
// Bound output accepted ahead of the event drain. Node PTYs are paused before
// this fills; adapters without producer flow control drop only overflow bytes
// rather than allowing an unbounded server heap queue.
const DEFAULT_PENDING_PROCESS_EVENT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_HISTORY_STREAM_CHUNK_BYTES = 64 * 1024;
// Events published while an attach is still replaying buffer until the replay
// finishes. The budget must comfortably cover live output produced during a
// multi-second extended replay over a slow link; overflowing it degrades the
// subscriber to a bounded resync snapshot, which discards streamed scrollback.
const DEFAULT_ATTACH_BUFFERED_EVENT_LIMIT = 1_024;
const DEFAULT_ATTACH_BUFFERED_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_PERSIST_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;

class TerminalSubprocessCheckError extends Schema.TaggedErrorClass<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedErrorClass<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (
        event: TerminalAttachStreamEvent,
        delivery: "replay" | "live",
      ) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /** Read the current bounded snapshot for a slow-subscriber resync. */
    readonly readSnapshot: (
      input: TerminalClearInput,
    ) => Effect.Effect<Option.Option<TerminalSessionSnapshot>>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  historyBytes: number;
  persistenceHistory: string;
  persistenceHistoryBytes: number;
  pendingHistoryControlSequence: string;
  /** Last observed state of replayable DEC private modes for the live process. */
  trackedDecModes: Map<number, boolean>;
  /** Mode state at the first byte of `history`, advanced as caps drop its prefix. */
  historyStartDecModes: Map<number, boolean>;
  /** Mode state at the first byte of `persistenceHistory`. */
  persistenceStartDecModes: Map<number, boolean>;
  pendingOutputHighSurrogate: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  pendingProcessEventBytes: number;
  processOutputPaused: boolean;
  processEventDrainPid: number | null;
  processEventDrainSemaphore: Semaphore.Semaphore;
  /** Serializes PTY input so a held mouse release cannot be overtaken. */
  writeSemaphore: Semaphore.Semaphore;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface HistoryWrite {
  contents: string;
  mode: "append" | "truncate";
}

interface PersistHistoryRequest extends HistoryWrite {
  authoritativeHistory: string;
  contentsBytes: number;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string; dataBytes: number }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      data: string;
      historyWrite: HistoryWrite | null;
      authoritativeHistory: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
      /** Neutralizing resets for modes the dead process left dangling. */
      modeResetData: string;
      modeReset: {
        readonly sequence: number;
        readonly historyWrite: HistoryWrite | null;
        readonly authoritativeHistory: string;
      } | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: `${decModeReplayPrefix(session.historyStartDecModes)}${session.history}`,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

/**
 * Drop all queued PTY events and flow-control state. Only safe when the
 * producing process is gone or being replaced: it clears the paused flag
 * without resuming, which would wedge a still-attached paused PTY.
 */
function resetPendingProcessQueue(session: TerminalSessionState): void {
  session.pendingProcessEvents = [];
  session.pendingProcessEventIndex = 0;
  session.pendingProcessEventBytes = 0;
  session.processOutputPaused = false;
  session.processEventDrainPid = null;
}

function splitCompleteOutput(
  pendingHighSurrogate: string,
  data: string,
  flushTrailingHighSurrogate = false,
): { readonly data: string; readonly pendingHighSurrogate: string } {
  const combined = `${pendingHighSurrogate}${data}`;
  const finalCodeUnit = combined.charCodeAt(combined.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    if (!flushTrailingHighSurrogate) {
      return {
        data: combined.slice(0, -1),
        pendingHighSurrogate: combined.slice(-1),
      };
    }
    return { data: `${combined.slice(0, -1)}\ufffd`, pendingHighSurrogate: "" };
  }
  return { data: combined, pendingHighSurrogate: "" };
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
  outputBatchMaxBytes: number,
  pendingProcessEventMaxBytes: number,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  if (
    event.type === "output" &&
    session.pendingProcessEventBytes + event.dataBytes > pendingProcessEventMaxBytes
  ) {
    if (!session.processOutputPaused) {
      session.processOutputPaused = true;
      try {
        session.process.pauseOutput?.();
      } catch {
        // The byte ceiling remains authoritative if adapter flow control fails.
      }
    }
    return false;
  }

  const lastPending = session.pendingProcessEvents.at(-1);
  if (
    event.type === "output" &&
    lastPending?.type === "output" &&
    lastPending.dataBytes + event.dataBytes <= outputBatchMaxBytes
  ) {
    session.pendingProcessEvents[session.pendingProcessEvents.length - 1] = {
      type: "output",
      data: `${lastPending.data}${event.data}`,
      dataBytes: lastPending.dataBytes + event.dataBytes,
    };
  } else {
    session.pendingProcessEvents.push(event);
  }
  if (event.type === "output") {
    session.pendingProcessEventBytes += event.dataBytes;
    const pauseAtBytes = Math.max(
      outputBatchMaxBytes,
      pendingProcessEventMaxBytes - outputBatchMaxBytes,
    );
    if (!session.processOutputPaused && session.pendingProcessEventBytes >= pauseAtBytes) {
      session.processOutputPaused = true;
      try {
        session.process.pauseOutput?.();
      } catch {
        // The hard byte ceiling above still protects adapters whose optional
        // producer-level flow control fails at runtime.
      }
    }
  }
  if (session.processEventDrainPid === expectedPid) {
    return false;
  }

  session.processEventDrainPid = expectedPid;
  return true;
}

function resumeProcessOutput(
  session: TerminalSessionState,
  expectedPid: number,
  pendingProcessEventResumeBytes: number,
  force = false,
): void {
  if (
    !session.processOutputPaused ||
    session.pid !== expectedPid ||
    !session.process ||
    session.status !== "running" ||
    (!force && session.pendingProcessEventBytes > pendingProcessEventResumeBytes)
  ) {
    return;
  }

  session.processOutputPaused = false;
  try {
    session.process.resumeOutput?.();
  } catch {
    // A failed optional resume cannot leave the manager queue marked paused.
  }
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function parseWindowsProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, parentPidRaw, nameRaw] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const parentPid = Number(parentPidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, nameRaw?.trim() ?? "");
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? [])[0];
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = normalizeChildCommandName(snapshot.commandById.get(childPid) ?? "", platform);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        // powershell.exe is a real executable — never spawn it through cmd.exe
        // shell mode, which would re-tokenize the `-Command` payload (pipes,
        // semicolons) before PowerShell ever sees it.
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalSubprocessCheckError({
              cause,
              command: "powershell",
            }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      // Not authoritative: an empty or partial table would mark every terminal
      // idle and clear its registered process ids. Failing skips the tick.
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    return parseWindowsProcessTable(result.stdout);
  },
);

function capHistoryByBytes(history: string, targetBytes: number): string {
  const encoded = Buffer.from(history);
  if (encoded.byteLength <= targetBytes) return history;

  let start = encoded.byteLength - targetBytes;
  while (start < encoded.byteLength && ((encoded[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }

  const decodedPrefixLength = encoded.subarray(0, start).toString().length;
  const safeStart = alignHistoryStartToControlBoundary(history, decodedPrefixLength);
  const suffix = history.slice(safeStart);
  const previousByte = start > 0 ? encoded[start - 1] : undefined;
  if (
    safeStart === decodedPrefixLength &&
    (previousByte === 0x0a || (previousByte === 0x0d && encoded[start] !== 0x0a))
  ) {
    return suffix;
  }

  const newlineIndex = suffix.indexOf("\n");
  const carriageReturnIndex = suffix.indexOf("\r");
  const boundaryIndex =
    newlineIndex === -1
      ? carriageReturnIndex
      : carriageReturnIndex === -1
        ? newlineIndex
        : Math.min(newlineIndex, carriageReturnIndex);
  if (boundaryIndex === -1) return suffix;

  const boundaryLength =
    suffix[boundaryIndex] === "\r" && suffix[boundaryIndex + 1] === "\n" ? 2 : 1;
  if (boundaryIndex + boundaryLength === suffix.length) return suffix;
  return suffix.slice(boundaryIndex + boundaryLength);
}

function terminalControlSequenceEndIndex(input: string, start: number): number | null {
  const codePoint = input.charCodeAt(start);
  const isEscape = codePoint === 0x1b;
  const nextCodePoint = input.charCodeAt(start + 1);

  if (isEscape && Number.isNaN(nextCodePoint)) return input.length;
  if (isEscape && nextCodePoint === 0x5b) {
    for (let cursor = start + 2; cursor < input.length; cursor += 1) {
      if (isCsiFinalByte(input.charCodeAt(cursor))) return cursor + 1;
    }
    return input.length;
  }
  if (codePoint === 0x9b) {
    for (let cursor = start + 1; cursor < input.length; cursor += 1) {
      if (isCsiFinalByte(input.charCodeAt(cursor))) return cursor + 1;
    }
    return input.length;
  }

  const isEscString =
    isEscape &&
    (nextCodePoint === 0x5d ||
      nextCodePoint === 0x50 ||
      nextCodePoint === 0x5e ||
      nextCodePoint === 0x5f);
  const isC1String =
    codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f;
  if (isEscString || isC1String) {
    return findStringTerminatorIndex(input, start + (isEscape ? 2 : 1)) ?? input.length;
  }
  if (isEscape) {
    return findEscapeSequenceEndIndex(input, start + 1) ?? input.length;
  }
  return null;
}

function alignHistoryStartToControlBoundary(history: string, requestedStart: number): number {
  let index = 0;
  while (index < requestedStart) {
    const sequenceEnd = terminalControlSequenceEndIndex(history, index);
    if (sequenceEnd === null) {
      index += 1;
      continue;
    }
    if (sequenceEnd > requestedStart) return sequenceEnd;
    index = sequenceEnd;
  }
  return requestedStart;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

// DEC private modes that shape how a replayed history tail renders or behaves.
// Values are power-on defaults; only deviations have to be re-established when
// the sequence that set them has aged out of the bounded replay window.
// Frame-scoped modes such as synchronized output (2026) stay excluded: they
// must never outlive the frame that opened them.
const REPLAYABLE_DEC_MODE_DEFAULTS = new Map<number, boolean>([
  [1, false], // application cursor keys
  [6, false], // origin mode
  [7, true], // autowrap
  [9, false], // X10 mouse reporting
  [25, true], // cursor visible
  [47, false], // legacy alternate screen
  [1000, false], // mouse press/release tracking
  [1002, false], // mouse button-event tracking
  [1003, false], // mouse any-event tracking
  [1004, false], // focus reporting
  [1005, false], // UTF-8 mouse encoding
  [1006, false], // SGR mouse encoding
  [1015, false], // urxvt mouse encoding
  [1047, false], // alternate screen buffer
  [1049, false], // alternate screen with cursor save
  [2004, false], // bracketed paste
]);

// The three alternate-screen modes toggle one underlying screen: entering via
// one and leaving via another must not leave a sibling recorded as active.
const ALTERNATE_SCREEN_DEC_MODES = [47, 1047, 1049];

// Mode sets plus the full reset (RIS `ESC c`) that restores power-on defaults
// without individual mode resets. DECSTR (`CSI !p`) is deliberately not one:
// the vendored libghostty-vt leaves every mode listed above untouched on a
// soft reset, so treating it as a reset would desynchronize the tracked state
// from what the renderer shows.
// eslint-disable-next-line no-control-regex -- matches DEC private mode and RIS sequences.
const DEC_MODE_SET_PATTERN = /(?:\u001b\[|\u009b)\?([0-9;]+)([hl])|\u001b(c)/gu;

function forEachDecModeSet(
  text: string,
  visit: (mode: number, enabled: boolean) => void,
  onTerminalReset?: () => void,
): void {
  for (const match of text.matchAll(DEC_MODE_SET_PATTERN)) {
    if (match[3] !== undefined) {
      onTerminalReset?.();
      continue;
    }
    const enabled = match[2] === "h";
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number.parseInt(parameter, 10);
      if (REPLAYABLE_DEC_MODE_DEFAULTS.has(mode)) visit(mode, enabled);
    }
  }
}

function updateTrackedDecModes(modes: Map<number, boolean>, chunk: string): void {
  forEachDecModeSet(
    chunk,
    (mode, enabled) => {
      if (ALTERNATE_SCREEN_DEC_MODES.includes(mode)) {
        for (const alias of ALTERNATE_SCREEN_DEC_MODES) modes.delete(alias);
      }
      modes.set(mode, enabled);
    },
    () => modes.clear(),
  );
}

// A write consisting purely of SGR or X10 mouse reports. Clients only send
// these as standalone writes, so mixed input such as a paste never matches.
// eslint-disable-next-line no-control-regex -- matches ESC[ mouse report sequences.
const MOUSE_REPORT_WRITE_PATTERN = /^(?:\u001b\[<\d+;\d+;\d+[mM]|\u001b\[M[^]{3})+$/;

function isMouseTrackingActive(modes: Map<number, boolean>): boolean {
  return (
    modes.get(9) === true ||
    modes.get(1000) === true ||
    modes.get(1002) === true ||
    modes.get(1003) === true
  );
}

// How long a release-only mouse write waits for an exit-in-progress to
// disable tracking. A deliberate timing allowance for a physical race: the
// press may have told the application to quit, and its restore sequences race
// this very release.
const DEFAULT_MOUSE_RELEASE_HOLD_MS = 50;

// How long an attach holds the off-by-one PTY size before restoring it.
// ncurses only reports KEY_RESIZE when the size it reads differs from the
// one it has, so two immediate resizes collapse into a no-op and the app
// never repaints. A deliberate timing allowance: the app must observe the
// intermediate size before the restore.
const DEFAULT_ATTACH_REPAINT_HOLD_MS = 100;

// SGR releases (`<...m`) and X10 releases (`ESC [ M` with button bits 3, any
// modifier combination), which clients emit when SGR encoding is not enabled.
// eslint-disable-next-line no-control-regex -- matches mouse release sequences.
const MOUSE_RELEASE_WRITE_PATTERN = /^(?:\u001b\[<\d+;\d+;\d+m|\u001b\[M[#'+/37;?][^]{2})+$/;

/**
 * Sequences restoring every tracked mode the given history leaves deviating
 * from its default. A process that died mid-app (server restart, crash) leaves
 * a dangling alternate-screen or mouse mode in its history; replaying it would
 * put the renderer into a state the freshly spawned process is not in.
 */
function decModeResetForModes(modes: Map<number, boolean>): string {
  const deviations = [...modes].filter(([mode, enabled]) => {
    const fallback = REPLAYABLE_DEC_MODE_DEFAULTS.get(mode);
    return fallback !== undefined && enabled !== fallback;
  });
  // Leave the alternate screen before the remaining resets: exiting it
  // restores saved cursor state, which must not undo a cursor-show reset.
  deviations.sort(
    ([left], [right]) =>
      Number(!ALTERNATE_SCREEN_DEC_MODES.includes(left)) -
      Number(!ALTERNATE_SCREEN_DEC_MODES.includes(right)),
  );
  return deviations
    .map(([mode]) => `\u001b[?${mode}${REPLAYABLE_DEC_MODE_DEFAULTS.get(mode) ? "h" : "l"}`)
    .join("");
}

function decModeResetSuffix(history: string): string {
  const modes = new Map<number, boolean>();
  updateTrackedDecModes(modes, history);
  return decModeResetForModes(modes);
}

/**
 * Sequences that put the renderer into the mode state the retained tail
 * starts in. A full-screen app's alternate-screen, cursor, and mouse mode
 * switches age out of the bounded history long before the app exits; without
 * this prefix a reattach rebuilds the app's cells on the primary screen with
 * the host theme. The tail may itself leave and re-enter a mode (an app that
 * exited and relaunched), so only the state at its first byte is authoritative.
 */
function decModeReplayPrefix(modes: Map<number, boolean>): string {
  let prefix = "";
  for (const [mode, enabled] of modes) {
    if (enabled !== REPLAYABLE_DEC_MODE_DEFAULTS.get(mode)) {
      prefix += `\u001b[?${mode}${enabled ? "h" : "l"}`;
    }
  }
  return prefix;
}

/** Advance a tail-start mode state past the prefix a cap dropped to keep `kept` of `full`. */
function advanceDecModesPastDroppedPrefix(
  modes: Map<number, boolean>,
  full: string,
  kept: string,
): void {
  if (kept.length === full.length) return;
  updateTrackedDecModes(modes, full.slice(0, full.length - kept.length));
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 === input.length) {
      return { visibleText, pendingControlSequence: input.slice(index) };
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_T3-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyTargetBytes?: number;
  historyMaxBytes?: number;
  replayHistoryTargetBytes?: number;
  replayHistoryMaxBytes?: number;
  outputBatchWindowMs?: number;
  outputBatchMaxBytes?: number;
  pendingProcessEventMaxBytes?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
}

export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const logsDir = options.logsDir;
  const historyTargetBytes = options.historyTargetBytes ?? DEFAULT_HISTORY_TARGET_BYTES;
  const historyMaxBytes = options.historyMaxBytes ?? DEFAULT_HISTORY_MAX_BYTES;
  const replayHistoryTargetBytes =
    options.replayHistoryTargetBytes ?? DEFAULT_REPLAY_HISTORY_TARGET_BYTES;
  const replayHistoryMaxBytes = options.replayHistoryMaxBytes ?? DEFAULT_REPLAY_HISTORY_MAX_BYTES;
  const outputBatchWindowMs = options.outputBatchWindowMs ?? DEFAULT_OUTPUT_BATCH_WINDOW_MS;
  const outputBatchMaxBytes = Math.max(
    1,
    options.outputBatchMaxBytes ?? DEFAULT_OUTPUT_BATCH_MAX_BYTES,
  );
  const pendingProcessEventMaxBytes = Math.max(
    outputBatchMaxBytes,
    options.pendingProcessEventMaxBytes ?? DEFAULT_PENDING_PROCESS_EVENT_MAX_BYTES,
  );
  const pendingProcessEventResumeBytes = Math.floor(pendingProcessEventMaxBytes / 2);
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fetchProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    TerminalSubprocessInspector,
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed(customSubprocessInspector)
      : Effect.map(
          fetchProcessTableSnapshot,
          (snapshot): TerminalSubprocessInspector =>
            (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const applyHistoryOutput = (
    session: TerminalSessionState,
    data: string,
  ): { visibleText: string; write: HistoryWrite | null } => {
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
    session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
    if (sanitized.visibleText.length === 0) {
      return { visibleText: "", write: null };
    }
    updateTrackedDecModes(session.trackedDecModes, sanitized.visibleText);

    const visibleBytes = Buffer.byteLength(sanitized.visibleText);
    const nextHistory = `${session.persistenceHistory}${sanitized.visibleText}`;
    if (session.persistenceHistoryBytes + visibleBytes <= historyMaxBytes) {
      session.persistenceHistory = nextHistory;
      session.persistenceHistoryBytes += visibleBytes;
      return {
        visibleText: sanitized.visibleText,
        write: { contents: sanitized.visibleText, mode: "append" },
      };
    }

    const capped = capHistoryByBytes(nextHistory, historyTargetBytes);
    advanceDecModesPastDroppedPrefix(session.persistenceStartDecModes, nextHistory, capped);
    session.persistenceHistory = capped;
    session.persistenceHistoryBytes = Buffer.byteLength(capped);
    return {
      visibleText: sanitized.visibleText,
      write: { contents: session.persistenceHistory, mode: "truncate" },
    };
  };

  const enqueueOutputData = (
    session: TerminalSessionState,
    expectedPid: number,
    data: string,
    flushTrailingHighSurrogate = false,
  ): boolean => {
    const complete = splitCompleteOutput(
      session.pendingOutputHighSurrogate,
      data,
      flushTrailingHighSurrogate,
    );
    session.pendingOutputHighSurrogate = complete.pendingHighSurrogate;

    let shouldStartDrain = false;
    for (const chunk of splitStringByUtf8Bytes(complete.data, outputBatchMaxBytes)) {
      if (
        chunk.byteLength > 0 &&
        enqueueProcessEvent(
          session,
          expectedPid,
          {
            type: "output",
            data: chunk.data,
            dataBytes: chunk.byteLength,
          },
          outputBatchMaxBytes,
          pendingProcessEventMaxBytes,
        )
      ) {
        shouldStartDrain = true;
      }
    }
    return shouldStartDrain;
  };

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(threadId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const terminated = yield* Effect.try({
      try: () => process.kill("SIGTERM"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGTERM",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGTERM",
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => process.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGKILL",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          cause: error,
        }),
      ),
    );
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => {
      if (next.mode === "truncate") {
        return next;
      }

      const contents = `${current.contents}${next.contents}`;
      const contentsBytes = current.contentsBytes + next.contentsBytes;
      return {
        authoritativeHistory: next.authoritativeHistory,
        contents,
        contentsBytes,
        mode: current.mode,
        immediate:
          current.immediate || next.immediate || contentsBytes >= DEFAULT_PERSIST_CHUNK_BYTES,
      };
    },
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      const nextPath = historyPath(threadId, terminalId);
      yield* fileSystem
        .writeFileString(nextPath, request.contents, {
          flag: request.mode === "append" ? "a" : "w",
        })
        .pipe(
          Effect.catch((error) => {
            if (request.mode === "truncate") {
              return Effect.logWarning("failed to persist terminal history", {
                threadId,
                terminalId,
                error,
              });
            }

            return fileSystem
              .writeFileString(nextPath, request.authoritativeHistory, { flag: "w" })
              .pipe(
                Effect.catch((fallbackError) =>
                  Effect.logWarning("failed to recover terminal history append", {
                    threadId,
                    terminalId,
                    error,
                    fallbackError,
                  }),
                ),
              );
          }),
        );
    }),
  });

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    write: HistoryWrite,
    authoritativeHistory: string,
  ) {
    const contentsBytes = Buffer.byteLength(write.contents);
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      ...write,
      authoritativeHistory,
      contentsBytes,
      immediate: contentsBytes >= DEFAULT_PERSIST_CHUNK_BYTES,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      authoritativeHistory: history,
      contents: history,
      contentsBytes: Buffer.byteLength(history),
      mode: "truncate",
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  // A process that died mid-app leaves dangling alternate-screen, cursor, or
  // mouse modes in its history. Restore the defaults the new process actually
  // starts from, then start it on a fresh line so two prompts cannot
  // concatenate side by side (a trailing carriage return already returns the
  // cursor to column 0). Applied to both the current log and legacy migration,
  // and persisted with the same write so file and memory stay byte-identical.
  const normalizeLoadedHistory = (raw: string): string => {
    const bounded =
      Buffer.byteLength(raw) > historyMaxBytes ? capHistoryByBytes(raw, historyTargetBytes) : raw;
    const neutralized = `${bounded}${decModeResetSuffix(bounded)}`;
    return neutralized.length > 0 && !neutralized.endsWith("\n") && !neutralized.endsWith("\r")
      ? `${neutralized}\r\n`
      : neutralized;
  };

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const raw = yield* fileSystem
        .readFileString(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        );
      const capped = normalizeLoadedHistory(raw);
      if (capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return capped;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return "";
    }

    const raw = yield* fileSystem
      .readFileString(legacyPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    const capped = normalizeLoadedHistory(raw);
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return capped;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${toSafeThreadId(threadId)}.log` ||
          name === `${legacySafeThreadId(threadId)}.log` ||
          name.startsWith(threadPrefix),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              threadId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEventsUnlocked = Effect.fn("terminal.drainProcessEventsUnlocked")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.processEventDrainPid !== expectedPid) {
          return { type: "idle" } as const;
        }
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          resetPendingProcessQueue(session);
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.pendingProcessEventBytes = 0;
          session.processEventDrainPid = null;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (nextEvent.type === "output") {
          session.pendingProcessEventBytes = Math.max(
            0,
            session.pendingProcessEventBytes - nextEvent.dataBytes,
          );
        }
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        } else if (
          session.pendingProcessEventIndex >= 64 &&
          session.pendingProcessEventIndex * 2 >= session.pendingProcessEvents.length
        ) {
          session.pendingProcessEvents = session.pendingProcessEvents.slice(
            session.pendingProcessEventIndex,
          );
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const historyOutput = applyHistoryOutput(session, nextEvent.data);
          if (historyOutput.visibleText.length > 0) {
            const visibleBytes = Buffer.byteLength(historyOutput.visibleText);
            const nextHistory = `${session.history}${historyOutput.visibleText}`;
            if (session.historyBytes + visibleBytes <= replayHistoryMaxBytes) {
              session.history = nextHistory;
              session.historyBytes += visibleBytes;
            } else {
              const capped = capHistoryByBytes(nextHistory, replayHistoryTargetBytes);
              advanceDecModesPastDroppedPrefix(session.historyStartDecModes, nextHistory, capped);
              session.history = capped;
              session.historyBytes = Buffer.byteLength(capped);
            }
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            data: nextEvent.data,
            historyWrite: historyOutput.write,
            authoritativeHistory: session.persistenceHistory,
          } as const;
        }

        const process = session.process;
        // A process that died without restoring its modes (kill -9 mid-app)
        // leaves the terminal in the alternate screen with the cursor hidden.
        // Neutralize like a loaded history so the exit notice and any later
        // attach render on a sane primary screen, and persist the same bytes.
        const exitModeReset = decModeResetForModes(session.trackedDecModes);
        let modeReset: {
          readonly sequence: number;
          readonly historyWrite: HistoryWrite | null;
          readonly authoritativeHistory: string;
        } | null = null;
        if (exitModeReset.length > 0) {
          const historyOutput = applyHistoryOutput(session, exitModeReset);
          if (historyOutput.visibleText.length > 0) {
            session.history = `${session.history}${historyOutput.visibleText}`;
            session.historyBytes += Buffer.byteLength(historyOutput.visibleText);
          }
          session.trackedDecModes = new Map();
          modeReset = {
            sequence: advanceEventSequence(session).sequence,
            historyWrite: historyOutput.write,
            authoritativeHistory: session.persistenceHistory,
          };
        }
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingOutputHighSurrogate = "";
        resetPendingProcessQueue(session);
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          modeReset,
          modeResetData: exitModeReset,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.historyWrite !== null) {
          yield* queuePersist(
            action.threadId,
            action.terminalId,
            action.historyWrite,
            action.authoritativeHistory,
          );
        }
        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        resumeProcessOutput(session, expectedPid, pendingProcessEventResumeBytes);
        continue;
      }

      if (action.modeReset !== null) {
        if (action.modeReset.historyWrite !== null) {
          yield* queuePersist(
            action.threadId,
            action.terminalId,
            action.modeReset.historyWrite,
            action.modeReset.authoritativeHistory,
          );
        }
        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.modeReset.sequence,
          data: action.modeResetData,
        });
      }
      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      yield* flushPersist(action.threadId, action.terminalId);
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    yield* session.processEventDrainSemaphore.withPermit(
      drainProcessEventsUnlocked(session, expectedPid),
    );
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    // A lifecycle command is an ordering barrier. Drain bytes already accepted
    // from the PTY before clearing its handlers or state so history and live
    // events cannot diverge at close/restart boundaries.
    if (session.process && session.pid !== null && session.pendingOutputHighSurrogate.length > 0) {
      enqueueOutputData(session, session.pid, "", true);
    }
    if (session.processEventDrainPid !== null) {
      yield* drainProcessEvents(session, session.processEventDrainPid);
    }

    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingOutputHighSurrogate = "";
      resetPendingProcessQueue(session);
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      resetPendingProcessQueue(session);
      session.pendingOutputHighSurrogate = "";
      // The mode state belongs to the process being replaced.
      session.trackedDecModes = new Map();
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (!session.process || session.status !== "running" || session.pid !== processPid) {
                return;
              }

              const shouldStartDrain = enqueueOutputData(session, processPid, data);
              if (!shouldStartDrain) {
                return;
              }
              runFork(
                Effect.sleep(outputBatchWindowMs).pipe(
                  Effect.andThen(drainProcessEvents(session, processPid)),
                ),
              );
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              const shouldStartDrain = enqueueOutputData(session, processPid, "", true);
              if (
                enqueueProcessEvent(
                  session,
                  processPid,
                  { type: "exit", event },
                  outputBatchMaxBytes,
                  pendingProcessEventMaxBytes,
                )
              ) {
                runFork(drainProcessEvents(session, processPid));
                return;
              }
              if (shouldStartDrain) runFork(drainProcessEvents(session, processPid));
            });

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        resetPendingProcessQueue(session);
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.map(Option.some),
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(Effect.as(Option.none<TerminalSubprocessInspector>())),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return;
    }

    const subprocessInspector = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
            )
          : Effect.sleep(subprocessPollIntervalMs),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        if (
          session.process &&
          session.pid !== null &&
          session.pendingOutputHighSurrogate.length > 0
        ) {
          enqueueOutputData(session, session.pid, "", true);
        }
        if (session.processEventDrainPid !== null) {
          yield* drainProcessEvents(session, session.processEventDrainPid);
        }
        cleanupProcessHandles(session);
        yield* flushPersist(session.threadId, session.terminalId);
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.threadId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (input: TerminalOpenInput) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const persistenceHistory = yield* readHistory(input.threadId, terminalId);
      const history =
        Buffer.byteLength(persistenceHistory) > replayHistoryMaxBytes
          ? capHistoryByBytes(persistenceHistory, replayHistoryTargetBytes)
          : persistenceHistory;
      // Loaded history was neutralized to end at the defaults; its start is
      // taken as the defaults too, and the replay tail's start follows from
      // whatever the cap dropped in between.
      const historyStartDecModes = new Map<number, boolean>();
      advanceDecModesPastDroppedPrefix(historyStartDecModes, persistenceHistory, history);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        historyBytes: Buffer.byteLength(history),
        persistenceHistory,
        persistenceHistoryBytes: Buffer.byteLength(persistenceHistory),
        pendingHistoryControlSequence: "",
        trackedDecModes: new Map(),
        historyStartDecModes,
        persistenceStartDecModes: new Map(),
        pendingOutputHighSurrogate: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        pendingProcessEventBytes: 0,
        processOutputPaused: false,
        processEventDrainPid: null,
        processEventDrainSemaphore: yield* Semaphore.make(1),
        writeSemaphore: yield* Semaphore.make(1),
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history = "";
      liveSession.historyBytes = 0;
      liveSession.persistenceHistory = "";
      liveSession.persistenceHistoryBytes = 0;
      liveSession.historyStartDecModes = new Map();
      liveSession.persistenceStartDecModes = new Map();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingOutputHighSurrogate = "";
      resetPendingProcessQueue(liveSession);
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history = "";
      liveSession.historyBytes = 0;
      liveSession.persistenceHistory = "";
      liveSession.persistenceHistoryBytes = 0;
      liveSession.historyStartDecModes = new Map();
      liveSession.persistenceStartDecModes = new Map();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingOutputHighSurrogate = "";
      resetPendingProcessQueue(liveSession);
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(input.threadId, openLocked(input));

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        let resizedDuringAttach = false;

        if (Option.isNone(existing)) {
          if (!input.cwd) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          session = yield* requireSession(input.threadId, terminalId);
        } else {
          session = existing.value;
          const targetCols = input.cols ?? session.cols;
          const targetRows = input.rows ?? session.rows;

          if (!session.process && input.cwd && input.restartIfNotRunning === true) {
            yield* openLocked({
              ...input,
              terminalId,
              cwd: input.cwd,
            });
            session = yield* requireSession(input.threadId, terminalId);
          } else if (
            session.process &&
            session.status === "running" &&
            (session.cols !== targetCols || session.rows !== targetRows)
          ) {
            const process = session.process;
            yield* resizePtyProcess(session, process, targetCols, targetRows);
            session.cols = targetCols;
            session.rows = targetRows;
            session.updatedAt = yield* nowIso;
            resizedDuringAttach = true;
          }
        }

        // Flush the short output batch before capturing history so the replay
        // snapshot and its sequence describe the same point in the PTY stream.
        if (session.processEventDrainPid !== null) {
          yield* drainProcessEvents(session, session.processEventDrainPid);
        }

        const initialSnapshot = snapshot(session);

        // A full-screen app repaints only dirty cells, so the capped replay
        // cannot reconstruct its whole screen. Wiggle the PTY size so the
        // SIGWINCH makes the app repaint everything; its output lands after
        // the replay as ordinary live events. Shells never sit in the
        // alternate screen, so attach still cannot redraw a shell prompt. A
        // real size change above already delivered the same repaint signal.
        // The intermediate size is held long enough for the app to read it.
        const altScreenActive =
          session.trackedDecModes.get(1049) === true ||
          session.trackedDecModes.get(1047) === true ||
          session.trackedDecModes.get(47) === true;
        if (
          altScreenActive &&
          !resizedDuringAttach &&
          session.process &&
          session.status === "running"
        ) {
          const process = session.process;
          const wiggleCols = session.cols > 1 ? session.cols - 1 : session.cols + 1;
          yield* resizePtyProcess(session, process, wiggleCols, session.rows);
          yield* Effect.sleep(DEFAULT_ATTACH_REPAINT_HOLD_MS);
          yield* resizePtyProcess(session, process, session.cols, session.rows);
        }
        const requestedReplayBytes = input.replayBytes ?? DEFAULT_TERMINAL_REPLAY_BYTES;
        if (requestedReplayBytes <= DEFAULT_TERMINAL_REPLAY_BYTES) {
          return { snapshot: initialSnapshot, replayHistory: null } as const;
        }

        const replayHistory =
          session.persistenceHistoryBytes > requestedReplayBytes
            ? capHistoryByBytes(session.persistenceHistory, requestedReplayBytes)
            : session.persistenceHistory;
        const replayStartDecModes = new Map(session.persistenceStartDecModes);
        advanceDecModesPastDroppedPrefix(
          replayStartDecModes,
          session.persistenceHistory,
          replayHistory,
        );
        return {
          snapshot: { ...initialSnapshot, history: "" },
          replayHistory: `${decModeReplayPrefix(replayStartDecModes)}${replayHistory}`,
        } as const;
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const readSnapshot: TerminalManager["Service"]["readSnapshot"] = (input) =>
    getSession(input.threadId, input.terminalId).pipe(Effect.map(Option.map(snapshot)));

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: Array<{ event: TerminalEvent; bytes: number }> = [];
      let bufferedEventBytes = 0;
      let bufferedOverflow = false;
      let deliverLive = false;
      // Old clients decode the attach stream against a union without the
      // replay markers. Sending replayBytes proves the client understands them.
      const emitReplayMarkers = input.replayBytes !== undefined;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          const eventBytes = event.type === "output" ? Buffer.byteLength(event.data) : 0;
          if (
            bufferedEvents.length >= DEFAULT_ATTACH_BUFFERED_EVENT_LIMIT ||
            bufferedEventBytes + eventBytes > DEFAULT_ATTACH_BUFFERED_MAX_BYTES
          ) {
            bufferedEvents.splice(0);
            bufferedEventBytes = 0;
            bufferedOverflow = true;
          }
          bufferedEvents.push({ event, bytes: eventBytes });
          bufferedEventBytes += eventBytes;
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent, "live") : Effect.void;
      });

      const bootstrap = yield* openOrAttachForStream(input);
      let synchronizedSnapshot = bootstrap.snapshot;

      if (emitReplayMarkers) {
        yield* listener(
          {
            type: "replay-start",
            threadId: input.threadId,
            terminalId: input.terminalId,
            ...(typeof bootstrap.snapshot.sequence === "number"
              ? { sequence: bootstrap.snapshot.sequence }
              : {}),
          },
          "replay",
        );
      }

      yield* listener(
        {
          type: "snapshot",
          snapshot: bootstrap.snapshot,
        },
        "replay",
      );

      if (bootstrap.replayHistory !== null && bootstrap.replayHistory.length > 0) {
        for (const { data } of splitStringByUtf8Bytes(
          bootstrap.replayHistory,
          DEFAULT_HISTORY_STREAM_CHUNK_BYTES,
        )) {
          yield* listener(
            {
              type: "output",
              threadId: input.threadId,
              terminalId: input.terminalId,
              ...(typeof bootstrap.snapshot.sequence === "number"
                ? { sequence: bootstrap.snapshot.sequence }
                : {}),
              data,
            },
            "replay",
          );
        }
      }

      if (emitReplayMarkers) {
        yield* listener(
          {
            type: "replay-complete",
            threadId: input.threadId,
            terminalId: input.terminalId,
            ...(typeof bootstrap.snapshot.sequence === "number"
              ? { sequence: bootstrap.snapshot.sequence }
              : {}),
          },
          "replay",
        );
      }

      let overflowResyncCount = 0;
      while (true) {
        if (bufferedOverflow) {
          bufferedOverflow = false;
          overflowResyncCount += 1;
          if (overflowResyncCount > 3) {
            // A consumer this far behind keeps overflowing while the resync
            // itself is being delivered. Go live anyway; the transport's own
            // overflow path resynchronizes it from the latest snapshot.
            bufferedEvents.splice(0);
            bufferedEventBytes = 0;
            deliverLive = true;
            break;
          }
          const latest = yield* readSnapshot(input);
          if (Option.isSome(latest)) {
            synchronizedSnapshot = latest.value;
            yield* listener(
              {
                type: "snapshot",
                snapshot: latest.value,
              },
              "replay",
            );
          }
          continue;
        }

        const buffered = bufferedEvents.shift();
        if (!buffered) {
          deliverLive = true;
          break;
        }
        bufferedEventBytes -= buffered.bytes;
        if (isDuplicateAttachSnapshotEvent(buffered.event, synchronizedSnapshot)) continue;

        const attachEvent = terminalEventToAttachEvent(buffered.event);
        if (attachEvent) {
          yield* listener(attachEvent, "replay");
        }
      }

      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    // The permit serializes PTY input per session: writes queued behind a held
    // mouse release wait for it instead of overtaking it.
    yield* session.writeSemaphore.withPermit(
      Effect.gen(function* () {
        if (MOUSE_REPORT_WRITE_PATTERN.test(input.data)) {
          // The client's view of the mouse tracking modes lags the PTY by a
          // full round-trip, so a click's release can arrive after the
          // application stopped listening and would be typed into the shell
          // as junk. Flush pending output, then drop the report unless
          // tracking is still on.
          if (MOUSE_RELEASE_WRITE_PATTERN.test(input.data)) {
            // Apps such as btop act on the press and can take 100 ms+ to emit
            // their restore sequences while exiting. A release forwarded in
            // that window is never read and the tty queue hands it to the
            // next shell. Hold releases briefly so an exit in progress can
            // disable tracking first; presses and motions stay immediate to
            // keep drags responsive.
            yield* Effect.sleep(DEFAULT_MOUSE_RELEASE_HOLD_MS);
          }
          if (session.processEventDrainPid !== null) {
            yield* drainProcessEvents(session, session.processEventDrainPid);
          }
          if (
            !isMouseTrackingActive(session.trackedDecModes) ||
            session.status !== "running" ||
            session.process !== process
          ) {
            return;
          }
        }
        // A restart can replace the process while this write waited for the
        // permit. Deliver to the session's current process, never a stopped one.
        const liveProcess = session.process;
        if (!liveProcess || session.status !== "running") {
          if (session.status === "exited") return;
          return yield* new TerminalNotRunningError({
            threadId: input.threadId,
            terminalId,
          });
        }
        yield* Effect.try({
          try: () => liveProcess.write(input.data),
          catch: (cause) =>
            new TerminalWriteError({
              threadId: input.threadId,
              terminalId,
              terminalPid: liveProcess.pid,
              cause,
            }),
        });
      }),
    );
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    if (session.value.cols === input.cols && session.value.rows === input.rows) {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        if (session.processEventDrainPid !== null) {
          yield* drainProcessEvents(session, session.processEventDrainPid);
        }
        session.history = "";
        session.historyBytes = 0;
        session.persistenceHistory = "";
        session.persistenceHistoryBytes = 0;
        session.historyStartDecModes = new Map();
        session.persistenceStartDecModes = new Map();
        session.pendingHistoryControlSequence = "";
        session.pendingOutputHighSurrogate = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.pendingProcessEventBytes = 0;
        session.processOutputPaused = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId;
        yield* assertValidCwd(input.cwd);

        const sessionKey = toSessionKey(input.threadId, terminalId);
        const existingSession = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        if (Option.isNone(existingSession)) {
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          session = {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            status: "starting",
            pid: null,
            history: "",
            historyBytes: 0,
            persistenceHistory: "",
            persistenceHistoryBytes: 0,
            pendingHistoryControlSequence: "",
            trackedDecModes: new Map(),
            historyStartDecModes: new Map(),
            persistenceStartDecModes: new Map(),
            pendingOutputHighSurrogate: "",
            pendingProcessEvents: [],
            pendingProcessEventIndex: 0,
            pendingProcessEventBytes: 0,
            processOutputPaused: false,
            processEventDrainPid: null,
            processEventDrainSemaphore: yield* Semaphore.make(1),
            writeSemaphore: yield* Semaphore.make(1),
            exitCode: null,
            exitSignal: null,
            updatedAt: yield* nowIso,
            eventSequence: 0,
            cols,
            rows,
            process: null,
            unsubscribeData: null,
            unsubscribeExit: null,
            hasRunningSubprocess: false,
            childCommandLabel: null,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          };
          const createdSession = session;
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          yield* stopProcess(session);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;

        session.history = "";
        session.historyBytes = 0;
        session.persistenceHistory = "";
        session.persistenceHistoryBytes = 0;
        session.historyStartDecModes = new Map();
        session.persistenceStartDecModes = new Map();
        session.pendingHistoryControlSequence = "";
        session.pendingOutputHighSurrogate = "";
        resetPendingProcessQueue(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* startSession(
          session,
          {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            cols,
            rows,
            ...(input.env ? { env: input.env } : {}),
          },
          "restarted",
        );
        return snapshot(session);
      }),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  return TerminalManager.of({
    open,
    attachStream,
    readSnapshot,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
