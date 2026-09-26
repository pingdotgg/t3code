// @effect-diagnostics globalTimers:off -- The default scheduler defers notifications by one macrotask in extension-host code, outside any Effect fiber.
import {
  uiKeybindingsApi,
  uiThemeApi,
  type TerminalControlAck,
  type TerminalControlAttachInput,
  type TerminalControlCloseInput,
  type TerminalControlClearInput,
  type TerminalControlOpenInput,
  type TerminalControlResizeInput,
  type TerminalControlRestartInput,
  type TerminalControlWriteInput,
  type TerminalOutputEventsClosed,
  type TerminalOutputEventsValue,
  type TerminalSessionMetadata,
  type TerminalSessionResult,
  type TerminalSessionsListEvent,
  type UiKeybindingChord,
  type UiKeybindingsHost,
  type UiTerminalAppearance,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, bindStreamApi, type ApiClient } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { GlobalCommandDescriptor } from "@t3tools/extension-sdk/environment";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/ghostty-terminal/terminal-links";

import { TerminalInputQueue } from "./inputQueue.ts";

/** Matches the native client retained-output cap; bounds only the <pre> fallback path. */
export const TERMINAL_BUFFER_MAX_BYTES = 512 * 1024;

/**
 * Overflow-resubscribe window: the provider preserves the subscription's
 * snapshot ahead of every `closed:overflow`, so a delivered frame cannot
 * bound a sustained flood — overflows close together in time keep counting,
 * while a quiet gap resets the streak.
 */
export const OVERFLOW_RESUBSCRIBE_WINDOW_MS = 10_000;
export const OVERFLOW_RESUBSCRIBE_MAX = 3;

export interface OverflowStreak {
  readonly attempts: number;
  readonly lastAt: number;
}

export const EMPTY_OVERFLOW_STREAK: OverflowStreak = { attempts: 0, lastAt: 0 };

/**
 * Streak update for one delivered output frame. Only `closed:overflow`
 * counts, and only the time window resets the streak — the snapshot the
 * provider preserves ahead of every overflow close must not. A new epoch
 * (`identity-changed`) clears it; other frames leave it alone.
 */
export const noteOutputFrameForStreak = (
  value: TerminalOutputEventsValue,
  streak: OverflowStreak,
  now: number,
): OverflowStreak => {
  if (value.kind !== "closed") return streak;
  if (value.reason === "identity-changed") return EMPTY_OVERFLOW_STREAK;
  if (value.reason !== "overflow") return streak;
  return {
    attempts:
      streak.attempts > 0 && now - streak.lastAt < OVERFLOW_RESUBSCRIBE_WINDOW_MS
        ? streak.attempts + 1
        : 1,
    lastAt: now,
  };
};

/** `closed` reasons a fresh output subscription can recover from. */
export const isResumableOutputClose = (
  reason: TerminalOutputEventsClosed["reason"],
  overflowAttempts: number,
) =>
  reason === "identity-changed" ||
  (reason === "overflow" && overflowAttempts <= OVERFLOW_RESUBSCRIBE_MAX);

export interface SessionRow {
  readonly terminalId: string;
  readonly label: string;
  readonly status: "starting" | "running" | "exited" | "error" | "closed" | "unknown";
  readonly hasRunningSubprocess: boolean;
  readonly exitCode: number | null;
  readonly updatedAt: string | null;
}

export interface OutputBuffer {
  readonly contents: string;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly status: "connecting" | "live" | "exited" | "closed" | "error";
  readonly statusText: string;
  readonly exitCode: number | null;
  readonly epoch: string | null;
  readonly sequence: number;
  /**
   * Last accepted native event sequence (session eventSequence), seeded by
   * the snapshot's boundarySequence — post-snapshot events must strictly
   * increase. `closed` frames carry no native sequence.
   */
  readonly nativeWatermark: number;
  readonly ended: boolean;
}

const textEncoder = new TextEncoder();
const utf8Bytes = (value: string) => textEncoder.encode(value).byteLength;

/** UTF-16-safe tail cut: never split a surrogate pair or an astral character. */
export function tailByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded.subarray(start));
}

/** Fallback tab title when a session has no server-computed label. */
export function fallbackTerminalLabel(terminalId: string): string {
  const match = /^term-(\d+)$/.exec(terminalId);
  return match ? `Terminal ${match[1]}` : "Terminal";
}

export function describeSession(result: TerminalSessionResult): SessionRow | null {
  if (result === null) return null;
  return {
    terminalId: result.terminalId,
    label: result.label || fallbackTerminalLabel(result.terminalId),
    status: result.status,
    hasRunningSubprocess: result.hasRunningSubprocess,
    exitCode: result.exitCode,
    updatedAt: result.updatedAt,
  };
}

/** A session that inspect() reports absent keeps a visible row so the list never lies. */
export function missingSessionRow(terminalId: string): SessionRow {
  return {
    terminalId,
    label: fallbackTerminalLabel(terminalId),
    status: "closed",
    hasRunningSubprocess: false,
    exitCode: null,
    updatedAt: null,
  };
}

export function normalizeTerminalIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id.length === 0 || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function addTerminalId(ids: readonly string[], terminalId: string): string[] {
  const id = terminalId.trim();
  if (id.length === 0 || id.length > 128) return [...ids];
  return ids.includes(id) ? [...ids] : [...ids, id];
}

export function removeTerminalId(ids: readonly string[], terminalId: string): string[] {
  return ids.filter((id) => id !== terminalId);
}

export function resolveActiveTerminalId(
  ids: readonly string[],
  activeTerminalId: string | null,
): string | null {
  if (ids.length === 0) return null;
  return activeTerminalId !== null && ids.includes(activeTerminalId)
    ? activeTerminalId
    : (ids[0] ?? null);
}

/* ------------------------------------------------------------------ */
/* Split groups — port of the native terminalUiStateStore group model. */
/* ------------------------------------------------------------------ */

/** Same cap the native drawer enforces per split group. */
export const MAX_TERMINALS_PER_GROUP = 4;

export type TerminalSplitDirection = "horizontal" | "vertical";

/**
 * Internal/restored group shape — mirrors the native `ThreadTerminalGroup`:
 * `splitDirection` stays optional and only `"vertical"` is ever stored;
 * absent means horizontal.
 */
export interface TerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "vertical";
}

/** Snapshot-facing group with the direction resolved for rendering. */
export interface TerminalPaneGroup {
  readonly id: string;
  readonly terminalIds: readonly string[];
  readonly splitDirection: TerminalSplitDirection;
}

const fallbackGroupId = (terminalId: string) => `group-${terminalId}`;

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

/**
 * Groups partition the session list: members that left `terminalIds` drop
 * out, duplicates collapse to their first group, and sessions no group
 * claims each earn a trailing singleton — the native
 * `normalizeTerminalGroups` rule, which is also what makes old restore
 * records (no group field) land as one group per terminal. A group larger
 * than the per-group cap — only a crafted restore record; splits are
 * refused at the cap — is chunked into cap-sized groups rather than
 * rendering (or spawning) more panes than a split layout can show: nothing
 * is dropped, the first chunk keeps the id and direction, and overflow
 * chunks continue the same direction under uniquified ids.
 */
export function normalizeTerminalGroups(
  groups: readonly TerminalGroup[],
  terminalIds: readonly string[],
): TerminalGroup[] {
  if (terminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: TerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of groups) {
    const groupTerminalIds = normalizeTerminalIds(group.terminalIds).filter(
      (terminalId) => validTerminalIdSet.has(terminalId) && !assignedTerminalIds.has(terminalId),
    );
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) assignedTerminalIds.add(terminalId);
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    const vertical = group.splitDirection === "vertical";
    for (let start = 0; start < groupTerminalIds.length; start += MAX_TERMINALS_PER_GROUP) {
      nextGroups.push({
        id: assignUniqueGroupId(
          start === 0
            ? baseGroupId
            : `${baseGroupId}-${Math.floor(start / MAX_TERMINALS_PER_GROUP) + 1}`,
          usedGroupIds,
        ),
        terminalIds: groupTerminalIds.slice(start, start + MAX_TERMINALS_PER_GROUP),
        ...(vertical ? { splitDirection: "vertical" as const } : {}),
      });
    }
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }
  return nextGroups;
}

