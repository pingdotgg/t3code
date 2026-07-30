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

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
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
    terminalPid: Schema.Number,
    command: Schema.Literals(["powershell", "pgrep", "ps"]),
  },
) {
  override get message(): string {
    return `Failed to inspect terminal subprocesses for PID ${this.terminalPid} with ${this.command}`;
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
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

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
  /** Whether any process in the terminal's descendant tree cannot consume terminal replies. */
  readonly hasTerminalReplyUnawareSubprocess?: boolean;
  /**
   * Whether the shell itself owns the PTY's foreground process group
   * (`tpgid === pgid` of the terminal process) — i.e. the terminal is at an
   * interactive prompt, even if background jobs (`… &`) exist. `undefined`
   * when the platform/inspector can't tell (Windows, custom fixtures); callers
   * must treat that as unknown rather than equating any child with foreground
   * ownership.
   */
  readonly shellForeground?: boolean;
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
  pendingHistoryControlSequence: string;
  /** Incomplete client-input control sequence held across terminal.write calls. */
  pendingInputControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
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
  /**
   * Whether the shell owns the PTY's foreground process group (idle prompt,
   * possibly with background jobs). Drives the input reply-strip: strip only
   * while true — a foreground job (vim, a CPR-based UI) is reading the replies
   * to its own queries. `null` means the inspector failed or could not observe
   * foreground ownership; that state uses the safe idle-shell filtering policy
   * until a later probe provides a definitive answer.
   */
  shellForeground: boolean | null;
  /**
   * Advances whenever foreground ownership is refreshed. Periodic inspections
   * capture this revision before running outside the thread lock and may only
   * apply their result if it is still current.
   */
  subprocessInspectionRevision: number;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  /** Whether any current descendant is known not to consume terminal replies. */
  hasTerminalReplyUnawareSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: string | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
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

const TERMINAL_REPLY_UNAWARE_PAGERS = new Set(["less", "more", "most", "lv"]);

function isTerminalReplyUnawareCommand(raw: string, platform: NodeJS.Platform): boolean {
  const command = normalizeChildCommandName(raw, platform)?.toLowerCase();
  return command !== undefined && TERMINAL_REPLY_UNAWARE_PAGERS.has(command);
}

export function hasReplyUnawareForegroundProcess(input: {
  readonly platform: NodeJS.Platform;
  readonly foregroundProcessGroupId: number | undefined;
  readonly shellForeground: boolean | undefined;
  readonly childPid: number;
  readonly childCommand: string | null;
  readonly processes: ReadonlyArray<{
    readonly pid: number;
    readonly processGroupId: number | undefined;
    readonly command: string;
  }>;
}): boolean {
  const directChildIsReplyUnaware = isTerminalReplyUnawareCommand(
    input.childCommand ?? "",
    input.platform,
  );
  const directChild = input.processes.find((process) => process.pid === input.childPid);
  if (input.foregroundProcessGroupId === undefined) {
    return input.shellForeground === false && directChildIsReplyUnaware;
  }
  if (
    input.processes.some(
      (process) =>
        process.processGroupId === input.foregroundProcessGroupId &&
        isTerminalReplyUnawareCommand(process.command, input.platform),
    )
  ) {
    return true;
  }
  const observedForegroundProcess = input.processes.some(
    (process) => process.processGroupId === input.foregroundProcessGroupId,
  );
  // The tree-wide `ps` probe may omit command or group data while the focused
  // direct-child probe still succeeds. Preserve that known `less` result only
  // when no contradictory process-group observation exists.
  return (
    !observedForegroundProcess &&
    directChild?.processGroupId === undefined &&
    input.shellForeground === false &&
    directChildIsReplyUnaware
  );
}

function isTerminalReplyUnawarePager(session: TerminalSessionState): boolean {
  return session.hasTerminalReplyUnawareSubprocess;
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
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

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
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

function parseFirstChildPidFromPgrep(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/g)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

function windowsInspectSubprocess(
  terminalPid: number,
  platform: NodeJS.Platform,
): Effect.Effect<
  TerminalSubprocessInspectResult,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const command =
    'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
  return Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      // powershell.exe is a real executable — never spawn it through cmd.exe
      // shell mode, which would re-tokenize the `-Command` payload (pipes,
      // semicolons) before PowerShell ever sees it.
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeout: "1500 millis",
      maxOutputBytes: 32_768,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(
    Effect.map((result) => {
      if (result.code !== 0) {
        return { hasRunningSubprocess: false, childCommand: null, processIds: [] } as const;
      }
      const processNameById = new Map<number, string>();
      const childrenByParent = new Map<number, number[]>();
      for (const line of result.stdout.split(/\r?\n/g)) {
        const [pidRaw, parentPidRaw, nameRaw] = line.trim().split("|", 3);
        const pid = Number(pidRaw);
        const parentPid = Number(parentPidRaw);
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
        processNameById.set(pid, nameRaw?.trim() ?? "");
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
      }
      const directChildren = childrenByParent.get(terminalPid) ?? [];
      const childPid = directChildren[0];
      if (childPid === undefined) {
        return { hasRunningSubprocess: false, childCommand: null, processIds: [] } as const;
      }
      const processIds = new Set<number>([terminalPid]);
      const pending = [terminalPid];
      while (pending.length > 0) {
        const parentPid = pending.pop();
        if (parentPid === undefined) continue;
        for (const pid of childrenByParent.get(parentPid) ?? []) {
          if (processIds.has(pid)) continue;
          processIds.add(pid);
          pending.push(pid);
        }
      }
      const normalized = normalizeChildCommandName(processNameById.get(childPid) ?? "", platform);
      return {
        hasRunningSubprocess: true,
        childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
        processIds: [...processIds],
        // Windows does not expose POSIX foreground process groups. Restrict
        // the fallback to the direct child instead of letting a background
        // pager anywhere in the tree suppress replies for an interactive app.
        hasTerminalReplyUnawareSubprocess: isTerminalReplyUnawareCommand(
          processNameById.get(childPid) ?? "",
          platform,
        ),
      } as const;
    }),
    Effect.mapError(
      (cause) =>
        new TerminalSubprocessCheckError({
          cause,
          terminalPid,
          command: "powershell",
        }),
    ),
  );
}

const posixInspectSubprocess = Effect.fn("terminal.posixInspectSubprocess")(function* (
  terminalPid: number,
  platform: NodeJS.Platform,
): Effect.fn.Return<
  TerminalSubprocessInspectResult,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  // Foreground-ownership probe: the PTY's foreground process group (`tpgid`)
  // equals the shell's own group (`pgid`) exactly when the shell is at an
  // interactive prompt — background jobs (`… &`) keep tpgid on the shell while
  // a foreground vim/fzf moves it to the job's group. `undefined` when `ps`
  // fails or the fields don't parse (callers fall back to the child check).
  let shellForeground: boolean | undefined;
  let foregroundProcessGroupId: number | undefined;
  const tpgidResult = yield* Effect.exit(
    processRunner.run({
      command: "ps",
      args: ["-p", String(terminalPid), "-o", "tpgid=,pgid="],
      timeout: "1 second",
      maxOutputBytes: 8_192,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    }),
  );
  if (tpgidResult._tag === "Success" && tpgidResult.value.code === 0) {
    const [tpgidRaw, pgidRaw] = tpgidResult.value.stdout.trim().split(/\s+/g);
    const tpgid = Number(tpgidRaw);
    const pgid = Number(pgidRaw);
    if (Number.isInteger(tpgid) && Number.isInteger(pgid) && tpgid > 0 && pgid > 0) {
      shellForeground = tpgid === pgid;
      foregroundProcessGroupId = tpgid;
    }
  }

  const runPgrep = processRunner
    .run({
      command: "pgrep",
      args: ["-P", String(terminalPid)],
      timeout: "1 second",
      maxOutputBytes: 32_768,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            terminalPid,
            command: "pgrep",
          }),
      ),
    );

  const runPs = processRunner
    .run({
      command: "ps",
      args: ["-eo", "pid=,ppid=,pgid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            terminalPid,
            command: "ps",
          }),
      ),
    );

  let childPid: number | null = null;

  const pgrepResult = yield* Effect.exit(runPgrep);
  if (pgrepResult._tag === "Success") {
    if (pgrepResult.value.code === 0) {
      childPid = parseFirstChildPidFromPgrep(pgrepResult.value.stdout);
    } else if (pgrepResult.value.code === 1) {
      return {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
        ...(shellForeground !== undefined ? { shellForeground } : {}),
      };
    }
  }

  if (childPid === null) {
    const psResult = yield* Effect.exit(runPs);
    if (psResult._tag === "Failure" || psResult.value.code !== 0) {
      return {
        hasRunningSubprocess: false,
        childCommand: null,
        processIds: [],
        ...(shellForeground !== undefined ? { shellForeground } : {}),
      };
    }
    for (const line of psResult.value.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (ppid === terminalPid) {
        childPid = pid;
        break;
      }
    }
  }

  if (childPid === null) {
    return {
      hasRunningSubprocess: false,
      childCommand: null,
      processIds: [],
      ...(shellForeground !== undefined ? { shellForeground } : {}),
    };
  }

  const runComm = processRunner.run({
    command: "ps",
    args: ["-p", String(childPid), "-o", "comm="],
    timeout: "1 second",
    maxOutputBytes: 8_192,
    outputMode: "truncate",
    timeoutBehavior: "timedOutResult",
  });

  const commResult = yield* Effect.exit(runComm);
  let rawComm: string | null = null;
  if (commResult._tag === "Success" && commResult.value && commResult.value.code === 0) {
    rawComm = commResult.value.stdout.trim();
  }

  if (!rawComm || rawComm.length === 0) {
    const runArgs = processRunner.run({
      command: "ps",
      args: ["-p", String(childPid), "-o", "args="],
      timeout: "1 second",
      maxOutputBytes: 16_384,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
    const argsResult = yield* Effect.exit(runArgs);
    if (argsResult._tag === "Success" && argsResult.value && argsResult.value.code === 0) {
      const first = argsResult.value.stdout.trim().split(/\s+/)[0] ?? "";
      rawComm = first.length > 0 ? first : null;
    }
  }

  const normalized = rawComm ? normalizeChildCommandName(rawComm, platform) : null;
  const processIds = new Set<number>([terminalPid]);
  const processCommandById = new Map<number, string>();
  const processGroupById = new Map<number, number>();
  const psResult = yield* Effect.exit(runPs);
  if (psResult._tag === "Success" && psResult.value.code === 0) {
    const childrenByParent = new Map<number, number[]>();
    for (const line of psResult.value.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw, pgidRaw, command = ""] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      const pgid = Number(pgidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
      processCommandById.set(pid, command);
      processGroupById.set(pid, pgid);
      const children = childrenByParent.get(ppid) ?? [];
      children.push(pid);
      childrenByParent.set(ppid, children);
    }
    const pending = [terminalPid];
    while (pending.length > 0) {
      const parentPid = pending.pop();
      if (parentPid === undefined) continue;
      for (const child of childrenByParent.get(parentPid) ?? []) {
        if (processIds.has(child)) continue;
        processIds.add(child);
        pending.push(child);
      }
    }
  } else {
    processIds.add(childPid);
  }
  const hasReplyUnawareProcess = hasReplyUnawareForegroundProcess({
    platform,
    foregroundProcessGroupId,
    shellForeground,
    childPid,
    childCommand: normalized,
    processes: [...processIds].map((pid) => ({
      pid,
      processGroupId: processGroupById.get(pid),
      command: processCommandById.get(pid) ?? (pid === childPid ? (normalized ?? "") : ""),
    })),
  });
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
    hasTerminalReplyUnawareSubprocess: hasReplyUnawareProcess,
    ...(shellForeground !== undefined ? { shellForeground } : {}),
  };
});

