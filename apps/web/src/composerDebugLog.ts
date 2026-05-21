const COMPOSER_DEBUG_ENABLED_KEY = "t3code:composer-debug-enabled";
const COMPOSER_DEBUG_MAX_ENTRIES = 300;
const COMPOSER_DEBUG_MAX_IMPORTANT_EVENTS = 140;
const COMPOSER_DEBUG_TAIL_CHARS = 70;
const COMPOSER_DEBUG_FINAL_TAIL_CHARS = 140;

export type ComposerDebugEntry = {
  readonly sequence: number;
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly event: string;
  readonly data?: unknown;
};

let entries: ComposerDebugEntry[] = [];
let nextSequence = 1;
let debugEnabled: boolean | null = null;

type JsonRecord = Record<string, unknown>;

type CompactComposerSnapshot = {
  readonly valueLength?: number;
  readonly valueTail?: string;
  readonly cursor?: number;
  readonly expandedCursor?: number;
  readonly selectionKind?: string;
  readonly selectionCollapsed?: boolean | null;
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: JsonRecord | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: JsonRecord | null, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNullableBoolean(record: JsonRecord | null, key: string): boolean | null | undefined {
  if (!record || !(key in record)) {
    return undefined;
  }
  const value = record[key];
  return value === null || typeof value === "boolean" ? value : undefined;
}

function compactTextTail(value: string | undefined, maxLength = COMPOSER_DEBUG_TAIL_CHARS) {
  if (value === undefined) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function compactRecord(record: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function readSnapshot(value: unknown): CompactComposerSnapshot | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const snapshot: CompactComposerSnapshot = compactRecord({
    valueLength: readNumber(record, "valueLength"),
    valueTail: compactTextTail(readString(record, "valueTail")),
    cursor: readNumber(record, "cursor"),
    expandedCursor: readNumber(record, "expandedCursor"),
    selectionKind: readString(record, "selectionKind"),
    selectionCollapsed: readNullableBoolean(record, "selectionCollapsed"),
  });
  return Object.keys(snapshot).length === 0 ? null : snapshot;
}

function readEntryInputType(entry: ComposerDebugEntry): string | undefined {
  const data = asRecord(entry.data);
  const metadata = asRecord(data?.metadata);
  return readString(data, "inputType") ?? readString(metadata, "inputType");
}

function readInputDataTail(entry: ComposerDebugEntry): string | undefined {
  const data = asRecord(entry.data);
  return compactTextTail(readString(asRecord(data?.data), "tail"), 24);
}

function readLatestSnapshot(entry: ComposerDebugEntry): CompactComposerSnapshot | null {
  const data = asRecord(entry.data);
  return readSnapshot(data?.next) ?? readSnapshot(data?.snapshot) ?? readSnapshot(data);
}

function readFinalSnapshot(
  debugEntries: ReadonlyArray<ComposerDebugEntry>,
): CompactComposerSnapshot | null {
  for (let index = debugEntries.length - 1; index >= 0; index -= 1) {
    const entry = debugEntries[index];
    if (!entry) {
      continue;
    }
    const snapshot = readLatestSnapshot(entry);
    if (snapshot) {
      if (snapshot.valueTail === undefined) {
        return snapshot;
      }
      const valueTail =
        snapshot.valueTail.length > COMPOSER_DEBUG_FINAL_TAIL_CHARS
          ? snapshot.valueTail.slice(-COMPOSER_DEBUG_FINAL_TAIL_CHARS)
          : snapshot.valueTail;
      return {
        ...snapshot,
        valueTail,
      };
    }
  }
  return null;
}

function readLastInputType(debugEntries: ReadonlyArray<ComposerDebugEntry>): string | null {
  for (let index = debugEntries.length - 1; index >= 0; index -= 1) {
    const entry = debugEntries[index];
    if (!entry) {
      continue;
    }
    const inputType = readEntryInputType(entry);
    if (inputType) {
      return inputType;
    }
  }
  return null;
}

function countByEvent(debugEntries: ReadonlyArray<ComposerDebugEntry>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of debugEntries) {
    counts[entry.event] = (counts[entry.event] ?? 0) + 1;
  }
  return counts;
}

function countByInputType(debugEntries: ReadonlyArray<ComposerDebugEntry>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of debugEntries) {
    const inputType = readEntryInputType(entry);
    if (inputType) {
      counts[inputType] = (counts[inputType] ?? 0) + 1;
    }
  }
  return counts;
}