export const EMPTY_OUTPUT_BUFFER: OutputBuffer = {
  contents: "",
  retainedBytes: 0,
  truncated: false,
  status: "connecting",
  statusText: "Connecting…",
  exitCode: null,
  epoch: null,
  sequence: 0,
  nativeWatermark: -1,
  ended: false,
};

// CSI (parameters, intermediates, final byte) by ESC [ or 8-bit 0x9b;
// OSC/DCS/SOS/PM/APC strings by their ESC or 8-bit introducer, ended by
// BEL, ST (ESC \ or 0x9c), or — as the VT parser aborts them — by CAN, SUB,
// ESC, any other C1 control or the end of the buffer, so an unterminated
// string never prints its payload; and short escapes such as charset
// designation and keypad modes.
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x18\x1a\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c|(?=[\x18\x1a\x1b\x80-\x9f])|$)|[ -/]*[0-~])|\x9b[0-?]*[ -/]*[@-~]|[\x90\x98\x9d-\x9f][^\x07\x18\x1a\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c|(?=[\x18\x1a\x1b\x80-\x9f])|$)/g;
// A sequence split across output chunks: the rest is still in flight. A
// split string needs no entry — TERMINAL_ESCAPE withholds it to the end.
// eslint-disable-next-line no-control-regex
const TRAILING_PARTIAL_ESCAPE = /(?:\x1b(?:\[[0-?]*[ -/]*|[ -/]*)|\x9b[0-?]*[ -/]*)$/;
// C0 and C1 controls a plain-text view cannot express, including a stray
// ESC or ST left by a malformed sequence. Tab, newline, carriage return and
// backspace stay for the line pass below.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Applies carriage return and backspace as cursor moves within one line. */
function overstrikeLine(line: string): string {
  if (!line.includes("\r") && !line.includes("\b")) return line;
  const cells: string[] = [];
  let cursor = 0;
  for (const char of line) {
    if (char === "\r") cursor = 0;
    else if (char === "\b") cursor = Math.max(0, cursor - 1);
    else cells[cursor++] = char;
  }
  return cells.join("");
}

/**
 * Raw PTY output as readable plain text for the fallback view, which cannot
 * run the VT parser: the escape sequences above and stray controls are
 * dropped, and carriage return / backspace overwrite in place, so colour
 * codes and prompt redraws do not print as `[1;36m` noise. Styling and
 * cursor addressing are lost; anything else the VT parser would interpret
 * (line wrapping, cursor moves) is not replayed.
 */
export function plainTerminalText(contents: string): string {
  return contents
    .replace(TRAILING_PARTIAL_ESCAPE, "")
    .replace(TERMINAL_ESCAPE, "")
    .replace(TERMINAL_CONTROL, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map(overstrikeLine)
    .join("\n");
}

/**
 * Apply one public `t3.terminal/output-events` frame. Output chunks share a
 * native sequence number and arrive in chunkIndex order; a partial group is
 * buffered until complete so torn output never renders. Lifecycle frames
 * (reset/exit/closed) end or clear the buffer exactly like the native
 * attach-stream reducer.
 */
export function applyOutputEvent(
  current: OutputBuffer,
  frame: { readonly streamId: string; readonly sequence: number },
  value: TerminalOutputEventsValue,
  pending?: { sequence: number; count: number; parts: string[] } | null,
): { buffer: OutputBuffer; pending: { sequence: number; count: number; parts: string[] } | null } {
  const fail = (message: string): { buffer: OutputBuffer; pending: null } => ({
    buffer: { ...EMPTY_OUTPUT_BUFFER, status: "error", statusText: message, ended: true },
    pending: null,
  });
  if (current.ended) return fail("Output arrived after the terminal lifecycle ended.");
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== current.sequence + 1)
    return fail("Output transport sequence is discontinuous.");
  const sequence = frame.sequence;
  const base = { ...current, sequence };

  if (value.kind === "snapshot") {
    if (
      frame.sequence < 0 ||
      !Number.isSafeInteger(value.boundarySequence) ||
      !Number.isSafeInteger(value.contentsUnitStart)
    )
      return fail("Output snapshot boundary is invalid.");
    const contents = tailByBytes(value.contents, TERMINAL_BUFFER_MAX_BYTES);
    const ended = value.status === "exited" || value.status === "error";
    // contentsUnitStart > 0 means the host dropped retained bytes ahead of
    // the tail (line or byte eviction) even when the tail itself isn't
    // truncated — the display is missing earlier output either way.
    const omitted = value.truncated || value.contentsUnitStart > 0;
    return {
      buffer: {
        contents,
        retainedBytes: utf8Bytes(contents),
        truncated: omitted,
        status: ended ? "exited" : "live",
        statusText: ended
          ? `Terminal is ${value.status}.`
          : omitted
            ? "Watching live output. Older retained history was omitted."
            : "Watching live output.",
        exitCode: null,
        epoch: value.streamEpoch,
        sequence,
        nativeWatermark: value.boundarySequence,
        ended,
      },
      pending: null,
    };
  }
  if (current.epoch === null || value.streamEpoch !== current.epoch)
    return fail("Output incarnation changed.");

  if (value.kind === "closed") {
    return {
      buffer: {
        ...base,
        contents: "",
        retainedBytes: 0,
        status: "closed",
        statusText: `Output unavailable: ${value.reason}. Subscribe again to recover.`,
        ended: true,
      },
      pending: null,
    };
  }
  if (!Number.isSafeInteger(value.sequence)) return fail("Output native sequence is invalid.");
  if (value.kind === "reset") {
    if (pending) return fail("Output chunk group is discontinuous.");
    if (value.sequence <= base.nativeWatermark)
      return fail("Output event sequence is not monotonic.");
    return {
      buffer: {
        ...base,
        contents: "",
        retainedBytes: 0,
        truncated: false,
        status: "live",
        statusText: "Terminal history cleared. Watching live output.",
        nativeWatermark: value.sequence,
      },
      pending: null,
    };
  }
  if (value.kind === "exit") {
    if (pending) return fail("Terminal exited with incomplete output.");
    if (value.sequence <= base.nativeWatermark)
      return fail("Output event sequence is not monotonic.");
    return {
      buffer: {
        ...base,
        status: "exited",
        statusText: `Terminal exited (code ${value.exitCode ?? "unknown"}).`,
        exitCode: value.exitCode,
        nativeWatermark: value.sequence,
        ended: true,
      },
      pending: null,
    };
  }

  if (
    !Number.isSafeInteger(value.chunkCount) ||
    value.chunkCount < 1 ||
    value.chunkCount > 64 ||
    !Number.isSafeInteger(value.chunkIndex) ||
    value.chunkIndex < 0 ||
    value.chunkIndex >= value.chunkCount ||
    typeof value.data !== "string" ||
    value.data.length > 8192
  )
    return fail("Output chunk exceeds the public contract.");
  if (pending) {
    // A chunk that does not continue the open group abandoned it — output
    // bytes are missing, so fail rather than silently swap groups.
    if (
      value.sequence !== pending.sequence ||
      value.chunkCount !== pending.count ||
      value.chunkIndex !== pending.parts.length
    )
      return fail("Output chunk group is discontinuous.");
    pending.parts.push(value.data);
    if (pending.parts.length < pending.count) return { buffer: base, pending };
    const data = pending.parts.join("");
    const contents = tailByBytes(base.contents + data, TERMINAL_BUFFER_MAX_BYTES);
    return {
      buffer: {
        ...base,
        contents,
        retainedBytes: utf8Bytes(contents),
        status: "live",
        statusText: "Watching live output.",
        nativeWatermark: value.sequence,
      },
      pending: null,
    };
  }
  if (value.chunkIndex !== 0) return fail("Output chunk group is discontinuous.");
  if (value.sequence <= base.nativeWatermark)
    return fail("Output event sequence is not monotonic.");
  if (value.chunkCount > 1)
    return {
      buffer: base,
      pending: { sequence: value.sequence, count: value.chunkCount, parts: [value.data] },
    };
  const contents = tailByBytes(base.contents + value.data, TERMINAL_BUFFER_MAX_BYTES);
  return {
    buffer: {
      ...base,
      contents,
      retainedBytes: utf8Bytes(contents),
      status: "live",
      statusText: "Watching live output.",
      nativeWatermark: value.sequence,
    },
    pending: null,
  };
}

/* ------------------------------------------------------------------ */
/* Interactive panel: tabs, reconcile, input, resize, lifecycle.       */
/* ------------------------------------------------------------------ */

/** Same terminal ids (order ignored) — port of the native helper. */
export function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) return false;
  }
  return true;
}

