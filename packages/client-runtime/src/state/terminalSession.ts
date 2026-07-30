import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly bufferEpoch: number;
  readonly appendedLength: number;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly bufferEpoch: number;
  readonly appendedLength: number;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  bufferEpoch: 0,
  appendedLength: 0,
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  bufferEpoch: 0,
  appendedLength: 0,
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  bufferEpoch = 1,
): TerminalBufferState {
  return {
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    bufferEpoch,
    appendedLength: 0,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    bufferEpoch: buffer.bufferEpoch,
    appendedLength: buffer.appendedLength,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(
        event.snapshot,
        maxBufferBytes,
        current.bufferEpoch + 1,
      );
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        appendedLength: current.appendedLength + event.data.length,
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        bufferEpoch: current.bufferEpoch + 1,
        appendedLength: 0,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export type TerminalBufferRenderUpdate =
  | { readonly type: "none" }
  | { readonly type: "append"; readonly data: string }
  | { readonly type: "replace"; readonly data: string };

/**
 * Resolve how a terminal renderer should consume a reduced attach-stream state.
 *
 * The retained buffer is a bounded tail. Once it reaches the cap, appending
 * output shifts its prefix, so prefix comparison alone incorrectly looks like
 * a full replacement on every event. `appendedLength` is monotonic within a
 * buffer epoch and lets renderers append only the unseen tail while history
 * rolls underneath them.
 */
export function resolveTerminalBufferRenderUpdate(
  previous: Pick<TerminalBufferState, "appendedLength" | "buffer" | "bufferEpoch">,
  current: Pick<TerminalBufferState, "appendedLength" | "buffer" | "bufferEpoch">,
): TerminalBufferRenderUpdate {
  if (current.bufferEpoch !== previous.bufferEpoch) {
    return { type: "replace", data: current.buffer };
  }

  const appendedLength = current.appendedLength - previous.appendedLength;
  if (appendedLength === 0) {
    return { type: "none" };
  }
  if (appendedLength < 0 || appendedLength > current.buffer.length) {
    return { type: "replace", data: current.buffer };
  }
  return {
    type: "append",
    data: current.buffer.slice(current.buffer.length - appendedLength),
  };
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