function detectPlatform(userAgent: string | null): string | null {
  if (!userAgent) {
    return null;
  }
  if (/iPhone/.test(userAgent) && /Safari/.test(userAgent)) {
    return "iPhone Safari";
  }
  if (/iPad/.test(userAgent) && /Safari/.test(userAgent)) {
    return "iPad Safari";
  }
  if (/Android/.test(userAgent)) {
    return "Android";
  }
  return null;
}

function isImportantDebugEntry(entry: ComposerDebugEntry): boolean {
  if (
    entry.event === "lexicalChange.emit" ||
    entry.event === "controlledSync.apply" ||
    entry.event === "imperative.focusAt" ||
    entry.event === "native.compositionstart" ||
    entry.event === "native.compositionend" ||
    entry.event === "native.keydown" ||
    entry.event === "chatComposer.trigger.suppressed" ||
    entry.event === "chatComposer.trigger.deferredDetection"
  ) {
    return true;
  }

  if (entry.event === "chatComposer.trigger.updated") {
    return asRecord(entry.data)?.trigger !== null && asRecord(entry.data)?.trigger !== undefined;
  }

  if (entry.event !== "native.beforeinput" && entry.event !== "native.input") {
    return false;
  }

  const inputType = readEntryInputType(entry);
  const dataTail = readInputDataTail(entry);
  return (
    inputType !== "insertText" ||
    dataTail === " " ||
    dataTail === "." ||
    dataTail === "\n" ||
    dataTail === "\r"
  );
}

function compactDebugEntry(entry: ComposerDebugEntry): JsonRecord {
  const data = asRecord(entry.data);
  const metadata = asRecord(data?.metadata);
  const previous = readSnapshot(data?.previous);
  const next = readSnapshot(data?.next);
  const snapshot = readLatestSnapshot(entry);
  const trigger = asRecord(data?.trigger);
  const terminalContextIds = data?.terminalContextIds;

  return compactRecord({
    sequence: entry.sequence,
    elapsedMs: entry.elapsedMs,
    event: entry.event,
    inputType: readEntryInputType(entry),
    dataTail: readInputDataTail(entry),
    key: readString(data, "key"),
    code: readString(data, "code"),
    browserHandled: readBoolean(data, "browserHandled"),
    isComposing: readBoolean(data, "isComposing") ?? readBoolean(metadata, "isComposing"),
    composingKey: readBoolean(data, "composingKey"),
    suppressTriggerDetection: readBoolean(metadata, "suppressTriggerDetection"),
    focused: readBoolean(data, "focused"),
    shouldRewriteEditorState: readBoolean(data, "shouldRewriteEditorState"),
    contextsChanged: readBoolean(data, "contextsChanged"),
    skillsChanged: readBoolean(data, "skillsChanged"),
    cursorAdjacentToMention: readBoolean(data, "cursorAdjacentToMention"),
    previousTail: previous?.valueTail,
    nextTail: next?.valueTail,
    valueTail: snapshot?.valueTail,
    valueLength: next?.valueLength ?? snapshot?.valueLength,
    cursor: next?.cursor ?? snapshot?.cursor,
    expandedCursor: next?.expandedCursor ?? snapshot?.expandedCursor,
    selectionCollapsed: snapshot?.selectionCollapsed,
    terminalContextCount: Array.isArray(terminalContextIds) ? terminalContextIds.length : undefined,
    trigger: trigger
      ? compactRecord({
          kind: readString(trigger, "kind"),
          query: readString(trigger, "query"),
          rangeStart: readNumber(trigger, "rangeStart"),
          rangeEnd: readNumber(trigger, "rangeEnd"),
        })
      : data && "trigger" in data
        ? null
        : undefined,
  });
}