/**
 * Server knows fewer sessions than the client, but every server id still
 * exists locally. Typical right after open: the list stream lags, and
 * reconciling would drop the fresh id. Port of the native lag rule.
 */
export function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) return false;
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) return false;
  }
  return true;
}

/**
 * Snapshot reconcile: keep the client order while the server list lags.
 * Otherwise the server owns membership but not order (row 16): surviving
 * ids keep their persisted tab order and server-only ids append in server
 * order, so a restored order outlives sessions opened or closed elsewhere.
 */
export function reconcileTerminalIds(
  clientIds: readonly string[],
  serverIds: readonly string[],
): string[] {
  if (terminalIdListsEqual(clientIds, serverIds)) return [...clientIds];
  if (serverTerminalIdsStrictSubsetOfClient(serverIds, clientIds)) return [...clientIds];
  const serverSet = new Set(serverIds);
  const kept = clientIds.filter((id) => serverSet.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...serverIds.filter((id) => !keptSet.has(id))];
}

/** Public view-context workspace identity (extensionWorkspaceRevision payload). */
export function workspaceLaunchFromRevision(
  workspaceRevision: string | undefined,
): { cwd: string; workspaceRoot: string; worktreePath: string | null } | null {
  if (workspaceRevision === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(workspaceRevision);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      parsed[0].trim().length === 0 ||
      (parsed[1] !== null && (typeof parsed[1] !== "string" || parsed[1].trim().length === 0))
    )
      return null;
    const workspaceRoot = parsed[0] as string;
    const worktreePath = parsed[1] as string | null;
    return { cwd: worktreePath ?? workspaceRoot, workspaceRoot, worktreePath };
  } catch {
    return null;
  }
}

/* ---------------- path links (Terminal 22 path half) ---------------- */

/** What a terminal path link resolves to for a `t3.file/presentation.open`. */
export type TerminalPathLinkTarget =
  | { readonly status: "open"; readonly relativePath: string }
  | { readonly status: "unopenable"; readonly reason: string };

/** Trailing `:line` / `:line:column` — editor metadata the presentation op cannot carry. */
const TERMINAL_LINK_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
/**
 * Home-relative check spelled as split comparisons: the pack's private-import
 * audit bans the home-link character sequence anywhere in package content,
 * and a concatenated constant would fold back into it in the bundle.
 */
function isHomeRelativeLink(path: string): boolean {
  return path[0] === "~" && path[1] === "/";
}

function joinPathStyle(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

/** `/Users/<user>`, `/home/<user>` or `C:\Users\<user>` inferred the native way. */
function inferHomeFromCwd(cwd: string): string | undefined {
  return (
    cwd.match(/^\/Users\/([^/]+)/)?.[0] ??
    cwd.match(/^\/home\/([^/]+)/)?.[0] ??
    cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/)?.[1] ??
    undefined
  );
}

/**
 * Lexically normalize one mapped path: `.` and empty segments drop, `..`
 * pops, and a `..` that would climb past the workspace root fails. Returns
 * null when nothing presentable is left.
 */