function defaultSubprocessInspectorForPlatform(platform: NodeJS.Platform) {
  return Effect.fn("terminal.defaultSubprocessInspector")(function* (terminalPid: number) {
    if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
    if (platform === "win32") {
      return yield* windowsInspectSubprocess(terminalPid, platform);
    }
    return yield* posixInspectSubprocess(terminalPid, platform);
  });
}

/**
 * Resolve whether the shell owns the PTY from the best signal available.
 *
 * POSIX inspectors report foreground process-group ownership directly. When
 * that probe is unavailable, unknown is the conservative choice: ordinary keys
 * still pass, but capability replies are filtered. Windows has no equivalent
 * ownership probe, so preserve its previous behavior and treat a running child
 * as foreground; otherwise full-screen programs lose their terminal replies.
 */
function resolveShellForeground(
  platform: NodeJS.Platform,
  inspection: TerminalSubprocessInspectResult,
): boolean | null {
  if (inspection.shellForeground !== undefined) return inspection.shellForeground;
  if (!inspection.hasRunningSubprocess) return true;
  return platform === "win32" ? false : null;
}

/**
 * Upper bound on retained scrollback CHARACTERS, complementing the line limit.
 *
 * The line cap alone cannot bound a full-screen program: synchronized-output
 * redraw frames (cursor addressing + `CSI K` clears, no newlines) make a
 * single "line" arbitrarily large — observed 21 MB of history at only 4,999
 * lines from a TUI repainting on a spinner tick. That bloats server memory
 * (`session.history`), the persisted log, and the reattach snapshot shipped
 * to clients. 2 MiB comfortably holds 5,000 lines of ordinary shell output.
 */
const DEFAULT_HISTORY_CHAR_LIMIT = 2 * 1024 * 1024;

