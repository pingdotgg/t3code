// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
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
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { APPIMAGE_PATH_LIKE_ENV_KEYS, APPIMAGE_RUNTIME_ENV_KEYS, DEFAULT_HISTORY_BYTE_LIMIT, HISTORY_SEQUENCE_START, INHERITED_INPUT_RESET, MAX_HISTORY_CHUNK_LENGTH, TERMINAL_ENV_BLOCKLIST, TerminalSubprocessCheckError, decodeClaudeSettings, decodeCodexSettings, formatShellCandidate, hashId, isControlSequenceCancel, isCsiFinalByte, isEscapeFinalByte, isEscapeIntermediateByte, isPathSegmentUnderAppDir, parsePosixProcessTable, processTableSnapshotFromProcesses, shouldStripCsiSequence, shouldStripDcsSequence, shouldStripOscSequence, stripStringTerminator } from "./terminalSupport0.ts";
import type { PendingProcessEvent, ShellCandidate, TerminalHistoryChunk, TerminalProcessTableSnapshot } from "./terminalSupport0.ts";

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}

// Pop beyond Ghostty's eight-entry Kitty stacks on both screens before clearing
// flags. A 1049 round trip preserves the main cursor, text, and scrollback.

export function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c || isControlSequenceCancel(codePoint)) {
      return index + 1;
    }
    // Like xterm.js, an ESC that does not start ST ends the string and begins the next sequence.
    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) return null;
      return input.charCodeAt(index + 1) === 0x5c ? index + 2 : index;
    }
  }
  return null;
}

export function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  // A second ESC restarts the sequence, so leave it for the next pass.
  if (input.charCodeAt(cursor) === 0x1b) {
    return cursor;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

// libghostty prints UTF-8 C1 code points (U+0080-U+009F) as text, so only ESC starts a sequence.

export const NEXT_HISTORY_SEQUENCE_START = new RegExp(HISTORY_SEQUENCE_START.source, "g");

export function hashedHistoryThreadPart(threadId: string): string {
  return `terminal_sha256.${hashId(threadId)}`;
}

export function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

export function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = yield* mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public */

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent | undefined>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  inputCount: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  shell: string | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

export interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

export type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: BoundedTerminalHistory | null;
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

export function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
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

export const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
  timeout: Duration.Input,
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
      timeout,
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
    // Reject partial tables; treating them as authoritative would clear process ids and mark terminals idle.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

export const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(function* (
  timeout: Duration.Input,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const command =
    'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
  const result = yield* processRunner
    .run({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeout,
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    return yield* new TerminalSubprocessCheckError({
      command: "powershell",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
    const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) ? [{ pid, ppid, name }] : [];
  });
  return processTableSnapshotFromProcesses(processes);
});

export function neutralizeInheritedHistory(history: string, maxLines: number, maxBytes: number): string {
  // Scan exactly the cold replay window, reserving the entire longest reset so
  // neither the server nor the client can trim away the entry after we choose its exit.
  const resetBytes = history.includes("\u001b")
    ? Buffer.byteLength(INHERITED_INPUT_RESET + "\u001b7\u001b[?1049l")
    : 0;
  history = new BoundedTerminalHistory(
    // The suffix occupies the empty line after a trailing newline, too.
    resetBytes > 0 && history.endsWith("\n") ? maxLines - 1 : maxLines,
    history,
    Math.max(0, maxBytes - resetBytes),
  ).value();
  if (!history.includes("\u001b")) return history;
  // An unconditional 1049 reset restores a stale saved cursor on the main
  // screen. The exit must match the inherited screen's cursor-save behavior.
  let alternateScreen: number | undefined;
  for (const match of history.matchAll(/\u001b(?:\[\?([0-9;]+)([hl])|(c))/gu)) {
    if (match[3]) alternateScreen = undefined;
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number(parameter);
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreen = match[2] === "h" ? (alternateScreen ?? mode) : undefined;
      }
    }
  }
  // A client may trim away the entry, leaving us on main: save its current
  // cursor before exiting. On alternate this saves only the alternate cursor.
  const leaveAlternateScreen =
    alternateScreen === undefined ? "" : `\u001b7\u001b[?${alternateScreen}l`;
  return history + leaveAlternateScreen + INHERITED_INPUT_RESET;
}

export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  if (pendingControlSequence.length === 0 && !HISTORY_SEQUENCE_START.test(data)) {
    return { visibleText: data, pendingControlSequence: "" };
  }

  const input = `${pendingControlSequence}${data}`;
  // Only the pending prefix's final ESC can begin a terminator split across chunks.
  const pendingScanStart = Math.max(0, pendingControlSequence.length - 1);
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
          const cancelled = isControlSequenceCancel(input.charCodeAt(cursor));
          if (cancelled || isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
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
        const terminatorIndex = findStringTerminatorIndex(
          input,
          Math.max(index + 2, pendingScanStart),
        );
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

    // One slice per printable run: every chunk of coloured output reaches this loop.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    append(input.slice(index, nextSequenceStart));
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: "" };
}

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv: Record<string, string> | null | undefined,
  platform: NodeJS.Platform,
  home: string,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const existingKey =
        platform === "win32"
          ? Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
          : undefined;
      spawnEnv[existingKey ?? key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value, home) : value;
    }
  }
  if (!spawnEnv.COLORTERM && runtimeEnv?.COLORTERM === undefined) {
    spawnEnv.COLORTERM = "truecolor";
  }
  // fish 4.1+ can wait 10s at startup for a DA1 reply before a renderer can answer.
  // Skip the query unless the user or provider already chose `query-term` or `no-query-term`.
  const fishFeaturesKey =
    platform === "win32"
      ? (Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === "fish_features") ??
        "fish_features")
      : "fish_features";
  const fishFeatures = spawnEnv[fishFeaturesKey];
  if (!fishFeatures?.includes("query-term")) {
    spawnEnv[fishFeaturesKey] = fishFeatures ? `${fishFeatures},no-query-term` : "no-query-term";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}