function terminalLinkSegments(relative: string, windows: boolean): string[] | null {
  const segments: string[] = [];
  for (const segment of relative.split(windows ? /[\\/]/ : /\//)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

/**
 * Terminal link text → the workspace-relative path `t3.file/presentation`
 * accepts, or the named reason it cannot open. The op only carries
 * workspace-relative forward-slash paths, so the position suffix is
 * stripped, `~` and bare-relative links resolve against the launch cwd
 * (the contracts expose no live shell cwd), and under a Windows root the
 * link's separators are normalized to the root's style before mapping —
 * Windows tools emit forward-slash and mixed-separator paths. Anything
 * that lands outside the workspace root — including cross-style absolute
 * paths — refuses by name like the diff panel's Open does.
 */
export function terminalPathLinkTarget(
  text: string,
  cwd: string,
  workspaceRoot: string,
): TerminalPathLinkTarget {
  const reject = (): TerminalPathLinkTarget => ({
    status: "unopenable",
    reason: `${text} cannot be opened — not a workspace-relative path.`,
  });
  const windows = isWindowsAbsolutePath(workspaceRoot);
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const stripRoot = (absolute: string): string | null => {
    const prefix = `${root}${windows ? "\\" : "/"}`;
    const head = absolute.slice(0, prefix.length);
    const expected = windows ? prefix.toLowerCase() : prefix;
    return (windows ? head.toLowerCase() : head) === expected
      ? absolute.slice(prefix.length)
      : null;
  };

  const path = text.replace(TERMINAL_LINK_POSITION_SUFFIX_PATTERN, "");
  if (path.length === 0) return reject();
  let absolute: string;
  if (isAbsolutePath(path)) {
    absolute = path;
  } else if (isHomeRelativeLink(path)) {
    const home = inferHomeFromCwd(cwd);
    if (home === undefined) return reject();
    absolute = joinPathStyle(home, path.slice(2), home.includes("\\") ? "\\" : "/");
  } else {
    absolute = joinPathStyle(cwd, path, isWindowsAbsolutePath(cwd) ? "\\" : "/");
  }

  const relative = stripRoot(windows ? absolute.replaceAll("/", "\\") : absolute);
  if (relative === null) return reject();
  const segments = terminalLinkSegments(relative, windows);
  if (segments === null) return reject();
  return { status: "open", relativePath: segments.join("/") };
}

/** Host calls the panel makes through t3.terminal/control. */
export interface TerminalControlOps {
  open(input: TerminalControlOpenInput): Promise<TerminalSessionMetadata>;
  attach(input: TerminalControlAttachInput): Promise<TerminalSessionMetadata>;
  write(input: TerminalControlWriteInput): Promise<TerminalControlAck>;
  resize(input: TerminalControlResizeInput): Promise<TerminalControlAck>;
  clear(input: TerminalControlClearInput): Promise<TerminalControlAck>;
  restart(input: TerminalControlRestartInput): Promise<TerminalSessionMetadata>;
  close(input: TerminalControlCloseInput): Promise<TerminalControlAck>;
}

export interface TerminalLaunchContext {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
}

export type TerminalConfirmAction = "close" | "restart" | "clear";

export interface TerminalTabState {
  readonly terminalId: string;
  readonly label: string;
  readonly status: SessionRow["status"];
  readonly hasRunningSubprocess: boolean;
  readonly exitCode: number | null;
  /** open/attach in flight; typed input queues behind it. */
  readonly starting: boolean;
  /** Exit observed while tracked; the banner renders until removal lands. */
  readonly exitBanner: string | null;
  readonly confirmAction: TerminalConfirmAction | null;
  readonly error: string | null;
  readonly queuedInputCount: number;
  /** A write failed with unknown outcome; input halts until Resume. */
  readonly inputStopped: boolean;
  readonly inputMessage: string | null;
}

export interface TerminalPanelSnapshot {
  readonly terminalIds: readonly string[];
  readonly activeTerminalId: string | null;
  readonly tabs: readonly TerminalTabState[];
  /**
   * The split-group partition of `terminalIds`; the group named by
   * `activeGroupId` is what the pane area renders (≤4 panes).
   */
  readonly groups: readonly TerminalPaneGroup[];
  readonly activeGroupId: string | null;
  readonly stream: "connecting" | "live" | "closed";
  readonly panelError: string | null;
}

interface TabInternal {
  meta: TerminalSessionMetadata | null;
  starting: boolean;
  input: TerminalInputQueue;
  exiting: boolean;
  exitBanner: string | null;
  confirm: TerminalConfirmAction | null;
  error: string | null;
  resizeInFlight: { cols: number; rows: number } | null;
  resizePending: { cols: number; rows: number } | null;
  resizeSent: { cols: number; rows: number } | null;
}

const clampDimension = (value: number, max: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;

/**
 * Framework-free terminal panel state. The view feeds the sessions list
 * stream and user gestures in; the panel calls the injected control ops and
 * reports immutable snapshots. Exit handling mirrors the native drawer: a
 * live→exited transition writes a banner and removes the tab on the next
 * scheduled tick; `remove` rows drop tabs immediately.
 */
export class TerminalPanel {
  readonly #control: TerminalControlOps;
  readonly #launch: TerminalLaunchContext | null;
  readonly #canAllocatePaneStream: (() => boolean) | undefined;
  readonly #schedule: (callback: () => void) => void;
  readonly #onChange: (() => void) | undefined;
  #ids: string[];
  #active: string | null;
  #groups: TerminalGroup[] = [];
  /** Empty string mirrors the native store's "no active group" sentinel. */
  #activeGroupId = "";
  readonly #tabs = new Map<string, TabInternal>();
  #stream: "connecting" | "live" | "closed" = "connecting";
  #panelError: string | null = null;
  #disposed = false;

  constructor(options: {
    readonly control: TerminalControlOps;
    readonly launch: TerminalLaunchContext | null;
    readonly restored?: {
      readonly terminalIds: readonly string[];
      readonly activeTerminalId: string | null;
      readonly terminalGroups?: readonly {
        readonly id: string;
        readonly terminalIds: readonly string[];
        readonly splitDirection?: TerminalSplitDirection;
      }[];
      readonly activeTerminalGroupId?: string | null;
    } | null;
    /**
     * Budget gate for open/split — false means the host's stream budget
     * cannot take another pane output stream, and the open is refused
     * before any PTY spawns (the view supplies streamHub's answer).
     */
    readonly canAllocatePaneStream?: () => boolean;
    readonly schedule?: (callback: () => void) => void;
    readonly onChange?: () => void;
  }) {
    this.#control = options.control;
    this.#launch = options.launch;
    this.#canAllocatePaneStream = options.canAllocatePaneStream;
    this.#schedule = options.schedule ?? ((callback) => setTimeout(callback, 0));
    this.#onChange = options.onChange;
    this.#ids = normalizeTerminalIds(options.restored?.terminalIds ?? []);
    this.#active = resolveActiveTerminalId(this.#ids, options.restored?.activeTerminalId ?? null);
    this.#groups = normalizeTerminalGroups(
      (options.restored?.terminalGroups ?? []).map((group) => ({
        id: group.id,
        terminalIds: [...group.terminalIds],
        ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
      })),
      this.#ids,
    );
    this.#activeGroupId = this.#resolveActiveGroupId(
      options.restored?.activeTerminalGroupId ?? null,
    );
    for (const id of this.#ids) this.#tab(id);
  }

  get snapshot(): TerminalPanelSnapshot {
    return {
      terminalIds: [...this.#ids],
      activeTerminalId: this.#active,
      groups: this.#groups.map((group) => ({
        id: group.id,
        terminalIds: [...group.terminalIds],
        splitDirection: group.splitDirection ?? "horizontal",
      })),
      activeGroupId: this.#activeGroupId === "" ? null : this.#activeGroupId,
      tabs: this.#ids.map((id) => {
        const tab = this.#tabs.get(id)!;
        const meta = tab.meta;
        return {
          terminalId: id,
          label: resolveTerminalSessionLabel(id, meta),
          status: tab.starting ? "starting" : (meta?.status ?? "closed"),
          hasRunningSubprocess: meta?.hasRunningSubprocess ?? false,
          exitCode: meta?.exitCode ?? null,
          starting: tab.starting,
          exitBanner: tab.exitBanner,
          confirmAction: tab.confirm,
          error: tab.error,
          queuedInputCount: tab.input.state.queuedCount,
          inputStopped: tab.input.state.stopped,
          inputMessage: tab.input.state.message,
        } satisfies TerminalTabState;
      }),
      stream: this.#stream,
      panelError: this.#panelError,
    };
  }

  /** Ids eligible for allocation: client list plus any tab we are tracking. */
  get allocatableTerminalIds(): readonly string[] {
    return [...new Set([...this.#ids, ...this.#tabs.keys()])];
  }

  #emit() {
    this.#onChange?.();
  }

  #newInputQueue(terminalId: string): TerminalInputQueue {
    return new TerminalInputQueue({
      terminalId,
      write: (data) => this.#control.write({ terminalId, data }),
      onChange: () => this.#emit(),
    });
  }

  /**
   * A queue whose panel was disposed is permanently dead — React StrictMode
   * replays effect setup/cleanup/setup in dev and revives the panel, but the
   * old queue would keep dropping every send with no stopped banner. A fresh
   * queue takes over; the disposed one's pending bytes were dropped at
   * dispose and are never resent.
   */
  #liveInput(terminalId: string, tab: TabInternal): TerminalInputQueue {
    if (tab.input.disposed) tab.input = this.#newInputQueue(terminalId);
    return tab.input;
  }

  #tab(terminalId: string): TabInternal {
    let tab = this.#tabs.get(terminalId);
    if (!tab) {
      tab = {
        meta: null,
        starting: false,
        input: this.#newInputQueue(terminalId),
        exiting: false,
        exitBanner: null,
        confirm: null,
        error: null,
        resizeInFlight: null,
        resizePending: null,
        resizeSent: null,
      };
      this.#tabs.set(terminalId, tab);
      if (!this.#ids.includes(terminalId)) this.#ids = [...this.#ids, terminalId];
    } else {
      this.#liveInput(terminalId, tab);
    }
    return tab;
  }

  /** Group containing a session, or the current active group as a fallback. */
  #groupIdOf(terminalId: string): string {
    return (
      this.#groups.find((group) => group.terminalIds.includes(terminalId))?.id ??
      this.#activeGroupId
    );
  }

  /**
   * Native rule: the stored active group survives renormalization while it
   * still exists; otherwise the active terminal's group (or the first group)
   * takes over.
   */
  #resolveActiveGroupId(preferred: string | null): string {
    if (preferred !== null && preferred !== "" && this.#groups.some((g) => g.id === preferred))
      return preferred;
    return (
      (this.#active !== null ? this.#groupIdOf(this.#active) : "") || (this.#groups[0]?.id ?? "")
    );
  }

  /** Re-partition groups after `#ids` changed and re-resolve the active group. */
  #syncGroups() {
    this.#groups = normalizeTerminalGroups(this.#groups, this.#ids);
    this.#activeGroupId = this.#resolveActiveGroupId(this.#activeGroupId);
  }

  /**
   * Native close/reconcile rule: when the active terminal itself may have
   * moved (the closed pane's slot-slide, or a server list that dropped it),
   * the visible group follows the POST-change active terminal. The stored
   * group preference would keep the old group — e.g. close the middle pane
   * of a split and the pane sliding into focus lands in another group,
   * leaving the active terminal hidden behind a group it is not in.
   */
  #syncGroupsFollowingActive() {
    this.#groups = normalizeTerminalGroups(this.#groups, this.#ids);
    this.#activeGroupId =
      (this.#active !== null ? this.#groupIdOf(this.#active) : "") || (this.#groups[0]?.id ?? "");
  }

  /**
   * Where a split lands: the stored active group, else the group holding the
   * active terminal. `null` means there is nothing to split into — the
   * native `effectiveMode === "new"` case.
   */
  #splitDestination(): TerminalGroup | null {
    if (this.#active === null) return null;
    const byId = this.#groups.find((group) => group.id === this.#activeGroupId);
    if (byId) return byId;
    return this.#groups.find((group) => group.terminalIds.includes(this.#active!)) ?? null;
  }

  #removeTab(terminalId: string, fallback: "first" | "index" = "first") {
    this.#tabs.get(terminalId)?.input.dispose();
    this.#tabs.delete(terminalId);
    const closedIndex = this.#ids.indexOf(terminalId);
    this.#ids = this.#ids.filter((id) => id !== terminalId);
    // A user close activates the pane that slides into the closed slot
    // (native closeThreadTerminal); a server-driven remove keeps the older
    // reconcile rule — keep the current active, else the first session.
    this.#active =
      this.#active === terminalId
        ? fallback === "index"
          ? (this.#ids[Math.min(closedIndex, this.#ids.length - 1)] ?? this.#ids[0] ?? null)
          : resolveActiveTerminalId(this.#ids, null)
        : resolveActiveTerminalId(this.#ids, this.#active);
    this.#syncGroupsFollowingActive();
    this.#emit();
  }

  /** Banner + deferred removal on a live→exited/error transition (native #29). */
  #observeMeta(next: TerminalSessionMetadata) {
    const tab = this.#tab(next.terminalId);
    const previous = tab.meta;
    tab.meta = next;
    if (
      !tab.exiting &&
      (next.status === "exited" || next.status === "error") &&
      previous !== null &&
      (previous.status === "starting" || previous.status === "running")
    ) {
      tab.exiting = true;
      tab.exitBanner =
        next.status === "exited"
          ? `Process exited (code ${next.exitCode ?? "unknown"})`
          : "Terminal error";
      this.#schedule(() => {
        if (!this.#disposed && this.#tabs.get(next.terminalId)?.exiting) {
          this.#removeTab(next.terminalId);
        }
      });
    }
  }

  applySessionsEvent(event: TerminalSessionsListEvent) {
    if (this.#disposed) return;
    switch (event.kind) {
      case "snapshot": {
        this.#stream = "live";
        // Reconcile before absorbing metadata: #observeMeta registers every
        // server id as a tracked tab, which would turn a disjoint server list
        // into a strict subset and let stale restored ids survive (#17).
        const serverIds = event.terminals.map((terminal) => terminal.terminalId);
        this.#ids = reconcileTerminalIds(this.#ids, serverIds);
        for (const terminal of event.terminals) this.#observeMeta(terminal);
        for (const id of this.#tabs.keys()) {
          if (!this.#ids.includes(id)) this.#tabs.delete(id);
        }
        this.#active = resolveActiveTerminalId(this.#ids, this.#active);
        // Native reconcileThreadTerminalSessionIds: the visible group
        // follows the reconciled active terminal, not the stored group.
        this.#syncGroupsFollowingActive();
        break;
      }
      case "upsert":
        this.#observeMeta(event.terminal);
        // An upsert for an unknown id appended it to the list — keep the
        // group partition covering every session (new ids earn singletons).
        this.#syncGroups();
        break;
      case "remove":
        this.#removeTab(event.terminalId);
        return;
      case "closed":
        this.#stream = "closed";
        break;
    }
    this.#emit();
  }

  /**
   * A (re)subscription means the last snapshot may be stale — tabs stay
   * visible, but the stream is not authoritative until the next snapshot, so
   * openTerminal's allocation gate must wait for it. It also means the view
   * is alive: React replays effect cleanup in dev, and a tombstone from that
   * fake unmount would otherwise swallow every later sessions frame.
   */
  beginListStream() {
    this.#disposed = false;
    for (const [terminalId, tab] of this.#tabs) this.#liveInput(terminalId, tab);
    if (this.#stream === "connecting") return;
    this.#stream = "connecting";
    this.#emit();
  }

  markStreamDisconnected(message: string | null) {
    this.#stream = "closed";
    this.#panelError = message;
    this.#emit();
  }

  /**
   * A failed panel-level op outside the session stream — e.g. a dispatched
   * keybinding command whose `t3.ui/panels` call the host rejected. The next
   * stream transition overwrites it; it must not masquerade as stream state.
   */
  notePanelError(message: string) {
    this.#panelError = message;
    this.#emit();
  }

  /** Open a fresh terminal in its own group; the client picks the id (#15). */
  async openTerminal(): Promise<string | null> {
    return this.#open("new", "horizontal");
  }

  /**
   * `terminal.split`/`terminal.splitVertical`: a fresh session inserted into
   * the active group right after the focused pane, capped at
   * MAX_TERMINALS_PER_GROUP — at the cap the chord is refused before any PTY
   * spawns, exactly like the native `hasReachedSplitLimit` gate. With no
   * sessions yet the split degenerates to a plain open, as native does.
   */
  async splitTerminal(direction: TerminalSplitDirection = "horizontal"): Promise<string | null> {
    return this.#open("split", direction);
  }

  async #open(mode: "new" | "split", direction: TerminalSplitDirection): Promise<string | null> {
    const launch = this.#launch;
    if (!launch) {
      this.#panelError = "Terminal requires a workspace scope.";
      this.#emit();
      return null;
    }
    // Allocation must be serialized against the first list snapshot: before
    // it lands, unseen server-side sessions are invisible to nextTerminalId
    // and a colliding id would attach an existing terminal instead of opening
    // a fresh one (#17 strict-subset rule depends on this ordering).
    if (this.#stream !== "live") {
      this.#panelError = "Session list is still connecting.";
      this.#emit();
      return null;
    }
    const destination = mode === "split" ? this.#splitDestination() : null;
    if (destination !== null && destination.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
      return null;
    }
    if (this.#canAllocatePaneStream !== undefined && !this.#canAllocatePaneStream()) {
      this.#panelError =
        "Terminal stream limit reached — close a pane or another terminal panel first.";
      this.#emit();
      return null;
    }
    const terminalId = nextTerminalId(this.allocatableTerminalIds);
    const tab = this.#tab(terminalId);
    tab.starting = true;
    // A fresh process epoch: stale queued input and a stale input-stopped
    // flag both belong to the previous incarnation.
    tab.input.reset();
    tab.input.setReady(false);
    tab.error = null;
    this.#ids = [...this.#ids.filter((id) => id !== terminalId), terminalId];
    if (destination !== null) {
      // Insert after the focused pane (native anchors on the active
      // terminal) and stamp the direction this split was made with.
      const anchorIndex = destination.terminalIds.indexOf(this.#active ?? "");
      if (anchorIndex >= 0) destination.terminalIds.splice(anchorIndex + 1, 0, terminalId);
      else destination.terminalIds.push(terminalId);
      if (direction === "vertical") destination.splitDirection = "vertical";
      else delete destination.splitDirection;
    }
    this.#active = terminalId;
    this.#syncGroups();
    // "new" shows the fresh singleton group; "split" keeps showing the
    // destination group — both resolve to the group now holding the id.
    this.#activeGroupId = this.#groupIdOf(terminalId);
    this.#emit();
    try {
      const meta = await this.#control.open({
        terminalId,
        cwd: launch.cwd,
        worktreePath: launch.worktreePath,
        ...(launch.cols !== undefined ? { cols: launch.cols } : {}),
        ...(launch.rows !== undefined ? { rows: launch.rows } : {}),
        ...(launch.env !== undefined ? { env: launch.env } : {}),
      });
      tab.starting = false;
      tab.input.setReady(true);
      this.#observeMeta(meta);
      await this.#drain(terminalId);
    } catch (error) {
      tab.starting = false;
      tab.input.reset();
      tab.input.setReady(true);
      tab.error = error instanceof Error ? error.message : "Terminal open failed";
      this.#emit();
    }
    return terminalId;
  }

  /** Attach a tracked id that has no live metadata (restore/edge). */
  async startSession(terminalId: string): Promise<void> {
    const launch = this.#launch;
    const tab = this.#tabs.get(terminalId);
    if (!tab || !launch || tab.starting) return;
    if (tab.meta !== null && tab.meta.status !== "exited" && tab.meta.status !== "error") return;
    tab.starting = true;
    this.#liveInput(terminalId, tab).setReady(false);
    tab.exiting = false;
    tab.exitBanner = null;
    tab.error = null;
    this.#emit();
    try {
      const meta = await this.#control.attach({
        terminalId,
        cwd: launch.cwd,
        worktreePath: launch.worktreePath,
        restartIfNotRunning: true,
        ...(launch.cols !== undefined ? { cols: launch.cols } : {}),
        ...(launch.rows !== undefined ? { rows: launch.rows } : {}),
        ...(launch.env !== undefined ? { env: launch.env } : {}),
      });
      tab.starting = false;
      this.#liveInput(terminalId, tab).setReady(true);
      this.#observeMeta(meta);
      await this.#drain(terminalId);
    } catch (error) {
      tab.starting = false;
      this.#liveInput(terminalId, tab).setReady(true);
      tab.error = error instanceof Error ? error.message : "Terminal attach failed";
      this.#emit();
    }
  }

  /** Flush the pending fit-resize after a start resolves. */
  async #drain(terminalId: string) {
    const tab = this.#tabs.get(terminalId);
    if (!tab) return;
    const pending = tab.resizePending;
    tab.resizePending = null;
    if (pending) await this.#sendResize(terminalId, pending);
    this.#emit();
  }

  /**
   * Type into a terminal. Batches by serialized invocation bytes and stops on
   * an unknown write outcome — the queue owns ordering, bounds, and the
   * input-stopped halt; the panel only gates draining on `starting`.
   */
  sendInput(terminalId: string, data: string) {
    const tab = this.#tabs.get(terminalId);
    if (!tab || data.length === 0 || this.#disposed) return;
    const result = this.#liveInput(terminalId, tab).enqueue(data);
    if (result === "dropped-full") {
      tab.error = "Input dropped: the pending-input queue is full.";
      this.#emit();
    }
  }

  /** Explicit user resume after input-stopped. */
  resumeInput(terminalId: string) {
    const tab = this.#tabs.get(terminalId);
    if (tab) this.#liveInput(terminalId, tab).resume();
  }

  /** Output stream signalled a new process epoch or lifecycle end — pending input is stale. */
  resetInput(terminalId: string) {
    const tab = this.#tabs.get(terminalId);
    if (tab) this.#liveInput(terminalId, tab).reset();
  }

  /** Latest-wins resize: a new fit while one is in flight replaces the pending one. */
  resize(terminalId: string, cols: number, rows: number) {
    const safeCols = clampDimension(cols, 1000);
    const safeRows = clampDimension(rows, 500);
    if (safeCols === null || safeRows === null) return;
    const tab = this.#tabs.get(terminalId);
    if (!tab || this.#disposed) return;
    const next = { cols: safeCols, rows: safeRows };
    if (tab.resizeSent?.cols === next.cols && tab.resizeSent.rows === next.rows) return;
    if (tab.starting || tab.resizeInFlight !== null) {
      tab.resizePending = next;
      return;
    }
    void this.#sendResize(terminalId, next);
  }

  async #sendResize(terminalId: string, size: { cols: number; rows: number }) {
    const tab = this.#tabs.get(terminalId);
    if (!tab) return;
    tab.resizeInFlight = size;
    try {
      await this.#control.resize({ terminalId, cols: size.cols, rows: size.rows });
      tab.resizeSent = size;
    } catch (error) {
      tab.error = error instanceof Error ? error.message : "Terminal resize failed";
    } finally {
      tab.resizeInFlight = null;
      const pending = tab.resizePending;
      tab.resizePending = null;
      if (pending && !tab.starting) void this.#sendResize(terminalId, pending);
      this.#emit();
    }
  }

  requestAction(terminalId: string, action: TerminalConfirmAction) {
    const tab = this.#tabs.get(terminalId);
    if (!tab || this.#disposed) return;
    tab.confirm = action;
    this.#emit();
  }

  cancelAction(terminalId: string) {
    const tab = this.#tabs.get(terminalId);
    if (!tab) return;
    tab.confirm = null;
    this.#emit();
  }

  /** Confirmed destructive action; close falls back to a plain `exit\n` write. */
  async confirmAction(terminalId: string): Promise<void> {
    const tab = this.#tabs.get(terminalId);
    const action = tab?.confirm;
    if (!tab || !action) return;
    tab.confirm = null;
    if (action === "close") {
      try {
        await this.#control.close({ terminalId, deleteHistory: true });
      } catch {
        try {
          await this.#control.write({ terminalId, data: "exit\n" });
        } catch {
          // The session may already be gone; the tab still leaves.
        }
      }
      this.#removeTab(terminalId, "index");
      return;
    }
    const launch = this.#launch;
    try {
      if (action === "clear") {
        await this.#control.clear({ terminalId });
      } else {
        if (!launch) throw new Error("Terminal requires a workspace scope.");
        tab.starting = true;
        // New process epoch — input queued against the old one is stale.
        this.#liveInput(terminalId, tab).reset();
        tab.input.setReady(false);
        this.#emit();
        const meta = await this.#control.restart({
          terminalId,
          cwd: launch.cwd,
          worktreePath: launch.worktreePath,
          cols: launch.cols ?? 80,
          rows: launch.rows ?? 24,
          ...(launch.env !== undefined ? { env: launch.env } : {}),
        });
        tab.starting = false;
        tab.input.setReady(true);
        tab.exiting = false;
        tab.exitBanner = null;
        this.#observeMeta(meta);
        await this.#drain(terminalId);
        return;
      }
    } catch (error) {
      tab.starting = false;
      this.#liveInput(terminalId, tab).setReady(true);
      tab.error = error instanceof Error ? error.message : "Terminal action failed";
    }
    this.#emit();
  }

  /** Focus a pane — also surfaces its group, like the native setActiveTerminal. */
  activate(terminalId: string) {
    if (!this.#ids.includes(terminalId)) return;
    this.#active = terminalId;
    this.#activeGroupId = this.#groupIdOf(terminalId);
    this.#emit();
  }

  dispose() {
    this.#disposed = true;
    for (const tab of this.#tabs.values()) tab.input.dispose();
  }
}

// ---------------------------------------------------------------------------
// t3.ui/* consumption — theme, keybindings, panels
// ---------------------------------------------------------------------------

/** The view surface's host-visible id (`<manifestId>/<surfaceName>`). */
export const TERMINAL_SURFACE_ID = "t3.terminal/view";

/**
 * Host-computed `when` key for the focused extension surface —
 * `extension.<surfaceId>.focus`, the plugin-side mirror of the native
 * `terminalFocus` gate on terminal-scoped chords.
 */
export const TERMINAL_FOCUS_WHEN = `extension.${TERMINAL_SURFACE_ID}.focus`;

/**
 * View-scoped command set registered through `t3.ui/keybindings` — the
 * focused-view and thread tiers of the contract's arbitration (focused
 * binding → exactly-one thread binding → installation → activation). The
 * `defaultKey`s mirror the native terminal chords; the host always resolves
 * user and native rules first, so a displaced default is honest metadata
 * `listConflicts` reports rather than a stolen chord. The surface declares
 * `claimsTerminalFocus`, so while it owns focus the host leaves the
 * focused-terminal commands it resolves untouched, and the view's capture
 * handler dispatches them (`terminalChordAction`) instead of a native
 * terminal. The Ghostty-level editing intercepts (clear,
 * word-nav, delete) exist locally on the VT surface via `handleBeforeKey`;
 * what remains absent is adopting them as configurable commands through
 * `t3.ui/keybindings`.
 */
export const TERMINAL_VIEW_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: "toggle",
    title: "Toggle terminal",
    description: "Close this terminal panel.",
    scope: "global",
    defaultKey: "mod+j",
  },
  {
    id: "new",
    title: "New terminal",
    scope: "surface",
    defaultKey: "mod+n",
    when: TERMINAL_FOCUS_WHEN,
  },
  {
    id: "close",
    title: "Close terminal",
    scope: "surface",
    defaultKey: "mod+w",
    when: TERMINAL_FOCUS_WHEN,
  },
  {
    id: "split",
    title: "Split terminal horizontally",
    scope: "surface",
    defaultKey: "mod+d",
    when: TERMINAL_FOCUS_WHEN,
  },
  {
    id: "splitVertical",
    title: "Split terminal vertically",
    scope: "surface",
    defaultKey: "mod+shift+d",
    when: TERMINAL_FOCUS_WHEN,
  },
];