function capHistory(history: string, maxLines: number, maxChars: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  let capped = history;
  if (lines.length > maxLines) {
    const joined = lines.slice(lines.length - maxLines).join("\n");
    capped = hasTrailingNewline ? `${joined}\n` : joined;
  }
  if (capped.length > maxChars) {
    // Cut from the head at the friendliest boundary inside the excess: the
    // next line start if one exists, else the next escape introducer (a
    // frame-ish boundary in redraw streams), else a hard cut. A torn leading
    // sequence degrades exactly like the line cap tearing SGR state does.
    const cut = capped.length - maxChars;
    const newline = capped.indexOf("\n", cut);
    if (newline !== -1 && newline < cut + 64 * 1024) {
      capped = capped.slice(newline + 1);
    } else {
      const escape = capped.indexOf("\u001b", cut);
      const sliceAt = escape !== -1 && escape < cut + 64 * 1024 ? escape : cut;
      const codePoint = capped.charCodeAt(sliceAt);
      const unicodeSafeSliceAt =
        sliceAt > 0 && codePoint >= 0xdc00 && codePoint <= 0xdfff ? sliceAt - 1 : sliceAt;
      capped = capped.slice(unicodeSafeSliceAt);
    }
  }
  return capped;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

// ─── Canonical terminal capability-sequence grammar ─────────────────────────
//
// Single source of truth for every capability sequence the sanitizer knows.
// ALL matching layers derive from this table — the framed strip rules for the
// scrollback and live views, the client-input reply filter, and the flattened
// residue patterns — so a sequence type added here is wired into every layer
// at once and the layers cannot drift out of sync (the recurring review
// finding class: "handled in layer X but missed in layer Y").
//
// Semantics per entry:
//   response (terminal→host): spurious echo in output — stripped from history
//     AND live when `stripFromOutput` (OSC 4 rgb is the exception: in output
//     that shape is the legitimate set-palette command); stripped from client
//     input via `input` (the emulator auto-reply that feeds the idle-prompt
//     echo loop; null relays it).
//   query (host→terminal): stripped from scrollback (a replay would re-trigger
//     the emulator's answer) but relayed live so the client answers it.
//   flattened: the reply's parameters echoed as visible text once the shell
//     flattened away the introducer; stripped in runs, and alone only when
//     `loneStrippable` (unambiguous shapes).
//
// `samples` hold concrete bodies for the cross-layer invariant tests: every
// layer is exercised against every sample in 7-bit and 8-bit framings, so a
// half-wired entry fails the suite instead of shipping.
export interface TerminalSequenceDescriptor {
  readonly name: string;
  readonly kind: "csi" | "osc" | "dcs";
  readonly response?: {
    /** Framed body (CSI: full body incl. final byte; OSC/DCS: content prefix). */
    readonly body: string;
    readonly stripFromOutput: boolean;
    /** Input-filter body (null = relayed in input). */
    readonly input: string | null;
    readonly samples: ReadonlyArray<string>;
  };
  readonly query?: {
    readonly body: string;
    readonly samples: ReadonlyArray<string>;
  };
  readonly flattened?: {
    readonly source: string;
    readonly loneStrippable: boolean;
    readonly samples: ReadonlyArray<string>;
  };
}

export const TERMINAL_SEQUENCE_GRAMMAR: ReadonlyArray<TerminalSequenceDescriptor> = [
  {
    name: "DECRPM mode report / DECRQM query",
    kind: "csi",
    response: {
      body: "[?0-9;]*\\$y",
      stripFromOutput: true,
      input: "\\?[0-9;]*\\$y",
      samples: ["?2026;2$y", "?69;0$y"],
    },
    query: { body: "[?0-9;]*\\$p", samples: ["?2026$p"] },
    flattened: {
      source: "[0-9]+;[0-9]+\\$y",
      loneStrippable: true,
      samples: ["2026;2$y", "69;0$y"],
    },
  },
  {
    name: "device attributes (primary/secondary DA)",
    kind: "csi",
    response: {
      // Responses carry parameters; the bare `CSI c` / `CSI ? c` / `CSI > c`
      // query forms deliberately do NOT match (covered by `query` below).
      body: "(?:\\?[0-9;]+|>[0-9]+;[0-9;]+)c",
      stripFromOutput: true,
      input: "[?>][0-9;]+c",
      samples: ["?1;2c", ">0;276;0c"],
    },
    query: { body: "[>0-9;?]*c", samples: ["c", ">c", "?c"] },
    flattened: {
      // Two or three params, the `>` sometimes preserved by the echo. Run-only:
      // a lone "1;2c" is indistinguishable from ordinary text.
      source: ">?[0-9]+;[0-9]+(?:;[0-9]+)?c",
      loneStrippable: false,
      samples: ["1;2c", ">0;276;0c", "0;276;0c"],
    },
  },
  {
    name: "device status report (DSR)",
    kind: "csi",
    response: {
      body: "\\??[03]n",
      stripFromOutput: true,
      input: "\\??[03]n",
      samples: ["0n", "3n", "?0n"],
    },
    // Any other `n`-final CSI (`CSI 5 n`, `CSI 6 n`, DEC forms) is a query —
    // `[^]*` keeps scrollback stripping every n-final CSI, as it always has.
    query: { body: "[^]*n", samples: ["5n", "6n"] },
  },
  {
    name: "cursor position report (CPR / DECXCPR)",
    kind: "csi",
    response: {
      body: "[0-9;?]*R",
      stripFromOutput: true,
      // Input requires the two-parameter reply shape so a bare `CSI R` or
      // anything keystroke-like is never eaten. `CSI 1;<mod>R` also encodes a
      // modified F3 key, but this filter runs only while the shell owns the PTY;
      // nested renderers issue CPR queries the server cannot observe, so leaving
      // that collision unfiltered lets their replies feed a runaway prompt loop.
      input: "\\??[0-9]*;[0-9]+R",
      samples: ["1;1R", "?5;10R", ";1R"],
    },
    flattened: {
      // The `;1RR` prompt-flood shape; the echoed "R" can double. Run-only.
      source: "[0-9]*;[0-9]+R+",
      loneStrippable: false,
      samples: [";1RR", "1;1R"],
    },
  },
  {
    name: "terminal focus report",
    kind: "csi",
    response: {
      // Focus reports are terminal-generated input. The manager applies this
      // filter only while the shell owns the foreground PTY; vim/tmux and other
      // foreground programs still receive focus reports verbatim.
      body: "[IO]",
      stripFromOutput: false,
      input: "[IO]",
      samples: ["I", "O"],
    },
  },
  {
    name: "empty OSC response fragment",
    kind: "osc",
    response: {
      // A response split badly by a client parser can collapse to OSC + ST.
      // It has no keyboard meaning and must not reach an idle shell.
      body: "",
      stripFromOutput: false,
      input: "",
      samples: [""],
    },
  },
  {
    name: "empty DCS response fragment",
    kind: "dcs",
    response: {
      body: "",
      stripFromOutput: false,
      input: "",
      samples: [""],
    },
  },
  {
    name: "OSC 10/11/12 colour",
    kind: "osc",
    response: {
      // In OUTPUT `OSC 1[012];rgb:` is the legitimate set-default-colour
      // command (themes) — like OSC 4, never stripped there; the reply shape
      // only travels as client input, where it is dropped. A framed reply
      // replayed from an old log re-applies the colour the terminal already
      // has (a no-op set), never re-triggering the echo loop.
      body: "(?:10|11|12);rgb:",
      stripFromOutput: false,
      input: "1[012];rgb:[0-9a-fA-F/]*(?:;rgb:[0-9a-fA-F/]*)*",
      samples: [
        "11;rgb:1616/1616/1616",
        "10;rgb:ffff/ffff/ffff",
        "10;rgb:ffff/ffff/ffff;rgb:1616/1616/1616",
      ],
    },
    query: { body: "(?:10|11|12);\\?", samples: ["11;?"] },
    flattened: {
      // Pinned to the real OSC numbers (never an unbounded `(?:[0-9]+;)+` run —
      // that both over-matched ordinary "<n>;rgb:…" text and was a ReDoS). The
      // lookbehind skips a colour run still inside an intact OSC frame the
      // escape walk chose to keep.
      source: "(?<!\\x1b\\]|\\x9d)(?:1[012];rgb:[0-9a-fA-F/]+|(?<![0-9a-fA-F/]);rgb:[0-9a-fA-F/]+)",
      loneStrippable: true,
      samples: ["11;rgb:1616/1616/1616"],
    },
  },
  {
    name: "OSC 4 palette colour",
    kind: "osc",
    response: {
      // In OUTPUT `OSC 4;<idx>;rgb:` is the legitimate set-palette command
      // (themes) — never stripped there. The reply shape only travels as
      // client input, where it is dropped.
      body: "4;[0-9]+;rgb:",
      stripFromOutput: false,
      input: "4;[0-9]+;rgb:[0-9a-fA-F/]*",
      samples: ["4;1;rgb:1616/1616/1616"],
    },
    query: { body: "4;[0-9]+;\\?", samples: ["4;1;?"] },
    flattened: {
      // Same framed-lookbehind guard as OSC 10/11/12: a kept framed OSC 4
      // set-palette command must not have its inner payload deleted.
      source: "(?<!\\x1b\\]|\\x9d)(?:4;[0-9]+|(?<![0-9]);[0-9]+);rgb:[0-9a-fA-F/]+",
      loneStrippable: true,
      samples: ["4;0;rgb:1818/1e1e/2626"],
    },
  },
  {
    name: "DECRPSS / DECRQSS status strings",
    kind: "dcs",
    response: {
      body: "[01]?\\$r",
      stripFromOutput: true,
      input: "[01]?\\$r[^\\x1b\\x07\\x9c]*",
      samples: ["1$r0m"],
    },
    query: { body: "\\$q", samples: ["$qm"] },
    flattened: {
      // Length-bounded payload: unbounded `[0-9;]*` both ate following number
      // runs of legitimate text and was a backtracking hazard.
      source: "[01]\\$r[0-9;]{0,8}[a-zA-Z]",
      loneStrippable: true,
      samples: ["1$r0m"],
    },
  },
];

// One composed matcher per (kind × class), derived once at module load. CSI
// bodies (incl. final byte) must match fully; OSC/DCS bodies are content
// prefixes, mirroring how the walk hands them over.
function composeFramedMatcher(
  kind: TerminalSequenceDescriptor["kind"],
  sources: ReadonlyArray<string>,
): RegExp | null {
  if (sources.length === 0) return null;
  const alternation = sources.map((source) => `(?:${source})`).join("|");
  return kind === "csi" ? new RegExp(`^(?:${alternation})$`) : new RegExp(`^(?:${alternation})`);
}

function framedMatchers(kind: TerminalSequenceDescriptor["kind"]) {
  const entries = TERMINAL_SEQUENCE_GRAMMAR.filter((descriptor) => descriptor.kind === kind);
  return {
    response: composeFramedMatcher(
      kind,
      entries.flatMap((d) => (d.response?.stripFromOutput ? [d.response.body] : [])),
    ),
    query: composeFramedMatcher(
      kind,
      entries.flatMap((d) => (d.query ? [d.query.body] : [])),
    ),
  };
}

const CSI_MATCHERS = framedMatchers("csi");
const OSC_MATCHERS = framedMatchers("osc");
const DCS_MATCHERS = framedMatchers("dcs");

/**
 * Whether a CSI sequence should be dropped from the sanitized terminal stream.
 * `responsesOnly` (the live view) strips only terminal→host responses; the
 * default (scrollback) also strips host→terminal queries so a replay can't
 * re-trigger one. Derived from {@link TERMINAL_SEQUENCE_GRAMMAR}.
 */
function shouldStripCsiSequence(body: string, finalByte: string, responsesOnly = false): boolean {
  const full = `${body}${finalByte}`;
  if (CSI_MATCHERS.response?.test(full)) return true;
  if (!responsesOnly && CSI_MATCHERS.query?.test(full)) return true;
  return false;
}

/** OSC counterpart of {@link shouldStripCsiSequence} (tests content, not body+final). */
function shouldStripOscSequence(content: string, responsesOnly = false): boolean {
  if (OSC_MATCHERS.response?.test(content)) return true;
  if (!responsesOnly && OSC_MATCHERS.query?.test(content)) return true;
  return false;
}

/**
 * DCS counterpart. Only the `$`-intermediate capability-negotiation forms are
 * classified; other DCS (sixel, DECUDK, tmux passthrough) is left untouched.
 */
function shouldStripDcsSequence(content: string, responsesOnly = false): boolean {
  if (DCS_MATCHERS.response?.test(content)) return true;
  if (!responsesOnly && DCS_MATCHERS.query?.test(content)) return true;
  return false;
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

// Flattened-residue patterns, derived from the grammar. RUN strips 2+
// fragments in sequence; TOKEN additionally strips the unambiguous shapes even
// in isolation. Fragments in an echoed run are adjacent or separated by BEL/CR/
// a flattened DSR "n" tail — never by a space (verified against the captured
// logs): a space is ordinary text, and including it would let a run bridge
// across real words and delete an ambiguous lone token next to a genuine one
// ("see 1;2c 2026;2$y").
const FLATTENED_SOURCES = TERMINAL_SEQUENCE_GRAMMAR.flatMap((descriptor) =>
  descriptor.flattened ? [descriptor.flattened] : [],
);
const FLATTENED_FRAGMENT = `(?:${FLATTENED_SOURCES.map((f) => `(?:${f.source})`).join("|")})`;
const FLATTENED_REPLY_RUN = new RegExp(
  `${FLATTENED_FRAGMENT}(?:[\\x07\\rnR]{0,8}${FLATTENED_FRAGMENT})+[\\x07R]{0,8}`,
  "g",
);
const FLATTENED_REPLY_TOKEN = new RegExp(
  `(?:${FLATTENED_SOURCES.filter((f) => f.loneStrippable)
    .map((f) => `(?:${f.source})`)
    .join("|")})`,
  "g",
);
// Readline renders control input it cannot consume using caret notation. These
// are the visible forms captured in the corrupted terminal log, not live ESC
// sequences: `^[[I`, `^[[?1;2c`, `^[[0n`, and empty `^[]^[\` OSC frames.
const CARET_NOTATION_TERMINAL_REPLY = new RegExp(
  [
    "\\^\\[\\[(?:\\??[0-9]*;[0-9]+R|[?>][0-9;]+c|\\??[03]n|\\?[0-9;]*\\$y|[IO]|\\?)",
    "\\^\\[\\]\\^\\[\\\\",
  ].join("|"),
  "g",
);
function isPaletteReplyResidueCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x46) ||
    (codePoint >= 0x61 && codePoint <= 0x66) ||
    codePoint === 0x2f ||
    codePoint === 0x3a ||
    codePoint === 0x3b ||
    codePoint === 0x24 ||
    codePoint === 0x52 ||
    codePoint === 0x62 ||
    codePoint === 0x67 ||
    codePoint === 0x72 ||
    codePoint === 0x79
  );
}

