import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
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

import { ServerConfig } from "../../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../../observability/Metrics.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { PortDiscovery } from "../../preview/Services/PortScanner.ts";
import {
  TerminalCwdError,
  TerminalHistoryError,
  TerminalManager,
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalManagerShape,
} from "../Services/Manager.ts";
import {
  PtyAdapter,
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY.ts";

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
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    terminalPid: Schema.Number,
    command: Schema.Literals(["powershell", "pgrep", "ps"]),
  },
) {}

class TerminalProcessSignalError extends Schema.TaggedErrorClass<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
  },
) {}

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

interface ShellCandidate {
  shell: string;
  args?: string[];
}

interface TerminalStartInput {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent = { type: "output"; data: string } | { type: "exit"; event: PtyExitEvent };

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
      process: PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyProcess, Fiber.Fiber<void, never>>;
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

function defaultShellResolver(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
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

function isRetryableShellSpawnError(error: PtySpawnError): boolean {
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
      } as const;
    }),
    Effect.mapError(
      (cause) =>
        new TerminalSubprocessCheckError({
          message: "Failed to inspect Windows terminal subprocesses.",
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
            message: "Failed to inspect terminal subprocesses with pgrep.",
            cause,
            terminalPid,
            command: "pgrep",
          }),
      ),
    );

  const runPs = processRunner
    .run({
      command: "ps",
      args: ["-eo", "pid=,ppid="],
      timeout: "1 second",
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            message: "Failed to inspect terminal subprocesses with ps.",
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
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
  }

  if (childPid === null) {
    const psResult = yield* Effect.exit(runPs);
    if (psResult._tag === "Failure" || psResult.value.code !== 0) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
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
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
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
  const psResult = yield* Effect.exit(runPs);
  if (psResult._tag === "Success" && psResult.value.code === 0) {
    const childrenByParent = new Map<number, number[]>();
    for (const line of psResult.value.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
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
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
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

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
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
  return false;
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
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
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
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
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
  return spawnEnv;
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
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  platform?: NodeJS.Platform;
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

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  const portDiscovery = yield* PortDiscovery;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
  });
});

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const platform = options.platform ?? process.platform;
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

    const toTerminalHistoryError =
      (operation: "read" | "truncate" | "migrate", threadId: string, terminalId: string) =>
      (cause: unknown) =>
        new TerminalHistoryError({
          operation,
          threadId,
          terminalId,
          cause,
        });

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
      process: PtyProcess | null,
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
      process: PtyProcess,
      fiber: Fiber.Fiber<void, never>,
    ) {
      yield* modifyManagerState((state) => {
        const killFibers = new Map(state.killFibers);
        killFibers.set(process, fiber);
        return [undefined, { ...state, killFibers }] as const;
      });
    });

    const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            message: "Failed to send SIGTERM to terminal process.",
            cause,
            signal: "SIGTERM",
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            error: error.message,
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
            message: "Failed to send SIGKILL to terminal process.",
            cause,
            signal: "SIGKILL",
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            error: error.message,
          }),
        ),
      );
    });

    const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
      process: PtyProcess,
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
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)))
      ) {
        const raw = yield* fileSystem
          .readFileString(nextPath)
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)));
        const capped = capHistory(raw, historyLineLimit);
        if (capped !== raw) {
          yield* fileSystem
            .writeFileString(nextPath, capped)
            .pipe(Effect.mapError(toTerminalHistoryError("truncate", threadId, terminalId)));
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
          .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId))))
      ) {
        return "";
      }

      const raw = yield* fileSystem
        .readFileString(legacyPath)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
      const capped = capHistory(raw, historyLineLimit);
      yield* fileSystem
        .writeFileString(nextPath, capped)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
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
        Effect.mapError(
          (cause) =>
            new TerminalCwdError({
              cwd,
              reason: cause.reason._tag === "NotFound" ? "notFound" : "statFailed",
              cause,
            }),
        ),
      );
      if (stats.type !== "Directory") {
        return yield* new TerminalCwdError({
          cwd,
          reason: "notDirectory",
        });
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
            const sanitized = sanitizeTerminalHistoryChunk(
              session.pendingHistoryControlSequence,
              nextEvent.data,
            );
            session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
            if (sanitized.visibleText.length > 0) {
              session.history = capHistory(
                `${session.history}${sanitized.visibleText}`,
                historyLineLimit,
              );
            }
            const eventStamp = advanceEventSequence(session);

            return {
              type: "output",
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              history: sanitized.visibleText.length > 0 ? session.history : null,
              data: nextEvent.data,
            } as const;
          }

          const process = session.process;
          cleanupProcessHandles(session);
          session.process = null;
          session.pid = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.status = "exited";
          session.pendingHistoryControlSequence = "";
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

    const stopProcess = Effect.fn("terminal.stopProcess")(function* (
      session: TerminalSessionState,
    ) {
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
      lastError: PtySpawnError | null = null,
    ): Effect.fn.Return<{ process: PtyProcess; shellLabel: string }, PtySpawnError> {
      if (index >= shellCandidates.length) {
        const detail = lastError?.message ?? "Failed to spawn PTY process";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        return yield* new PtySpawnError({
          adapter: "terminal-manager",
          message: `${detail}.${tried}`.trim(),
          ...(lastError ? { cause: lastError } : {}),
        });
      }

      const candidate = shellCandidates[index];
      if (!candidate) {
        return yield* (
          lastError ??
            new PtySpawnError({
              adapter: "terminal-manager",
              message: "No shell candidate available for PTY spawn.",
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
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.updatedAt = startingAt;
        return [undefined, state] as const;
      });

      let ptyProcess: PtyProcess | null = null;
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
          session.status = "error";
          session.pid = null;
          session.process = null;
          session.unsubscribeData = null;
          session.unsubscribeExit = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
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
          error: message,
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
      const runningSessions = [...state.sessions.values()].filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      );

      if (runningSessions.length === 0) {
        return;
      }

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
        liveSession.pendingHistoryControlSequence = "";
        liveSession.pendingProcessEvents = [];
        liveSession.pendingProcessEventIndex = 0;
        liveSession.processEventDrainRunning = false;
        yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
      } else if (liveSession.status === "exited" || liveSession.status === "error") {
        liveSession.runtimeEnv = nextRuntimeEnv;
        liveSession.worktreePath = nextWorktreePath;
        liveSession.history = "";
        liveSession.pendingHistoryControlSequence = "";
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
        liveSession.cols = targetCols;
        liveSession.rows = targetRows;
        liveSession.updatedAt = yield* nowIso;
        liveSession.process.resize(targetCols, targetRows);
      }

      return snapshot(liveSession);
    });

    const open: TerminalManagerShape["open"] = (input) =>
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
            session.cols = targetCols;
            session.rows = targetRows;
            session.updatedAt = yield* nowIso;
            yield* Effect.sync(() => session.process?.resize(targetCols, targetRows));
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

    const subscribe: TerminalManagerShape["subscribe"] = (listener) =>
      Effect.sync(() => {
        terminalEventListeners.add(listener);
        return () => {
          terminalEventListeners.delete(listener);
        };
      });

    const attachStream: TerminalManagerShape["attachStream"] = (input, listener) => {
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

    const subscribeMetadata: TerminalManagerShape["subscribeMetadata"] = (listener) => {
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

    const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
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
      yield* Effect.sync(() => process.write(input.data));
    });

    const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
      const terminalId = input.terminalId;
      const session = yield* requireSession(input.threadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      session.cols = input.cols;
      session.rows = input.rows;
      session.updatedAt = yield* nowIso;
      yield* Effect.sync(() => process.resize(input.cols, input.rows));
    });

    const clear: TerminalManagerShape["clear"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId;
          const session = yield* requireSession(input.threadId, terminalId);
          session.history = "";
          session.pendingHistoryControlSequence = "";
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

    const restart: TerminalManagerShape["restart"] = (input) =>
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
          session.pendingHistoryControlSequence = "";
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

    const close: TerminalManagerShape["close"] = (input) =>
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

    return {
      open,
      attachStream,
      write,
      resize,
      clear,
      restart,
      close,
      subscribe,
      subscribeMetadata,
    } satisfies TerminalManagerShape;
  },
);

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager()).pipe(
  Layer.provide(ProcessRunner.layer),
);