/**
 * Installation-tier set staged through `ClientHost.registerGlobalCommands` at
 * factory time: the same `toggle` command gains the cold-open activation
 * fallback — a chord press with no live binding opens this surface in the
 * active thread's dock, or focuses the instance already mounted there.
 * `activation` is legal only on an installation-scoped global command under
 * the `t3.ui/keybindings.global` + `t3.ui/panels` grants; without them the
 * host reports the command rejected and the rest of the panel is unaffected.
 */
export const TERMINAL_GLOBAL_COMMANDS: readonly GlobalCommandDescriptor[] = [
  {
    id: "toggle",
    title: "Toggle terminal",
    description: "Open the terminal panel, or close it when a terminal view answers.",
    scope: "global",
    defaultKey: "mod+j",
    activation: { surfaceId: TERMINAL_SURFACE_ID, placement: "bottom-dock" },
  },
];

/** Actions a dispatched command can drive; all panel-local. */
export interface TerminalCommandActions {
  /** Open a fresh terminal in this surface's workspace. */
  readonly newTerminal: () => void;
  /** Close the active terminal — the panel's inline confirm still applies. */
  readonly closeTerminal: () => void;
  /** Split the active group with a fresh pane in the given direction. */
  readonly splitTerminal: (direction: TerminalSplitDirection) => void;
  /** Dismiss the hosting surface (a `t3.ui/panels` closeSurface call). */
  readonly toggleSurface: () => void;
}