/**
 * Drop a multiplexer-flattened palette run in linear time.
 *
 * OpenTUI's palette probe can be fragmented so aggressively that several OSC
 * replies collapse into one introducer-less token. A maximal token made only
 * from reply characters is corruption when it contains at least three `rgb:`
 * bodies. The threshold avoids deleting ordinary output with one CSS colour,
 * and the explicit scan avoids a nested-regex ReDoS on long `;` input.
 */
function stripCorruptedPaletteReplyRuns(text: string): string {
  if (!text.includes("rgb:")) return text;

  let output = "";
  let copiedThrough = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (!isPaletteReplyResidueCharacter(text.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }

    const tokenStart = cursor;
    let rgbCount = 0;
    let removalStart = -1;
    while (cursor < text.length && isPaletteReplyResidueCharacter(text.charCodeAt(cursor))) {
      if (removalStart === -1) {
        const codePoint = text.charCodeAt(cursor);
        if ((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x3b) {
          removalStart = cursor;
        }
      }
      if (text.startsWith("rgb:", cursor)) rgbCount += 1;
      cursor += 1;
    }

    if (rgbCount >= 3) {
      const start = removalStart === -1 ? tokenStart : removalStart;
      output += text.slice(copiedThrough, start);
      copiedThrough = cursor;
    }
  }
  return copiedThrough === 0 ? text : output + text.slice(copiedThrough);
}
/**
 * Drop the flattened terminal-reply residue a shell echoes at the prompt.
 *
 * When a capability reply lands at an idle prompt the shell echoes its
 * *flattened* parameters as visible text (the ESC introducer is already gone, so
 * the escape-aware strip can't see it). Two passes: drop a run of 2+ flattened
 * fragments (DSR "n"/BEL/CR may separate them), then drop the unambiguous
 * OSC-colour / DECRPM / DECRPSS tokens even when isolated. Ambiguous lone
 * "<m>;<v>c" / "n" forms and ordinary words (e.g. "running", "1;2c") are kept.
 */
function stripFlattenedModeReplyResidue(text: string): string {
  const withoutCaretNotation = stripCorruptedPaletteReplyRuns(
    text.replace(CARET_NOTATION_TERMINAL_REPLY, ""),
  );
  // Every fragment contains either ";" (DECRPM/DA/OSC) or "$r" (DECRPSS), so text
  // with neither can't hold residue — skip the regexes.
  if (!withoutCaretNotation.includes(";") && !withoutCaretNotation.includes("$r")) {
    return withoutCaretNotation;
  }
  return withoutCaretNotation.replace(FLATTENED_REPLY_RUN, "").replace(FLATTENED_REPLY_TOKEN, "");
}

// Matches the terminal→host response sequences the browser emulator
// auto-generates in answer to a program's capability queries: DECRPM "$y",
// device-attributes "c", device-status "0n"/"3n", cursor-position report
// "<row>;<col>R" (CPR), OSC 10/11/12 + OSC 4 palette colour, and DECRPSS "$r".
// Each introducer accepts both the 7-bit ESC form and the 8-bit C1 byte (CSI
// 0x9b, OSC 0x9d, DCS 0x90), and each terminator the BEL, ESC\, or 8-bit ST
// (0x9c) — matching the output sanitizer so a C1-encoded reply can't slip past.
//
// CPR (`CSI <row>;<col> R`) IS stripped: like the other capability replies it is
// an emulator auto-answer (to `CSI 6 n`), and a prompt that re-queries on redraw
// makes the echoed reply the worst runaway-flood source (issue: a prompt's
// `;1RR` flood). The `;`-separated two-parameter form is required, so it never
// matches a single keystroke or a bare `CSI R`. The bare DSR query forms are
// kept — the DA alternation requires a parameter so `CSI ? c` / `CSI > c` and
// `CSI 6 n` queries pass through.
//
// Focus in/out (CSI I / CSI O) are stripped at an idle shell too: the captured
// flood showed repeated focus-in reports redrawing the prompt and re-triggering
// its capability queries. The manager bypasses this entire filter for a
// foreground program, so vim/tmux still receive legitimate focus events.
const INPUT_CSI = "(?:\\x1b\\[|\\x9b)";
const INPUT_OSC = "(?:\\x1b\\]|\\x9d)";
const INPUT_DCS = "(?:\\x1bP|\\x90)";
const INPUT_ST = "(?:\\x07|\\x1b\\\\|\\x9c)";
const INPUT_CONTROL_INTRODUCER = "(?:\\x1b[\\[\\]P]|[\\x90\\x9b\\x9d])";
const ABANDONED_CSI_INPUT_PREFIX = new RegExp(
  `${INPUT_CSI}[\\x20-\\x3f]*(?=${INPUT_CONTROL_INTRODUCER})`,
  "g",
);
function composeInputMatcher(): RegExp | null {
  const sources = TERMINAL_SEQUENCE_GRAMMAR.flatMap((descriptor) => {
    const response = descriptor.response;
    if (!response || response.input === null) return [];
    switch (descriptor.kind) {
      case "csi":
        return [`${INPUT_CSI}(?:${response.input})`];
      case "osc":
        return [`${INPUT_OSC}(?:${response.input})${INPUT_ST}`];
      case "dcs":
        return [`${INPUT_DCS}(?:${response.input})${INPUT_ST}`];
    }
  });
  return sources.length === 0 ? null : new RegExp(sources.join("|"), "g");
}

const INPUT_TERMINAL_RESPONSE = composeInputMatcher();
/**
 * Strip the browser emulator's auto-generated terminal responses from client
 * input before it reaches the PTY.
 *
 * The emulator answers the program's capability queries (DECRPM, device
 * attributes, device status, cursor position, OSC colour) and emits focus
 * events, sending them all as input. At an idle prompt the shell has no reader
 * for them, so it echoes them — and a prompt that re-queries on redraw turns
 * that into a runaway feedback loop. A user never types these, so dropping them
 * at the source breaks the loop. The cursor-position report (CPR) is the most
 * aggressive offender (a prompt's `;1RR` flood), so its two-parameter
 * `CSI <row>;<col> R` reply is stripped too; only the bare query forms
 * (`CSI 6 n`, `CSI ? c`) are kept.
 *
 * The write path only applies this while NO foreground subprocess is running
 * (the idle-prompt scenario above): a running program (vim, a CPR-based UI) is
 * presumed to be reading the replies to its own queries, and stripping them
 * would stall its capability negotiation. Exported for unit testing.
 */
export function stripTerminalResponsesFromInput(data: string): string {
  // Skip the regexes unless the data carries a 7-bit ESC or one of the 8-bit C1
  // introducers (CSI 0x9b, OSC 0x9d, DCS 0x90) a response could start with.
  const hasIntroducer =
    data.includes("\x1b") ||
    data.includes("\x9b") ||
    data.includes("\x9d") ||
    data.includes("\x90");
  if (!hasIntroducer) return data;
  return INPUT_TERMINAL_RESPONSE ? data.replace(INPUT_TERMINAL_RESPONSE, "") : data;
}

// Upper bound on the buffered incomplete-sequence remainder. An unterminated
// OSC/DCS introducer (a program killed mid-escape-write, or binary output
// containing a stray 0x9d/0x90 byte) would otherwise swallow ALL subsequent
// output into `pendingControlSequence` forever — freezing the live stream and
// growing server memory unboundedly. Past this cap the stuck introducer is
// emitted verbatim and the rest re-sanitized (see sanitizeTerminalChunkDual),
// so the stream recovers and complete sequences after the introducer still get
// stripped. Sized to hold any realistic legitimate cross-chunk sequence (OSC 52
// clipboard payloads, tmux-passthrough wrappers); a larger-than-cap sixel
// merely degrades to raw passthrough of bytes the sanitizer keeps anyway.
const MAX_PENDING_CONTROL_SEQUENCE_LENGTH = 64 * 1024;

/**
 * Single parse of a chunk that produces BOTH sanitized views at once:
 *   - `historyText`: the scrollback strip — drops terminal queries AND responses
 *     so a replay can never re-trigger a query whose answer would echo.
 *   - `liveText`: the live-stream strip — drops only terminal→host responses
 *     (spurious echo) while relaying host→terminal queries the client answers.
 *
 * Both share one walk and one pending-sequence boundary: the boundary depends
 * only on byte structure (where an incomplete escape sequence ends), never on
 * which complete sequences are stripped, so it is identical for both views.
 */
function sanitizeTerminalChunkOnce(input: string): {
  historyText: string;
  liveText: string;
  inputText: string;
  pendingControlSequence: string;
} {
  let historyText = "";
  let liveText = "";
  let inputText = "";
  let index = 0;

  // Ordinary text and sequences neither view strips go to both buffers.
  const appendBoth = (value: string) => {
    historyText += value;
    liveText += value;
    inputText += value;
  };
  // A CSI sequence: each view keeps it unless its own strip rule removes it.
  const appendCsi = (sequence: string, body: string, finalByte: string) => {
    if (!shouldStripCsiSequence(body, finalByte, false)) historyText += sequence;
    if (!shouldStripCsiSequence(body, finalByte, true)) liveText += sequence;
    inputText += stripTerminalResponsesFromInput(sequence);
  };
  const appendOsc = (sequence: string, content: string) => {
    if (!shouldStripOscSequence(content, false)) historyText += sequence;
    if (!shouldStripOscSequence(content, true)) liveText += sequence;
    inputText += stripTerminalResponsesFromInput(sequence);
  };
  const appendDcs = (sequence: string, content: string) => {
    if (!shouldStripDcsSequence(content, false)) historyText += sequence;
    if (!shouldStripDcsSequence(content, true)) liveText += sequence;
    inputText += stripTerminalResponsesFromInput(sequence);
  };
  const pending = () => ({
    historyText: stripFlattenedModeReplyResidue(historyText),
    liveText: stripFlattenedModeReplyResidue(liveText),
    inputText,
    pendingControlSequence: input.slice(index),
  });

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return pending();
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            appendCsi(sequence, body, input[cursor] ?? "");
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return pending();
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
          return pending();
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        if (nextCodePoint === 0x5d) {
          appendOsc(sequence, content);
        } else if (nextCodePoint === 0x50) {
          appendDcs(sequence, content);
        } else {
          appendBoth(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return pending();
      }
      appendBoth(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          appendCsi(sequence, body, input[cursor] ?? "");
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return pending();
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return pending();
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      if (codePoint === 0x9d) {
        appendOsc(sequence, content);
      } else if (codePoint === 0x90) {
        appendDcs(sequence, content);
      } else {
        appendBoth(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    appendBoth(input[index] ?? "");
    index += 1;
  }

  return {
    historyText: stripFlattenedModeReplyResidue(historyText),
    liveText: stripFlattenedModeReplyResidue(liveText),
    inputText,
    pendingControlSequence: "",
  };
}

// Bounded number of overflow recoveries per chunk. Each recovery emits the
// stuck introducer verbatim and RE-SANITIZES the rest of the remainder, so
// complete sequences after an unterminated introducer still get stripped
// instead of being flushed raw into history. The bound keeps an adversarial
// introducer-flood from turning the walk quadratic; past it the remainder is
// flushed verbatim (raw passthrough).
const MAX_PENDING_OVERFLOW_RECOVERIES = 4;

/**
 * {@link sanitizeTerminalChunkOnce} plus overflow recovery: when the buffered
 * incomplete-sequence remainder exceeds {@link MAX_PENDING_CONTROL_SEQUENCE_LENGTH}
 * (an unterminated OSC/DCS introducer would otherwise swallow all subsequent
 * output forever), the stuck introducer is emitted verbatim and the rest is
 * re-walked so it is still properly sanitized.
 */
function sanitizeTerminalChunkDual(
  pendingControlSequence: string,
  data: string,
): { historyText: string; liveText: string; pendingControlSequence: string } {
  let historyText = "";
  let liveText = "";
  let input = `${pendingControlSequence}${data}`;
  for (let recoveries = 0; recoveries < MAX_PENDING_OVERFLOW_RECOVERIES; recoveries += 1) {
    const walk = sanitizeTerminalChunkOnce(input);
    historyText += walk.historyText;
    liveText += walk.liveText;
    if (walk.pendingControlSequence.length <= MAX_PENDING_CONTROL_SEQUENCE_LENGTH) {
      return {
        historyText,
        liveText,
        pendingControlSequence: walk.pendingControlSequence,
      };
    }
    // Overflowed: the remainder starts at an introducer that never terminated.
    // Emit the introducer bytes verbatim and re-sanitize everything after them.
    const stuck = walk.pendingControlSequence;
    const introducerLength = stuck.charCodeAt(0) === 0x1b ? 2 : 1;
    const introducer = stuck.slice(0, introducerLength);
    historyText += introducer;
    liveText += introducer;
    input = stuck.slice(introducerLength);
  }
  // Recovery budget exhausted (adversarial introducer flood): flush raw.
  return {
    historyText: historyText + input,
    liveText: liveText + input,
    pendingControlSequence: "",
  };
}

/**
 * Sanitize one chunk of terminal output. `responsesOnly` selects the live-stream
 * view (strips only terminal responses, relaying queries the client answers);
 * the default selects the scrollback view (also strips queries). Both are
 * computed in one pass — see {@link sanitizeTerminalChunkDual}. Exported for unit
 * testing.
 */
export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
  options: { readonly responsesOnly?: boolean } = {},
): { visibleText: string; pendingControlSequence: string } {
  const dual = sanitizeTerminalChunkDual(pendingControlSequence, data);
  return {
    visibleText: (options.responsesOnly ?? false) ? dual.liveText : dual.historyText,
    pendingControlSequence: dual.pendingControlSequence,
  };
}

/**
 * Stateful counterpart to {@link stripTerminalResponsesFromInput}. Client
 * transports are allowed to split a terminal reply across multiple writes; the
 * old stateless filter passed the first half to the PTY and could no longer
 * recognize the suffix. This uses the same structural walk and declarative
 * grammar as output sanitization, holding only an incomplete control sequence.
 */
export function sanitizeTerminalInputChunk(
  pendingControlSequence: string,
  data: string,
): { data: string; pendingControlSequence: string } {
  // A client parser can time out after a partial CSI parameter sequence, then
  // begin the next response with a fresh introducer. Treat the abandoned prefix
  // as residue; otherwise the second `[` is mistaken for the first sequence's
  // final byte and both prefixes leak to the shell as visible text.
  const input = `${pendingControlSequence}${data}`.replace(ABANDONED_CSI_INPUT_PREFIX, "");
  const parsed = sanitizeTerminalChunkOnce(input);

  // Match the live-output parser's memory bound. A malformed client must not
  // grow session state forever by opening an OSC/DCS string without a
  // terminator; beyond the cap, degrade to verbatim input and recover.
  if (parsed.pendingControlSequence.length > MAX_PENDING_CONTROL_SEQUENCE_LENGTH) {
    return {
      data: `${parsed.inputText}${parsed.pendingControlSequence}`,
      pendingControlSequence: "",
    };
  }

  return {
    data: parsed.inputText,
    pendingControlSequence: parsed.pendingControlSequence,
  };
}

/**
 * Whether a client write is (or starts) a terminal-generated capability reply.
 *
 * This is intentionally structural rather than a second signature list: the
 * canonical input sanitizer above owns reply recognition. An incomplete
 * sequence also counts so a transport split cannot send its prefix to the PTY
 * before foreground ownership is refreshed.
 */
function mayContainTerminalResponse(pendingControlSequence: string, data: string): boolean {
  if (pendingControlSequence.length > 0) return true;
  const hasIntroducer =
    data.includes("\x1b") ||
    data.includes("\x9b") ||
    data.includes("\x9d") ||
    data.includes("\x90");
  if (!hasIntroducer) return false;
  const sanitized = sanitizeTerminalInputChunk("", data);
  return sanitized.data !== data || sanitized.pendingControlSequence.length > 0;
}

/**
 * Sanitize a WHOLE persisted scrollback buffer for load/migration, losslessly.
 *
 * Unlike the per-chunk API, there is no next chunk: a trailing incomplete
 * sequence (an unterminated OSC/DCS introducer a program left mid-write) must
 * be appended back VERBATIM rather than held in `pendingControlSequence` —
 * discarding it would silently truncate everything after the introducer, and
 * the caller persists the result over the log file, making the loss permanent.
 * Exported for unit testing.
 */
export function sanitizePersistedTerminalHistory(raw: string): string {
  // Single walk with NO overflow recovery: the streaming path's 64 KiB cap
  // exists to keep a LIVE stream from freezing, but here the whole buffer is
  // already in hand and the result is persisted back over the log file — the
  // trailing incomplete sequence must be preserved byte-for-byte however large
  // it is, never re-sanitized as if it were ordinary text.
  const result = sanitizeTerminalChunkOnce(raw);
  return `${result.historyText}${result.pendingControlSequence}`;
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
// PATH-style variables the AppImage runtime prepends with its temporary mount
// (e.g. /tmp/.mount_T3-XXXX/usr/bin). Only the mount segments are dropped; the
// user's real entries are preserved.
const APPIMAGE_PATH_LIKE_ENV_KEYS = ["PATH", "LD_LIBRARY_PATH"] as const;

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
  historyLineLimit?: number;
  historyCharLimit?: number;
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
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyCharLimit = options.historyCharLimit ?? DEFAULT_HISTORY_CHAR_LIMIT;
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const subprocessInspector =
    options.subprocessInspector ??
    ((terminalPid) =>
      defaultSubprocessInspectorForPlatform(platform)(terminalPid).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ));
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
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem.writeFileString(historyPath(threadId, terminalId), request.history).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }),
  });

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
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
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

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
      // Sanitize on load so terminal query/response residue persisted by older
      // builds (the "…$y" / colour-report garble) is stripped from replayed
      // scrollback — not just from newly-written output. Idempotent for clean
      // logs; the rewrite below persists the cleanup.
      const capped = capHistory(
        sanitizePersistedTerminalHistory(raw),
        historyLineLimit,
        historyCharLimit,
      );
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
    // Sanitize while migrating so the new-path log starts clean (see above).
    const capped = capHistory(
      sanitizePersistedTerminalHistory(raw),
      historyLineLimit,
      historyCharLimit,
    );
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

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          // One parse yields both views: the scrollback strip (drops queries and
          // responses) feeds history; the live strip (drops only responses,
          // relaying queries the client answers) feeds the streamed data.
          const sanitized = sanitizeTerminalChunkDual(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.historyText.length > 0) {
            session.history = capHistory(
              `${session.history}${sanitized.historyText}`,
              historyLineLimit,
              historyCharLimit,
            );
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.historyText.length > 0 ? session.history : null,
            data: sanitized.liveText,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.shellForeground = true;
        session.subprocessInspectionRevision += 1;
        session.childCommandLabel = null;
        session.hasTerminalReplyUnawareSubprocess = false;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingInputControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
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
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
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

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.shellForeground = true;
      session.subprocessInspectionRevision += 1;
      session.childCommandLabel = null;
      session.hasTerminalReplyUnawareSubprocess = false;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingInputControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
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
      session.shellForeground = true;
      session.subprocessInspectionRevision += 1;
      session.childCommandLabel = null;
      session.hasTerminalReplyUnawareSubprocess = false;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
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
              if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
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
        session.shellForeground = true;
        session.childCommandLabel = null;
        session.hasTerminalReplyUnawareSubprocess = false;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
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
      yield* persistHistory(threadId, terminalId, session.value.history);
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
    const runningSessions = [...state.sessions.values()]
      .filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      )
      .map((session) => ({
        threadId: session.threadId,
        terminalId: session.terminalId,
        pid: session.pid,
        subprocessInspectionRevision: session.subprocessInspectionRevision,
      }));

    if (runningSessions.length === 0) {
      return;
    }

    const inspectSubprocessActivity = Effect.fn("terminal.inspectSubprocessActivity")(function* (
      session: (typeof runningSessions)[number],
    ) {
      const terminalPid = session.pid;
      return yield* subprocessInspector(terminalPid).pipe(
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
    });

    const applySubprocessActivity = Effect.fn("terminal.applySubprocessActivity")(function* (
      session: (typeof runningSessions)[number],
      inspectResult: Option.Option<TerminalSubprocessInspectResult>,
    ) {
      const terminalPid = session.pid;
      const expectedRevision = session.subprocessInspectionRevision;
      if (Option.isNone(inspectResult)) {
        yield* modifyManagerState((state) => {
          const liveSession = state.sessions.get(
            toSessionKey(session.threadId, session.terminalId),
          );
          if (
            liveSession?.status === "running" &&
            liveSession.pid === terminalPid &&
            liveSession.subprocessInspectionRevision === expectedRevision
          ) {
            // Do not keep routing input from a stale foreground observation.
            // Unknown ownership strips capability replies until a later probe
            // succeeds, while ordinary keyboard input still passes unchanged.
            liveSession.shellForeground = null;
            liveSession.hasTerminalReplyUnawareSubprocess = false;
            liveSession.subprocessInspectionRevision += 1;
          }
          return [undefined, state] as const;
        });
        return Option.none<TerminalEvent>();
      }

      const next = inspectResult.value;
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const appliedResult = yield* modifyManagerState<{
        readonly applied: boolean;
        readonly event: Option.Option<TerminalEvent>;
      }>((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid
        ) {
          return [{ applied: false, event: Option.none<TerminalEvent>() }, state] as const;
        }
        if (liveSession.value.subprocessInspectionRevision === expectedRevision) {
          // Refresh the foreground-ownership signal only when no newer
          // on-demand inspection has made this routing observation stale.
          liveSession.value.shellForeground = resolveShellForeground(platform, next);
          liveSession.value.hasTerminalReplyUnawareSubprocess =
            next.hasTerminalReplyUnawareSubprocess ?? false;
          liveSession.value.subprocessInspectionRevision += 1;
          if (liveSession.value.shellForeground === false) {
            // A prefix buffered while the shell owned the PTY is unsolicited
            // reply residue, not input for the newly foreground application.
            liveSession.value.pendingInputControlSequence = "";
          }
        }
        // Process metadata is still useful when a newer write inspection won
        // the foreground-routing race: it drives the activity label and
        // process registry without overwriting that newer routing decision.
        if (
          liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
          liveSession.value.childCommandLabel === nextChildLabel
        ) {
          return [{ applied: true, event: Option.none<TerminalEvent>() }, state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          {
            applied: true,
            event: Option.some({
              type: "activity" as const,
              threadId: liveSession.value.threadId,
              terminalId: liveSession.value.terminalId,
              sequence: eventStamp.sequence,
              hasRunningSubprocess: next.hasRunningSubprocess,
              label: terminalWireLabel(liveSession.value),
            }),
          },
          state,
        ] as const;
      });

      if (appliedResult.applied) {
        yield* registerTerminalProcesses({
          threadId: session.threadId,
          terminalId: session.terminalId,
          processIds: next.processIds,
        });
      }

      return appliedResult.event;
    });

    yield* Effect.forEach(
      runningSessions,
      (session) =>
        Effect.gen(function* () {
          // Process inspection invokes external `ps`/`pgrep` commands and can
          // take seconds to time out. Keep that I/O outside the per-thread lock
          // so writes and resizes remain responsive, then revalidate the
          // captured PID while applying the result under the lock.
          const inspectResult = yield* inspectSubprocessActivity(session);
          const event = yield* withThreadLock(
            session.threadId,
            applySubprocessActivity(session, inspectResult),
          );
          // Listener callbacks stay outside the session lock so a subscriber
          // can safely trigger another terminal operation for this thread.
          if (Option.isSome(event)) {
            yield* publishEvent(event.value);
          }
        }),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
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
        cleanupProcessHandles(session);
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
      const history = yield* readHistory(input.threadId, terminalId);
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
        pendingHistoryControlSequence: "",
        pendingInputControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
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
        shellForeground: true,
        subprocessInspectionRevision: 0,
        childCommandLabel: null,
        hasTerminalReplyUnawareSubprocess: false,
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
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingInputControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history = "";
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingInputControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
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

        if (Option.isNone(existing)) {
          if (!input.cwd) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        const session = existing.value;
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (!session.process && input.cwd && input.restartIfNotRunning === true) {
          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        return snapshot(session);
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

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
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

  const writeLocked = Effect.fn("terminal.writeLocked")(function* (input: TerminalWriteInput) {
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
    // The periodic subprocess snapshot is deliberately cheap and eventually
    // consistent, but a foreground program can exit between polls. Capability
    // replies arriving in that gap must refresh foreground ownership before we
    // decide whether to relay them; otherwise the now-idle shell receives a
    // whole response burst and prompt redraws amplify it into a feedback loop.
    const alwaysFilterTerminalResponses = input.inputSource === "keyboard";
    if (
      !alwaysFilterTerminalResponses &&
      !session.shellForeground &&
      mayContainTerminalResponse(session.pendingInputControlSequence, input.data)
    ) {
      const refreshed = yield* Effect.exit(subprocessInspector(process.pid));
      if (refreshed._tag === "Success") {
        session.shellForeground = resolveShellForeground(platform, refreshed.value);
        session.hasTerminalReplyUnawareSubprocess =
          refreshed.value.hasTerminalReplyUnawareSubprocess ?? false;
      } else {
        session.shellForeground = null;
        session.hasTerminalReplyUnawareSubprocess = false;
      }
      session.subprocessInspectionRevision += 1;
    }
    const filterTerminalResponsesForCurrentProcess = isTerminalReplyUnawarePager(session);

    // The reply-strip exists to break the IDLE-PROMPT echo loop (a shell with
    // no reader echoes the emulator's auto-replies, and a prompt that re-queries
    // on redraw turns that into a flood). The gate is PTY foreground ownership,
    // not mere child existence: a background job (`sleep 100 &`) leaves the
    // shell at the prompt (tpgid still the shell's — keep stripping), while a
    // foreground vim/fzf/CPR-based UI owns the terminal and is reading the
    // replies to its own queries — relay input verbatim; stripping would starve
    // its capability negotiation. The ~1s subprocess-poll latency means a
    // program's very first queries can still lose a reply, and a program
    // `exec`'d over the shell keeps its pgid so it still looks like the shell —
    // both accepted next to the runaway flood the strip prevents.
    const isStandaloneTerminalEscape =
      (input.inputSource ?? "terminal") === "terminal" &&
      session.pendingInputControlSequence.length === 0 &&
      input.data === "\x1b";
    const statefullyFilterTerminalResponses =
      filterTerminalResponsesForCurrentProcess || session.shellForeground !== false;
    const data = alwaysFilterTerminalResponses
      ? stripTerminalResponsesFromInput(input.data)
      : statefullyFilterTerminalResponses
        ? isStandaloneTerminalEscape
          ? input.data
          : (() => {
              const previousPendingControlSequence = session.pendingInputControlSequence;
              const sanitized = sanitizeTerminalInputChunk(
                previousPendingControlSequence,
                input.data,
              );
              session.pendingInputControlSequence = sanitized.pendingControlSequence;
              if (
                filterTerminalResponsesForCurrentProcess &&
                previousPendingControlSequence.length > 0 &&
                sanitized.pendingControlSequence.length === 0 &&
                sanitized.data.length > 0 &&
                input.data !== "\x1b" &&
                [...input.data].length === 1
              ) {
                // The buffered prefix plus this byte was not a recognized
                // terminal reply. Drop only the abandoned prefix and preserve
                // the complete one-key pager command (`q`, Enter, Ctrl-C).
                return input.data;
              }
              return sanitized.data;
            })()
        : input.data;
    if (session.shellForeground === false && !filterTerminalResponsesForCurrentProcess) {
      session.pendingInputControlSequence = "";
    }
    if (data.length === 0) return;
    yield* Effect.try({
      try: () => process.write(data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const write: TerminalManager["Service"]["write"] = (input) =>
    withThreadLock(input.threadId, writeLocked(input));

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
        session.history = "";
        session.pendingHistoryControlSequence = "";
        session.pendingInputControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
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
            pendingHistoryControlSequence: "",
            pendingInputControlSequence: "",
            pendingProcessEvents: [],
            pendingProcessEventIndex: 0,
            processEventDrainRunning: false,
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
            shellForeground: true,
            subprocessInspectionRevision: 0,
            childCommandLabel: null,
            hasTerminalReplyUnawareSubprocess: false,
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
        session.pendingHistoryControlSequence = "";
        session.pendingInputControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
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
