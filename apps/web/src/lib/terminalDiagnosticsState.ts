import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef, TerminalSessionSnapshot } from "@t3tools/contracts";

const MAX_TERMINAL_DIAGNOSTIC_EVENTS = 500;
const MAX_RECENT_TERMINAL_DIAGNOSTIC_EVENTS = 120;

export type TerminalDiagnosticKind =
  | "api-unavailable"
  | "drawer-focusin"
  | "drawer-focusout"
  | "drawer-state"
  | "focus-applied"
  | "focus-requested"
  | "hydration-complete"
  | "input-received"
  | "keyboard-viewport"
  | "open-error"
  | "open-retry-failed"
  | "open-retry-scheduled"
  | "open-retry-started"
  | "open-retry-success"
  | "open-start"
  | "open-success"
  | "replay-applied"
  | "resize-deferred"
  | "resize-error"
  | "resize-flushed"
  | "resize-start"
  | "resize-success"
  | "terminal-event-applied"
  | "terminal-resync-failed"
  | "terminal-resync-started"
  | "terminal-resync-success"
  | "terminal-restart-clicked"
  | "terminal-restart-confirmed"
  | "terminal-restart-failed"
  | "terminal-restart-success"
  | "viewport-mounted"
  | "viewport-unmounted"
  | "write-error"
  | "write-start"
  | "write-success"
  | "xterm-opened";

export type TerminalInputSource =
  | "accessory-key"
  | "custom-key-handler"
  | "paste"
  | "xterm-on-data";

export type TerminalInputKind =
  | "arrow"
  | "backspace"
  | "control"
  | "empty"
  | "enter"
  | "escape"
  | "mixed"
  | "paste-or-composition"
  | "tab"
  | "text";

export interface TerminalInputSummary {
  readonly byteLength: number;
  readonly charLength: number;
  readonly codePointLength: number;
  readonly controlCodeCount: number;
  readonly escapeCount: number;
  readonly inputKind: TerminalInputKind;
  readonly newlineCount: number;
  readonly printableCodePointCount: number;
}

export interface TerminalDiagnosticEvent {
  readonly data?: Record<string, unknown>;
  readonly environmentId: string;
  readonly id: number;
  readonly kind: TerminalDiagnosticKind;
  readonly terminalId: string;
  readonly threadId: string;
  readonly threadKey: string;
  readonly ts: number;
}

interface PendingTerminalWrite {
  readonly attemptId: number;
  readonly input: TerminalInputSummary;
  readonly source: TerminalInputSource;
  readonly startedAt: number;
  readonly terminalId: string;
  readonly threadKey: string;
}

export interface TerminalWriteDiagnosticAttempt {
  readonly attemptId: number;
  readonly startedAt: number;
}

export type TerminalRecoveryDiagnosticsState =
  | "idle"
  | "manual-resyncing"
  | "manual-restarting"
  | "opening"
  | "retrying-open";

export interface TerminalRecoveryDiagnosticsSummary {
  readonly currentRecoveryState: TerminalRecoveryDiagnosticsState;
  readonly lastInputAt: number | null;
  readonly lastOpenError: { readonly message: string | null; readonly ts: number } | null;
  readonly lastOpenSuccessAt: number | null;
  readonly lastOutputAt: number | null;
  readonly lastTerminalEventAt: number | null;
  readonly lastWriteSuccessAt: number | null;
  readonly msSinceLastOutput: number | null;
  readonly terminalId: string;
  readonly writesSinceLastOutput: number;
}

export interface TerminalDiagnosticsSnapshot {
  readonly countsByKind: Partial<Record<TerminalDiagnosticKind, number>>;
  readonly pendingWrites: ReadonlyArray<
    Omit<PendingTerminalWrite, "startedAt"> & {
      readonly ageMs: number;
      readonly startedAt: number;
    }
  >;
  readonly recentEvents: ReadonlyArray<TerminalDiagnosticEvent>;
  readonly returnedEventCount: number;
  readonly terminalRecoveryById: Record<string, TerminalRecoveryDiagnosticsSummary>;
  readonly threadKey: string | null;
  readonly totalEventCount: number;
  readonly totalWriteAttemptCount: number;
}

let nextEventId = 1;
let nextWriteAttemptId = 1;
let totalWriteAttemptCount = 0;
let events: TerminalDiagnosticEvent[] = [];
const pendingWrites = new Map<number, PendingTerminalWrite>();