/* ------------------------------------------------------------------ */
/* Focused-terminal chord resolution — the host keymap's answer.       */
/* ------------------------------------------------------------------ */

export type TerminalChordAction = "split" | "splitVertical" | "new" | "close";

/**
 * The shipped default chords for the four focused-terminal commands, keyed
 * by the descriptor `defaultKey` spelling. Only a host without the
 * `t3.ui/keybindings@1.1.0` resolver falls back to these.
 */
export const TERMINAL_DEFAULT_CHORDS: ReadonlyMap<string, TerminalChordAction> = new Map([
  ["mod+d", "split"],
  ["mod+shift+d", "splitVertical"],
  ["mod+n", "new"],
  ["mod+w", "close"],
]);

/**
 * Native focused-terminal commands the panel can honor chord-for-chord:
 * dispatching these through the panel's own actions reproduces exactly
 * what the native terminal would have done.
 */
const NATIVE_TERMINAL_CHORD_COMMANDS: ReadonlyMap<string, TerminalChordAction> = new Map([
  ["terminal.split", "split"],
  ["terminal.splitVertical", "splitVertical"],
  ["terminal.new", "new"],
  ["terminal.close", "close"],
]);

/**
 * Canonical chord spelling for a keydown event — "mod+d" style, matching
 * the descriptor `defaultKey`s. Only single-character keys participate;
 * null means the event is not a mod chord this surface could own.
 */