function selectImportantEvents(debugEntries: ReadonlyArray<ComposerDebugEntry>): {
  readonly droppedImportantEventCount: number;
  readonly importantEvents: ReadonlyArray<JsonRecord>;
} {
  const importantEvents = debugEntries.filter(isImportantDebugEntry).map(compactDebugEntry);
  const droppedImportantEventCount = Math.max(
    0,
    importantEvents.length - COMPOSER_DEBUG_MAX_IMPORTANT_EVENTS,
  );
  return {
    droppedImportantEventCount,
    importantEvents: importantEvents.slice(-COMPOSER_DEBUG_MAX_IMPORTANT_EVENTS),
  };
}

function readDebugEnabledFromLocation(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return false;
  }
  try {
    const enabledParam = new URL(window.location.href).searchParams.get("composerDebug");
    if (enabledParam === "1" || enabledParam === "true") {
      localStorage.setItem(COMPOSER_DEBUG_ENABLED_KEY, "1");
      return true;
    }
    if (enabledParam === "0" || enabledParam === "false") {
      localStorage.removeItem(COMPOSER_DEBUG_ENABLED_KEY);
      return false;
    }
    return localStorage.getItem(COMPOSER_DEBUG_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function isComposerDebugEnabled(): boolean {
  debugEnabled ??= readDebugEnabledFromLocation();
  return debugEnabled;
}

export function appendComposerDebugEvent(event: string, data?: unknown): void {
  if (!isComposerDebugEnabled()) {
    return;
  }
  entries.push({
    sequence: nextSequence,
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(nowMs()),
    event,
    ...(data === undefined ? {} : { data }),
  });
  nextSequence += 1;
  if (entries.length > COMPOSER_DEBUG_MAX_ENTRIES) {
    entries.splice(0, entries.length - COMPOSER_DEBUG_MAX_ENTRIES);
  }
}

export function readComposerDebugEntries(): readonly ComposerDebugEntry[] {
  return [...entries];
}

export function clearComposerDebugEntries(): void {
  entries = [];
  nextSequence = 1;
}

export function formatComposerDebugPayload(): string {
  const debugEntries = readComposerDebugEntries();
  const firstEntry = debugEntries[0] ?? null;
  const lastEntry = debugEntries[debugEntries.length - 1] ?? null;
  const userAgent = typeof navigator === "undefined" ? null : navigator.userAgent;
  const finalSnapshot = readFinalSnapshot(debugEntries);
  const importantEventSelection = selectImportantEvents(debugEntries);
  const payload = {
    copiedAt: new Date().toISOString(),
    reportVersion: 2,
    compact: true,
    userAgent,
    location:
      typeof window === "undefined"
        ? null
        : {
            pathname: window.location.pathname,
            search: window.location.search,
            standalone:
              window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
              Boolean(
                "standalone" in navigator &&
                (navigator as { standalone?: unknown }).standalone === true,
              ),
          },
    summary: {
      totalEvents: debugEntries.length,
      sequenceRange:
        firstEntry && lastEntry ? `${firstEntry.sequence}-${lastEntry.sequence}` : null,
      timeRange:
        firstEntry && lastEntry ? `${firstEntry.timestamp} to ${lastEntry.timestamp}` : null,
      elapsedMsRange:
        firstEntry && lastEntry ? `${firstEntry.elapsedMs}-${lastEntry.elapsedMs}` : null,
      platform: detectPlatform(userAgent),
      finalValueLength: finalSnapshot?.valueLength ?? null,
      finalValueTail: finalSnapshot?.valueTail ?? null,
      finalCursor: finalSnapshot?.cursor ?? null,
      finalExpandedCursor: finalSnapshot?.expandedCursor ?? null,
      selectionCollapsed: finalSnapshot?.selectionCollapsed ?? null,
      lastInputType: readLastInputType(debugEntries),
    },
    eventCounts: countByEvent(debugEntries),
    inputTypeCounts: countByInputType(debugEntries),
    droppedImportantEventCount: importantEventSelection.droppedImportantEventCount,
    importantEvents: importantEventSelection.importantEvents,
    note: `Compact report: raw entries omitted; importantEvents capped at ${COMPOSER_DEBUG_MAX_IMPORTANT_EVENTS}.`,
  };
  return JSON.stringify(payload);
}