function nowMs(): number {
  return Date.now();
}

function bytesForText(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

function boundedData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value === "string" && value.length > 500) {
        return [key, `${value.slice(0, 500)}...`];
      }
      return [key, value];
    }),
  );
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function numericDataField(data: Record<string, unknown> | undefined, key: string): number | null {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringDataField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function codePointIsPrintable(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint !== 0x7f;
}

function classifyTerminalInput(data: string): TerminalInputKind {
  if (data.length === 0) {
    return "empty";
  }
  if (data === "\r" || data === "\n" || data === "\r\n") {
    return "enter";
  }
  if (data === "\u007f") {
    return "backspace";
  }
  if (data === "\t") {
    return "tab";
  }
  if (data === "\u001b") {
    return "escape";
  }
  if (
    data.length === 3 &&
    data.charCodeAt(0) === 0x1b &&
    data[1] === "[" &&
    "ABCD".includes(data[2] ?? "")
  ) {
    return "arrow";
  }

  const codePoints = Array.from(data, (char) => char.codePointAt(0) ?? 0);
  const controlCodeCount = codePoints.filter(
    (codePoint) => !codePointIsPrintable(codePoint),
  ).length;
  if (codePoints.length === 1 && controlCodeCount === 1) {
    return "control";
  }
  if (codePoints.length > 1 && controlCodeCount === 0) {
    return "paste-or-composition";
  }
  if (controlCodeCount > 0) {
    return "mixed";
  }
  return "text";
}

export function summarizeTerminalInput(data: string): TerminalInputSummary {
  const codePoints = Array.from(data, (char) => char.codePointAt(0) ?? 0);
  const controlCodeCount = codePoints.filter(
    (codePoint) => !codePointIsPrintable(codePoint),
  ).length;
  return {
    byteLength: bytesForText(data),
    charLength: data.length,
    codePointLength: codePoints.length,
    controlCodeCount,
    escapeCount: codePoints.filter((codePoint) => codePoint === 0x1b).length,
    inputKind: classifyTerminalInput(data),
    newlineCount: codePoints.filter((codePoint) => codePoint === 0x0a || codePoint === 0x0d).length,
    printableCodePointCount: codePoints.length - controlCodeCount,
  };
}

export function recordTerminalDiagnostic(
  threadRef: ScopedThreadRef,
  terminalId: string,
  kind: TerminalDiagnosticKind,
  data?: Record<string, unknown>,
): void {
  if (threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return;
  }
  const bounded = boundedData(data);
  events.push({
    ...(bounded !== undefined ? { data: bounded } : {}),
    environmentId: threadRef.environmentId,
    id: nextEventId,
    kind,
    terminalId,
    threadId: threadRef.threadId,
    threadKey: scopedThreadKey(threadRef),
    ts: nowMs(),
  });
  nextEventId += 1;
  if (events.length > MAX_TERMINAL_DIAGNOSTIC_EVENTS) {
    events = events.slice(-MAX_TERMINAL_DIAGNOSTIC_EVENTS);
  }
}

export function recordTerminalInputReceived(input: {
  readonly data: string;
  readonly source: TerminalInputSource;
  readonly terminalId: string;
  readonly threadRef: ScopedThreadRef;
  readonly transformed?: boolean;
}): TerminalInputSummary {
  const summary = summarizeTerminalInput(input.data);
  recordTerminalDiagnostic(input.threadRef, input.terminalId, "input-received", {
    input: summary,
    source: input.source,
    transformed: input.transformed ?? false,
  });
  return summary;
}

export function recordTerminalWriteStart(input: {
  readonly data: string;
  readonly source: TerminalInputSource;
  readonly terminalId: string;
  readonly threadRef: ScopedThreadRef;
}): TerminalWriteDiagnosticAttempt {
  const attemptId = nextWriteAttemptId;
  nextWriteAttemptId += 1;
  totalWriteAttemptCount += 1;
  const startedAt = nowMs();
  const summary = summarizeTerminalInput(input.data);
  pendingWrites.set(attemptId, {
    attemptId,
    input: summary,
    source: input.source,
    startedAt,
    terminalId: input.terminalId,
    threadKey: scopedThreadKey(input.threadRef),
  });
  recordTerminalDiagnostic(input.threadRef, input.terminalId, "write-start", {
    attemptId,
    input: summary,
    source: input.source,
  });
  return { attemptId, startedAt };
}

export function recordTerminalWriteSuccess(input: {
  readonly attempt: TerminalWriteDiagnosticAttempt;
  readonly terminalId: string;
  readonly threadRef: ScopedThreadRef;
}): void {
  pendingWrites.delete(input.attempt.attemptId);
  recordTerminalDiagnostic(input.threadRef, input.terminalId, "write-success", {
    attemptId: input.attempt.attemptId,
    durationMs: Math.max(0, nowMs() - input.attempt.startedAt),
  });
}

export function recordTerminalWriteError(input: {
  readonly attempt: TerminalWriteDiagnosticAttempt;
  readonly error: unknown;
  readonly terminalId: string;
  readonly threadRef: ScopedThreadRef;
}): void {
  pendingWrites.delete(input.attempt.attemptId);
  recordTerminalDiagnostic(input.threadRef, input.terminalId, "write-error", {
    attemptId: input.attempt.attemptId,
    durationMs: Math.max(0, nowMs() - input.attempt.startedAt),
    message: formatError(input.error, "Terminal write failed"),
  });
}

export function summarizeTerminalSnapshot(
  snapshot: TerminalSessionSnapshot,
): Record<string, unknown> {
  return {
    cwd: snapshot.cwd,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    historyBytes: bytesForText(snapshot.history),
    historyChars: snapshot.history.length,
    pid: snapshot.pid,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    worktreePath: snapshot.worktreePath,
  };
}

export function readTerminalDomDiagnostics(
  root: Element | null | undefined,
): Record<string, unknown> {
  if (typeof document === "undefined") {
    return {
      documentAvailable: false,
    };
  }
  const activeElement = document.activeElement;
  const activeElementRecord =
    typeof HTMLElement !== "undefined" && activeElement instanceof HTMLElement
      ? {
          className: activeElement.className,
          contentEditable: activeElement.contentEditable,
          inputMode: activeElement.inputMode,
          isTextArea:
            typeof HTMLTextAreaElement !== "undefined" &&
            activeElement instanceof HTMLTextAreaElement,
          isWithinRoot: root ? root.contains(activeElement) : null,
          role: activeElement.getAttribute("role"),
          tabIndex: activeElement.tabIndex,
          tagName: activeElement.tagName,
        }
      : null;
  const visualViewport =
    typeof window === "undefined" || !window.visualViewport
      ? null
      : {
          height: window.visualViewport.height,
          offsetLeft: window.visualViewport.offsetLeft,
          offsetTop: window.visualViewport.offsetTop,
          pageLeft: window.visualViewport.pageLeft,
          pageTop: window.visualViewport.pageTop,
          scale: window.visualViewport.scale,
          width: window.visualViewport.width,
        };
  return {
    activeElement: activeElementRecord,
    documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    visibilityState: document.visibilityState,
    visualViewport,
    viewport:
      typeof window === "undefined"
        ? null
        : {
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
          },
  };
}

function recoveryStateAfterEvent(
  current: TerminalRecoveryDiagnosticsState,
  event: TerminalDiagnosticEvent,
): TerminalRecoveryDiagnosticsState {
  switch (event.kind) {
    case "open-start": {
      const reason = stringDataField(event.data, "reason");
      if (current === "manual-resyncing" || reason === "manual-resync") {
        return "manual-resyncing";
      }
      if (reason === "retry") {
        return "retrying-open";
      }
      return "opening";
    }
    case "open-retry-scheduled":
    case "open-retry-started":
    case "open-retry-failed":
      return "retrying-open";
    case "open-success":
    case "open-retry-success":
    case "hydration-complete":
      return current === "manual-resyncing" || current === "manual-restarting" ? current : "idle";
    case "terminal-resync-started":
      return "manual-resyncing";
    case "terminal-resync-failed":
    case "terminal-resync-success":
      return "idle";
    case "terminal-restart-confirmed":
      return "manual-restarting";
    case "terminal-restart-failed":
    case "terminal-restart-success":
      return "idle";
    case "terminal-event-applied":
      return event.data?.eventType === "activity" ||
        current === "manual-resyncing" ||
        current === "manual-restarting"
        ? current
        : "idle";
    default:
      return current;
  }
}

function summarizeTerminalRecovery(
  filteredEvents: ReadonlyArray<TerminalDiagnosticEvent>,
  snapshotNowMs: number,
): Record<string, TerminalRecoveryDiagnosticsSummary> {
  const terminalIds = [...new Set(filteredEvents.map((event) => event.terminalId))];
  const summaries: Record<string, TerminalRecoveryDiagnosticsSummary> = {};

  for (const terminalId of terminalIds) {
    let currentRecoveryState: TerminalRecoveryDiagnosticsState = "idle";
    let lastInputAt: number | null = null;
    let lastOpenError: { message: string | null; ts: number } | null = null;
    let lastOpenSuccessAt: number | null = null;
    let lastOutputAt: number | null = null;
    let lastTerminalEventAt: number | null = null;
    let lastWriteSuccessAt: number | null = null;
    let writesSinceLastOutput = 0;

    for (const event of filteredEvents) {
      if (event.terminalId !== terminalId) {
        continue;
      }
      currentRecoveryState = recoveryStateAfterEvent(currentRecoveryState, event);

      switch (event.kind) {
        case "input-received":
          lastInputAt = event.ts;
          break;
        case "open-error":
        case "open-retry-failed":
          lastOpenError = {
            message: stringDataField(event.data, "message"),
            ts: event.ts,
          };
          break;
        case "open-success":
        case "open-retry-success":
          lastOpenSuccessAt = event.ts;
          lastOpenError = null;
          break;
        case "terminal-event-applied": {
          const eventTs = numericDataField(event.data, "eventAppliedAt") ?? event.ts;
          lastTerminalEventAt = eventTs;
          if (event.data?.eventType === "output") {
            lastOutputAt = eventTs;
            writesSinceLastOutput = 0;
          }
          break;
        }
        case "write-success":
          lastWriteSuccessAt = event.ts;
          if (lastOutputAt === null || event.ts >= lastOutputAt) {
            writesSinceLastOutput += 1;
          }
          break;
      }
    }

    summaries[terminalId] = {
      currentRecoveryState,
      lastInputAt,
      lastOpenError,
      lastOpenSuccessAt,
      lastOutputAt,
      lastTerminalEventAt,
      lastWriteSuccessAt,
      msSinceLastOutput:
        lastOutputAt === null ? null : Math.max(0, Math.round(snapshotNowMs - lastOutputAt)),
      terminalId,
      writesSinceLastOutput,
    };
  }

  return summaries;
}

export function getTerminalDiagnosticsSnapshot(input?: {
  readonly nowMs?: number;
  readonly threadRef?: ScopedThreadRef;
}): TerminalDiagnosticsSnapshot {
  const threadKey = input?.threadRef ? scopedThreadKey(input.threadRef) : null;
  const filteredEvents =
    threadKey === null ? events : events.filter((event) => event.threadKey === threadKey);
  const countsByKind: Partial<Record<TerminalDiagnosticKind, number>> = {};
  for (const event of filteredEvents) {
    countsByKind[event.kind] = (countsByKind[event.kind] ?? 0) + 1;
  }
  const snapshotNowMs = input?.nowMs ?? nowMs();
  const terminalRecoveryById = summarizeTerminalRecovery(filteredEvents, snapshotNowMs);
  return {
    countsByKind,
    pendingWrites: [...pendingWrites.values()]
      .filter((write) => threadKey === null || write.threadKey === threadKey)
      .map((write) => ({
        ageMs: Math.max(0, snapshotNowMs - write.startedAt),
        attemptId: write.attemptId,
        input: write.input,
        source: write.source,
        startedAt: write.startedAt,
        terminalId: write.terminalId,
        threadKey: write.threadKey,
      })),
    recentEvents: filteredEvents.slice(-MAX_RECENT_TERMINAL_DIAGNOSTIC_EVENTS),
    returnedEventCount: filteredEvents.length,
    terminalRecoveryById,
    threadKey,
    totalEventCount: events.length,
    totalWriteAttemptCount,
  };
}

export function resetTerminalDiagnosticsForTests(): void {
  nextEventId = 1;
  nextWriteAttemptId = 1;
  totalWriteAttemptCount = 0;
  events = [];
  pendingWrites.clear();
}