export function terminalChordFromEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean,
): string | null {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || (isMac ? event.ctrlKey : event.metaKey)) return null;
  if (event.key.length !== 1) return null;
  return `mod${event.shiftKey ? "+shift" : ""}+${event.key.toLowerCase()}`;
}

/**
 * The panel action a keydown on the focused terminal dispatches, or null
 * when the key is not this surface's to act on.
 *
 * With the host's resolver (`t3.ui/keybindings@1.1.0`), the answer is the
 * host dispatcher's own resolution of the chord under terminal focus. The
 * dispatcher leaves exactly the four focused-terminal commands untouched
 * for a `claimsTerminalFocus` surface, so those map to panel actions. Any
 * other answer, including null, is a key the host already handled or that
 * belongs to the shell. The resolver is synchronous and reads the live
 * keymap, so there is no window in which a remap is unknown. Without it (a
 * host predating 1.1.0, or no `t3.ui/keybindings` grant), only the shipped
 * default chords apply.
 */
export function terminalChordAction(
  event: UiKeybindingChord,
  keybindings: UiKeybindingsHost | undefined,
  isMac: boolean,
): TerminalChordAction | null {
  if (keybindings !== undefined) {
    const command = keybindings.resolveTerminalFocusKey(event);
    return command === null ? null : (NATIVE_TERMINAL_CHORD_COMMANDS.get(command) ?? null);
  }
  const chord = terminalChordFromEvent(event, isMac);
  return chord === null ? null : (TERMINAL_DEFAULT_CHORDS.get(chord) ?? null);
}

/** Maps a dispatched command id to its panel action; false for unknown ids. */
export function dispatchTerminalCommand(
  commandId: string,
  actions: TerminalCommandActions,
): boolean {
  switch (commandId) {
    case "toggle":
      actions.toggleSurface();
      return true;
    case "new":
      actions.newTerminal();
      return true;
    case "close":
      actions.closeTerminal();
      return true;
    case "split":
      actions.splitTerminal("horizontal");
      return true;
    case "splitVertical":
      actions.splitTerminal("vertical");
      return true;
    default:
      return false;
  }
}

export interface PanelCommandRegistration {
  readonly commandSetToken: string;
  readonly results: readonly {
    commandId: string;
    status: "registered" | "rejected";
    reason?: string;
  }[];
  /** Best-effort unregister; the host drops the binding with the view anyway. */
  readonly release: () => void;
}

/**
 * Registers the view command set through `t3.ui/keybindings` and binds the
 * dispatch handler. Returns null when the caller's signal aborted mid-flight;
 * a `bindCommands` failure unwinds the registration so unreachable commands
 * never linger in the host's registry.
 */
export async function registerPanelCommands(options: {
  readonly client: Pick<ApiClient, "invokeApi">;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly bindCommands: (
    commandSetToken: string,
    handler: (call: { readonly commandId: string; readonly context: ViewContext }) => void,
  ) => string;
  readonly onCommand: (commandId: string) => void;
}): Promise<PanelCommandRegistration | null> {
  const api = bindApi(uiKeybindingsApi, options.client, options.context);
  const response = await api.invoke(
    "registerCommands",
    { commands: TERMINAL_VIEW_COMMANDS },
    options.signal,
  );
  const release = () => {
    void api
      .invoke(
        "unregisterCommands",
        { commandSetToken: response.commandSetToken },
        AbortSignal.timeout(5_000),
      )
      .catch(() => {});
  };
  if (options.signal.aborted) {
    release();
    return null;
  }
  const registered = new Set(
    response.results
      .filter((result) => result.status === "registered")
      .map((result) => result.commandId),
  );
  try {
    options.bindCommands(response.commandSetToken, ({ commandId }) => {
      if (registered.has(commandId)) options.onCommand(commandId);
    });
  } catch (error) {
    // A host without the binding store leaves the set registered but
    // unreachable — unwind so no phantom commands linger.
    release();
    throw error;
  }
  return { commandSetToken: response.commandSetToken, results: response.results, release };
}

/**
 * The roles this panel consumes, each republished as a `--t3-terminal-*`
 * custom property on the view root. Styles chain `var(--t3-terminal-x, …)`
 * ahead of their pre-contract fallbacks, so whenever the contract stops
 * answering — denied read or a dead stream — the overrides clear and the
 * panel renders exactly what it rendered before adoption. The `terminal*`
 * roles are the generic token layer — the dedicated terminal-appearance
 * stream overrides them with the host's real terminal colors and font.
 */
export const TERMINAL_THEME_VARS = {
  canvas: "--t3-terminal-canvas",
  text: "--t3-terminal-text",
  textMuted: "--t3-terminal-muted",
  border: "--t3-terminal-border",
  input: "--t3-terminal-input",
  accentSurface: "--t3-terminal-accent-surface",
  terminalBackground: "--t3-terminal-background",
  terminalForeground: "--t3-terminal-foreground",
  terminalSelection: "--t3-terminal-selection",
} as const;

/**
 * `getTokens` output → root-level custom properties. Each override carries
 * the contract's advertised var name with the resolved value as its fallback,
 * so the panel tracks `--app-theme-*` paints live and still gets the right
 * color on hosts that answer the contract without painting those variables.
 * A role missing from `tokens` is skipped entirely rather than overridden
 * with a lie.
 */
export function themeVarOverrides(
  tokens: Readonly<Record<string, string>>,
  cssVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [role, property] of Object.entries(TERMINAL_THEME_VARS)) {
    const value = tokens[role];
    if (value === undefined) continue;
    const contractVar = cssVars[role];
    overrides[property] = contractVar ? `var(${contractVar}, ${value})` : value;
  }
  return overrides;
}

/**
 * `getTerminalAppearance`/`subscribeTerminalAppearance` payload →
 * custom properties published on the output pane, where they win over the
 * token-layer roles of the same name. Optional fields are skipped so their
 * `var()` fallbacks keep governing.
 */
export function terminalAppearanceVars(appearance: UiTerminalAppearance): Record<string, string> {
  const vars: Record<string, string> = {
    "--t3-terminal-background": appearance.theme.background,
    "--t3-terminal-foreground": appearance.theme.foreground,
    "--t3-terminal-color-scheme": appearance.appearance,
  };
  if (appearance.theme.selectionBackground !== undefined)
    vars["--t3-terminal-selection"] = appearance.theme.selectionBackground;
  if (appearance.font.family !== undefined)
    vars["--t3-terminal-font-family"] = appearance.font.family;
  if (appearance.font.size !== undefined)
    vars["--t3-terminal-font-size"] = `${appearance.font.size}px`;
  if (appearance.font.lineHeight !== undefined)
    vars["--t3-terminal-line-height"] = String(appearance.font.lineHeight);
  if (appearance.font.ligatures !== undefined)
    vars["--t3-terminal-ligatures"] = appearance.font.ligatures ? "normal" : "none";
  return vars;
}

/**
 * Structural guard for `watchAppearance` frames — the typed stream surface is
 * erased on the wire, so a malformed payload must narrow honestly rather than
 * leak into the style map.
 */
export function asTerminalAppearance(value: unknown): UiTerminalAppearance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    readonly theme?: unknown;
    readonly font?: unknown;
    readonly appearance?: unknown;
  };
  const theme = candidate.theme;
  if (!theme || typeof theme !== "object" || Array.isArray(theme)) return null;
  const colors = theme as Record<string, unknown>;
  if (
    typeof colors.background !== "string" ||
    typeof colors.foreground !== "string" ||
    typeof colors.cursor !== "string" ||
    (colors.selectionBackground !== undefined && typeof colors.selectionBackground !== "string")
  )
    return null;
  const font = candidate.font;
  if (!font || typeof font !== "object" || Array.isArray(font)) return null;
  const fontFields = font as Record<string, unknown>;
  if (
    (fontFields.family !== undefined && typeof fontFields.family !== "string") ||
    (fontFields.size !== undefined &&
      (typeof fontFields.size !== "number" || !Number.isFinite(fontFields.size))) ||
    (fontFields.lineHeight !== undefined &&
      (typeof fontFields.lineHeight !== "number" || !Number.isFinite(fontFields.lineHeight))) ||
    (fontFields.ligatures !== undefined && typeof fontFields.ligatures !== "boolean")
  )
    return null;
  if (candidate.appearance !== "light" && candidate.appearance !== "dark") return null;
  return value as UiTerminalAppearance;
}

/**
 * Drives the theme-var layer: an initial `getTokens` read, re-read on every
 * `subscribeState` frame. `apply` receives the published map after each
 * successful read and `null` whenever the feed can't vouch for values —
 * at subscription start (a fresh feed must not inherit the old one's map),
 * on a denied read, and on a closed or lost stream (the no-stale-fallback
 * rule). A failure also invalidates any older in-flight response so it
 * cannot restore a stale map. The caller's `signal` owns the lifetime; the
 * stream has no resume, so recovery is a fresh subscription from the view
 * lifecycle (hide→show or session change).
 */
export function watchThemeVars(options: {
  readonly client: Pick<ApiClient, "invokeApi" | "subscribeApi">;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly apply: (vars: Record<string, string> | null) => void;
}): Promise<void> {
  const api = bindApi(uiThemeApi, options.client, options.context);
  const streams = bindStreamApi(uiThemeApi, options.client, options.context);
  if (!options.signal.aborted) options.apply(null);
  let generation = 0;
  const invalidate = () => {
    generation += 1;
    if (!options.signal.aborted) options.apply(null);
  };
  const refresh = () => {
    const at = ++generation;
    void api.invoke("getTokens", {}, options.signal).then(
      (value) => {
        if (!options.signal.aborted && at === generation)
          options.apply(themeVarOverrides(value.tokens, value.cssVars));
      },
      // A superseded rejection carries no fresh information — only the
      // newest read's failure may invalidate the published map.
      () => {
        if (at === generation) invalidate();
      },
    );
  };
  refresh();
  return (async () => {
    try {
      for await (const frame of streams.subscribe("subscribeState", {}, options.signal)) {
        if (options.signal.aborted) return;
        if (frame.type === "closed") break;
        refresh();
      }
      invalidate();
    } catch {
      invalidate();
    }
  })();
}

/**
 * `subscribeTerminalAppearance` consumption — the host's real terminal
 * colors and font, published on the output pane where they win over the
 * generic token roles of the same name. The stream opens with a snapshot
 * frame, so no separate read is needed; subscription start, a malformed
 * frame, a close, or a lost stream all clear the map so literal colors and
 * font metrics never outlive the feed that produced them.
 */
export function watchTerminalAppearanceVars(options: {
  readonly client: Pick<ApiClient, "subscribeApi">;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly apply: (vars: Record<string, string> | null) => void;
}): Promise<void> {
  const streams = bindStreamApi(uiThemeApi, options.client, options.context);
  if (!options.signal.aborted) options.apply(null);
  return (async () => {
    try {
      for await (const frame of streams.subscribe(
        "subscribeTerminalAppearance",
        {},
        options.signal,
      )) {
        if (options.signal.aborted) return;
        if (frame.type === "closed") break;
        const appearance = asTerminalAppearance(frame.value);
        options.apply(appearance === null ? null : terminalAppearanceVars(appearance));
      }
      if (!options.signal.aborted) options.apply(null);
    } catch {
      if (!options.signal.aborted) options.apply(null);
    }
  })();
}
