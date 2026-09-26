/**
 * Durable voice session history: a chronological, recoverable record of what
 * happened in voice sessions, surviving close, reconnect, and full client
 * reload.
 *
 * What is recorded: ordered transcript utterances (with the client's stable
 * utterance keys), timing marks, tool calls with allowlisted input
 * identifiers and sanitized bounded outcome fields (dispatch identity and
 * sequence, session status and lastError, acknowledged and destination,
 * control state), direct command results, acknowledged navigation targets,
 * and errors. What is never recorded: audio (no audio ever reaches this
 * module), credentials or tokens (inputs and outputs are filtered through
 * allowlists), raw thread contents, and model reasoning (never visible to
 * the client).
 *
 * Scope (deliberate): this is a client-local store in the same guarded
 * namespaced-localStorage pattern as the worker profiles and delivery
 * records (see index.ts). Nothing is synced to the server. The store
 * resolves per client where it runs: web and desktop share saved history
 * only when they resolve to the same browser profile origin; Electron
 * storage partitions can be separate, and mobile is separate. Each client
 * sees only the sessions it witnessed.
 *
 * Write discipline: transcript deltas accumulate in memory and persist only
 * at boundaries (a new utterance opens, a non-transcript event arrives, the
 * session ends, or an explicit flush on pagehide), so no storage write and
 * no synchronous full rewrite happens per audio delta. Each boundary write
 * touches only the active session's key; the index changes only at session
 * begin/end/trim. Retention is bounded: at most `maxSessions` sessions of at
 * most `maxEntriesPerSession` entries each, oldest trimmed first.
 */

import { createMemoryStorage } from "../lib/storage";
import type { VoiceLiveClientEvent } from "./live-client";
import type { VoiceNavigationDestination, VoiceNavigationResult } from "./navigation";

// ---------------------------------------------------------------------------
// Storage (the index.ts guarded pattern, plus removeItem for trimming)
// ---------------------------------------------------------------------------

export interface VoiceHistoryStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => unknown;
  removeItem: (name: string) => unknown;
}

function resolveHistoryStorage(storage: VoiceHistoryStorage | undefined): VoiceHistoryStorage {
  if (storage !== undefined) {
    return storage;
  }
  // Reading the `localStorage` global itself can throw when storage is
  // blocked by policy; guard the access, not just the calls on it.
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // Fall through to the in-memory fallback.
  }
  return createMemoryStorage() as unknown as VoiceHistoryStorage;
}

export const VOICE_HISTORY_INDEX_KEY = "t3code:voice-history:v1:index";
export const VOICE_HISTORY_SESSION_KEY_PREFIX = "t3code:voice-history:v1:session:";

const sessionKey = (id: string): string => `${VOICE_HISTORY_SESSION_KEY_PREFIX}${id}`;

// ---------------------------------------------------------------------------
// Entry and session shapes
// ---------------------------------------------------------------------------

/** Upper bound for any single recorded text field; the transcript is a
    record, not a re-implementation of the thread content. */
const MAX_HISTORY_TEXT = 2000;

export type VoiceHistoryEntry =
  | {
      readonly kind: "utterance";
      /** The client-assigned utterance key (`input:in-3`), stable across
          reconnects of one panel lifetime. */
      readonly id: string;
      readonly channel: "input" | "output";
      readonly text: string;
      readonly startedAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      /** Execution outcome: "ok" resolved, "failed" threw. An in-band
          failure (a resolved response carrying an error) is visible through
          `result` fields, never folded into this status. */
      readonly status: "ok" | "failed";
      /** Allowlisted identifiers from the tool input (never other keys). */
      readonly input: {
        readonly environmentId?: string;
        readonly projectId?: string;
        readonly threadId?: string;
        readonly controlId?: string;
        readonly query?: string;
        readonly title?: string;
        readonly task?: string;
        readonly requestId?: string;
      };
      /** Sanitized bounded outcome fields, present when the response carried
          them. This is how an in-band failure (a resolved tool response with
          a stale session or a refused control) stays diagnosable. */
      readonly result?: {
        readonly environmentStatus?: "ok" | "error";
        readonly environmentError?: string;
        readonly acknowledged?: boolean;
        readonly destination?: { readonly environmentId: string; readonly threadId: string };
        readonly requestId?: string;
        readonly commandId?: string;
        readonly messageId?: string;
        readonly dispatchSequence?: number;
        readonly sessionStatus?: string;
        readonly sessionLastError?: string;
        readonly controls?: ReadonlyArray<{
          readonly controlId: string;
          readonly name?: string;
          readonly state?: string;
          readonly message?: string;
        }>;
      };
      readonly startedAt: number;
      readonly endedAt: number;
      readonly error?: string;
    }
  | {
      readonly kind: "command";
      /** The direct command's outcome message (fast path). */
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly kind: "navigation";
      readonly status: "acknowledged" | "failed" | "superseded";
      readonly environmentId?: string;
      readonly threadId?: string;
      readonly error?: string;
      readonly at: number;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly at: number;
    }
  | {
      readonly kind: "mark";
      readonly mark: string;
      readonly detail?: string;
      readonly atMs: number;
      readonly source?: "annotated-input" | "unavailable";
    };

export interface VoiceHistorySession {
  /** Local record id (one voice session per connect), stable in storage. */
  readonly id: string;
  /** The Live session id once minted, when the client exposed one. */
  readonly sessionId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly entries: ReadonlyArray<VoiceHistoryEntry>;
}

export interface VoiceHistorySessionSummary {
  readonly id: string;
  readonly sessionId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly entryCount: number;
}

const capText = (value: string): string =>
  value.length > MAX_HISTORY_TEXT ? `${value.slice(0, MAX_HISTORY_TEXT)}…` : value;

// ---------------------------------------------------------------------------
// Sanitized tool outcome extraction (allowlisted fields only)
// ---------------------------------------------------------------------------

/** Upper bound on recorded control entries per tool outcome. */
const MAX_RECORDED_CONTROLS = 10;

export interface VoiceHistoryToolResult {
  readonly environmentStatus?: "ok" | "error";
  readonly environmentError?: string;
  readonly acknowledged?: boolean;
  readonly destination?: { readonly environmentId: string; readonly threadId: string };
  readonly requestId?: string;
  readonly commandId?: string;
  readonly messageId?: string;
  readonly dispatchSequence?: number;
  readonly sessionStatus?: string;
  readonly sessionLastError?: string;
  readonly controls?: ReadonlyArray<{
    readonly controlId: string;
    readonly name?: string;
    readonly state?: string;
    readonly message?: string;
  }>;
}

const decodeToolResult = (value: unknown): VoiceHistoryToolResult | undefined => {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const environmentStatus =
    record.environmentStatus === "ok" || record.environmentStatus === "error"
      ? record.environmentStatus
      : undefined;
  const controls = Array.isArray(record.controls)
    ? record.controls
        .map((candidate) => {
          const control = asRecord(candidate);
          const controlId = control === undefined ? undefined : asString(control.controlId);
          if (control === undefined || controlId === undefined) {
            return undefined;
          }
          const name = asString(control.name);
          const state = asString(control.state);
          const message = asString(control.message);
          return {
            controlId,
            ...(name !== undefined ? { name: capText(name) } : {}),
            ...(state !== undefined ? { state: capText(state) } : {}),
            ...(message !== undefined ? { message: capText(message) } : {}),
          };
        })
        .filter((control): control is NonNullable<typeof control> => control !== undefined)
        .slice(0, MAX_RECORDED_CONTROLS)
    : undefined;
  const destinationRecord = asRecord(record.destination);
  const destinationEnvironmentId =
    destinationRecord === undefined ? undefined : asString(destinationRecord.environmentId);
  const destinationThreadId =
    destinationRecord === undefined ? undefined : asString(destinationRecord.threadId);
  const string = (key: string): string | undefined => {
    const raw = asString(record[key]);
    return raw === undefined ? undefined : capText(raw);
  };
  const environmentError = string("environmentError");
  const requestId = string("requestId");
  const commandId = string("commandId");
  const messageId = string("messageId");
  const sessionStatus = string("sessionStatus");
  const sessionLastError = string("sessionLastError");
  const dispatchSequence = asNumber(record.dispatchSequence);
  const result: VoiceHistoryToolResult = {
    ...(environmentStatus !== undefined ? { environmentStatus } : {}),
    ...(environmentError !== undefined ? { environmentError } : {}),
    ...(typeof record.acknowledged === "boolean" ? { acknowledged: record.acknowledged } : {}),
    ...(destinationEnvironmentId !== undefined && destinationThreadId !== undefined
      ? { destination: { environmentId: destinationEnvironmentId, threadId: destinationThreadId } }
      : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(dispatchSequence !== undefined ? { dispatchSequence } : {}),
    ...(sessionStatus !== undefined ? { sessionStatus } : {}),
    ...(sessionLastError !== undefined ? { sessionLastError } : {}),
    ...(controls !== undefined ? { controls } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
};

/** Reads the sanitized bounded outcome fields off a resolved tool response.
    Unknown fields are dropped: the recorded result can diagnose whether the
    action landed (dispatch identity, session state, acknowledgment, control
    state) but never carries raw thread contents or credentials. */
function sanitizeToolResult(output: unknown): VoiceHistoryToolResult | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return undefined;
  }
  const environment = asRecord(record.environment);
  const environmentStatus =
    environment !== undefined && (environment.status === "ok" || environment.status === "error")
      ? environment.status
      : undefined;
  const environmentErrorRecord =
    environment === undefined ? undefined : asRecord(environment.error);
  const environmentError =
    environmentErrorRecord === undefined
      ? undefined
      : capText(
          [asString(environmentErrorRecord.code), asString(environmentErrorRecord.message)]
            .filter((part) => part !== undefined)
            .join(": "),
        );
  const destinationRecord = asRecord(record.destination);
  const destinationEnvironmentId =
    destinationRecord === undefined ? undefined : asString(destinationRecord.environmentId);
  const destinationThreadId =
    destinationRecord === undefined ? undefined : asString(destinationRecord.threadId);
  const session = asRecord(record.session);
  const sessionStatus = session === undefined ? undefined : asString(session.status);
  const rawSessionLastError = session === undefined ? undefined : (session.lastError as unknown);
  const sessionLastError =
    typeof rawSessionLastError === "string" ? capText(rawSessionLastError) : undefined;
  const asControls = (value: unknown): VoiceHistoryToolResult["controls"] => {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const controls = list
      .map((candidate) => {
        const control = asRecord(candidate);
        const controlId = control === undefined ? undefined : asString(control.controlId);
        if (control === undefined || controlId === undefined) {
          return undefined;
        }
        const name = asString(control.name);
        const state = asString(control.state);
        const message = asString(control.message);
        return {
          controlId,
          ...(name !== undefined ? { name: capText(name) } : {}),
          ...(state !== undefined ? { state: capText(state) } : {}),
          ...(message !== undefined ? { message: capText(message) } : {}),
        };
      })
      .filter((control): control is NonNullable<typeof control> => control !== undefined)
      .slice(0, MAX_RECORDED_CONTROLS);
    return controls.length > 0 ? controls : undefined;
  };
  const controls =
    record.controls !== undefined
      ? asControls(record.controls)
      : // A clickControl result is flat at top level (the real contract
        // shape: {controlId, name?, role?, state?, message?}), both for an
        // activation and for a refusal; synthesize its single control entry
        // so the outcome (state, message) survives sanitization.
        (asControls(record.control) ??
        (record.controlId === undefined
          ? undefined
          : asControls([
              {
                controlId: record.controlId,
                ...(record.name !== undefined ? { name: record.name } : {}),
                ...(record.state !== undefined ? { state: record.state } : {}),
                ...(record.message !== undefined ? { message: record.message } : {}),
              },
            ])));
  const string = (key: string): string | undefined => {
    const raw = asString(record[key]);
    return raw === undefined ? undefined : capText(raw);
  };
  const requestId = string("requestId");
  const commandId = string("commandId");
  const messageId = string("messageId");
  const dispatchSequence = asNumber(record.dispatchSequence);
  const result: VoiceHistoryToolResult = {
    ...(environmentStatus !== undefined ? { environmentStatus } : {}),
    ...(environmentError !== undefined && environmentError !== "" ? { environmentError } : {}),
    ...(typeof record.acknowledged === "boolean" ? { acknowledged: record.acknowledged } : {}),
    ...(destinationEnvironmentId !== undefined && destinationThreadId !== undefined
      ? { destination: { environmentId: destinationEnvironmentId, threadId: destinationThreadId } }
      : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(dispatchSequence !== undefined ? { dispatchSequence } : {}),
    ...(sessionStatus !== undefined ? { sessionStatus: capText(sessionStatus) } : {}),
    ...(sessionLastError !== undefined ? { sessionLastError } : {}),
    ...(controls !== undefined ? { controls } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Tolerant decode (the decodeDeliveryRecord pattern)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const decodeUtteranceEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const id = asString(record.id);
  const channel =
    record.channel === "input" || record.channel === "output" ? record.channel : undefined;
  const text = asString(record.text);
  const startedAt = asNumber(record.startedAt);
  const updatedAt = asNumber(record.updatedAt);
  if (id === undefined || channel === undefined || text === undefined || startedAt === undefined) {
    return undefined;
  }
  return {
    kind: "utterance",
    id,
    channel,
    text,
    startedAt,
    ...(updatedAt !== undefined ? { updatedAt } : { updatedAt: startedAt }),
  };
};

const decodeToolEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const name = asString(record.name);
  const status = record.status === "ok" || record.status === "failed" ? record.status : undefined;
  const startedAt = asNumber(record.startedAt);
  const endedAt = asNumber(record.endedAt);
  if (
    name === undefined ||
    status === undefined ||
    startedAt === undefined ||
    endedAt === undefined
  ) {
    return undefined;
  }
  const inputRecord = asRecord(record.input);
  const pick = (key: string): string | undefined => {
    const value = inputRecord === undefined ? undefined : asString(inputRecord[key]);
    return value === undefined ? undefined : capText(value);
  };
  const environmentId = pick("environmentId");
  const projectId = pick("projectId");
  const threadId = pick("threadId");
  const controlId = pick("controlId");
  const query = pick("query");
  const title = pick("title");
  const task = pick("task");
  const requestId = pick("requestId");
  const input = {
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(controlId !== undefined ? { controlId } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
  const error = asString(record.error);
  const result = decodeToolResult(record.result);
  return {
    kind: "tool",
    name,
    status,
    input,
    ...(result !== undefined ? { result } : {}),
    startedAt,
    endedAt,
    ...(error !== undefined ? { error } : {}),
  };
};

const decodeCommandEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const text = asString(record.text);
  const at = asNumber(record.at);
  return text === undefined || at === undefined
    ? undefined
    : { kind: "command", text: capText(text), at };
};

const decodeNavigationEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const status =
    record.status === "acknowledged" || record.status === "failed" || record.status === "superseded"
      ? record.status
      : undefined;
  const at = asNumber(record.at);
  if (status === undefined || at === undefined) {
    return undefined;
  }
  const error = asString(record.error);
  const environmentId = asString(record.environmentId);
  const threadId = asString(record.threadId);
  return {
    kind: "navigation",
    status,
    ...(environmentId !== undefined ? { environmentId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(error !== undefined ? { error } : {}),
    at,
  };
};

const decodeErrorEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const code = asString(record.code);
  const message = asString(record.message);
  const at = asNumber(record.at);
  return code === undefined || message === undefined || at === undefined
    ? undefined
    : { kind: "error", code, message, at };
};

const decodeMarkEntry = (record: Record<string, unknown>): VoiceHistoryEntry | undefined => {
  const mark = asString(record.mark);
  const atMs = asNumber(record.atMs);
  if (mark === undefined || atMs === undefined) {
    return undefined;
  }
  const detail = asString(record.detail);
  const source =
    record.source === "annotated-input" || record.source === "unavailable"
      ? record.source
      : undefined;
  return {
    kind: "mark",
    mark,
    ...(detail !== undefined ? { detail } : {}),
    atMs,
    ...(source !== undefined ? { source } : {}),
  };
};

const ENTRY_DECODERS: Array<(record: Record<string, unknown>) => VoiceHistoryEntry | undefined> = [
  decodeUtteranceEntry,
  decodeToolEntry,
  decodeCommandEntry,
  decodeNavigationEntry,
  decodeErrorEntry,
  decodeMarkEntry,
];

const decodeEntry = (value: unknown): VoiceHistoryEntry | undefined => {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  for (const decode of ENTRY_DECODERS) {
    const entry = decode(record);
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
};

const decodeEntries = (value: unknown): VoiceHistoryEntry[] =>
  Array.isArray(value)
    ? value.map(decodeEntry).filter((entry): entry is VoiceHistoryEntry => entry !== undefined)
    : [];

/** Tolerant session decode: a malformed payload decodes to `undefined`, a
    partially malformed entry list keeps the valid entries. */
function decodeVoiceHistorySession(value: unknown): VoiceHistorySession | undefined {
  const record = asRecord(value);
  const id = record === undefined ? undefined : asString(record.id);
  const startedAt = record === undefined ? undefined : asNumber(record.startedAt);
  if (record === undefined || id === undefined || startedAt === undefined) {
    return undefined;
  }
  const sessionId = asString(record.sessionId);
  const endedAt = asNumber(record.endedAt);
  return {
    id,
    ...(sessionId !== undefined ? { sessionId } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    entries: decodeEntries(record.entries),
  };
}

const decodeSummary = (value: unknown): VoiceHistorySessionSummary | undefined => {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const id = asString(record.id);
  const startedAt = asNumber(record.startedAt);
  const entryCount = asNumber(record.entryCount);
  if (id === undefined || startedAt === undefined || entryCount === undefined) {
    return undefined;
  }
  const sessionId = asString(record.sessionId);
  const endedAt = asNumber(record.endedAt);
  return {
    id,
    ...(sessionId !== undefined ? { sessionId } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    entryCount,
  };
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface VoiceHistoryStore {
  listSessions(): VoiceHistorySessionSummary[];
  readSession(id: string): VoiceHistorySession | undefined;
  writeSession(session: VoiceHistorySession): void;
  removeSession(id: string): void;
  clearAll(): void;
}

export interface VoiceHistoryStoreOptions {
  readonly storage?: VoiceHistoryStorage;
  /** Oldest sessions beyond this count are deleted. */
  readonly maxSessions?: number;
}

export function createVoiceHistoryStore(options: VoiceHistoryStoreOptions = {}): VoiceHistoryStore {
  const store = resolveHistoryStorage(options.storage);
  const maxSessions = options.maxSessions ?? 20;

  const readIndex = (): VoiceHistorySessionSummary[] => {
    let raw: string | null;
    try {
      raw = store.getItem(VOICE_HISTORY_INDEX_KEY);
    } catch {
      return [];
    }
    if (raw === null) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map(decodeSummary)
        .filter((summary): summary is VoiceHistorySessionSummary => summary !== undefined);
    } catch {
      return [];
    }
  };

  const writeIndex = (summaries: ReadonlyArray<VoiceHistorySessionSummary>): void => {
    store.setItem(VOICE_HISTORY_INDEX_KEY, JSON.stringify(summaries));
  };

  const store_: VoiceHistoryStore = {
    listSessions() {
      return readIndex();
    },
    readSession(id) {
      let raw: string | null;
      try {
        raw = store.getItem(sessionKey(id));
      } catch {
        return undefined;
      }
      if (raw === null) {
        return undefined;
      }
      try {
        const session = decodeVoiceHistorySession(JSON.parse(raw));
        return session !== undefined && session.id === id ? session : undefined;
      } catch {
        return undefined;
      }
    },
    writeSession(session) {
      store.setItem(sessionKey(session.id), JSON.stringify(session));
      const others = readIndex().filter((summary) => summary.id !== session.id);
      const updated: VoiceHistorySessionSummary = {
        id: session.id,
        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
        startedAt: session.startedAt,
        ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
        entryCount: session.entries.length,
      };
      const next = [...others, updated].sort((a, b) => a.startedAt - b.startedAt);
      while (next.length > maxSessions) {
        const oldest = next.shift();
        if (oldest !== undefined) {
          store_.removeSession(oldest.id);
        }
      }
      writeIndex(next);
    },
    removeSession(id) {
      try {
        store.removeItem(sessionKey(id));
      } catch {
        // Removal failure (blocked storage) must not break the caller; the
        // index rewrite below still drops the entry from the listing.
      }
      writeIndex(readIndex().filter((summary) => summary.id !== id));
    },
    clearAll() {
      for (const summary of readIndex()) {
        try {
          store.removeItem(sessionKey(summary.id));
        } catch {
          // Same tolerance as removeSession.
        }
      }
      try {
        store.removeItem(VOICE_HISTORY_INDEX_KEY);
      } catch {
        // Ignore.
      }
    },
  };
  return store_;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface VoiceHistoryRecorder {
  /** Opens a new session record at connect; an still-open previous session
      is ended first (a reconnect never merges sessions). */
  beginSession(): void;
  /** Folds one live client event into the open session. Safe without an
      open session (events before begin or after end are dropped). */
  record(event: VoiceLiveClientEvent): void;
  /** Records a navigation outcome with its target identity. */
  recordNavigation(result: VoiceNavigationResult, destination: VoiceNavigationDestination): void;
  /** Records a tool call around its execution; failures are recorded and
      rethrown. Tool names arrive with the broker's `voice.` prefix. */
  recordToolExecution<R>(name: string, input: unknown, run: () => Promise<R>): Promise<R>;
  /** Closes the open session (idempotent) and persists the final state. */
  endSession(): void;
  /** Persists in-memory buffered state now (pagehide/reload). Safe with no
      open session. */
  flush(): void;
  /** Deletes every saved session and drops the open in-memory record. */
  clear(): void;
  listSessions(): VoiceHistorySessionSummary[];
  /** Cached listing for useSyncExternalStore: a stable array identity that
      refreshes only when a recorder action changes the index. */
  getSessionsSnapshot(): VoiceHistorySessionSummary[];
  subscribe(listener: () => void): () => void;
  readSession(id: string): VoiceHistorySession | undefined;
  deleteSession(id: string): void;
}

export interface VoiceHistoryRecorderOptions {
  readonly store?: VoiceHistoryStore;
  /** Resolves the Live session id when the current client has minted one. */
  readonly sessionIdentity?: () => string | undefined;
  readonly now?: () => number;
  readonly maxEntriesPerSession?: number;
}

export function createVoiceHistoryRecorder(
  options: VoiceHistoryRecorderOptions = {},
): VoiceHistoryRecorder {
  const store = options.store ?? createVoiceHistoryStore();
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntriesPerSession ?? 500;

  let current:
    | { id: string; startedAt: number; endedAt?: number; entries: VoiceHistoryEntry[] }
    | undefined;
  let sessionSeq = 0;
  // Cached listing snapshot for useSyncExternalStore consumers: identity is
  // stable between index changes, and change listeners fire on every
  // recorder action that could have moved the index.
  let snapshot: VoiceHistorySessionSummary[] | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    snapshot = undefined;
    for (const listener of listeners) {
      listener();
    }
  };

  const identity = (): string | undefined => {
    try {
      return options.sessionIdentity?.();
    } catch {
      return undefined;
    }
  };

  const persist = (): void => {
    if (current === undefined) {
      return;
    }
    const sessionId = identity();
    store.writeSession({
      id: current.id,
      ...(sessionId !== undefined ? { sessionId } : {}),
      startedAt: current.startedAt,
      ...(current.endedAt !== undefined ? { endedAt: current.endedAt } : {}),
      entries: current.entries,
    });
    notify();
  };

  /** Appends an entry; a full entry persists at this boundary (transcript
      deltas fold in memory instead, see `record`). */
  const appendEntry = (entry: VoiceHistoryEntry): void => {
    if (current === undefined) {
      return;
    }
    current.entries.push(entry);
    if (current.entries.length > maxEntries) {
      current.entries.splice(0, current.entries.length - maxEntries);
    }
    persist();
  };

  const endSession = (): void => {
    if (current === undefined || current.endedAt !== undefined) {
      return;
    }
    current.endedAt = now();
    persist();
    current = undefined;
  };

  const recorder: VoiceHistoryRecorder = {
    beginSession() {
      endSession();
      sessionSeq += 1;
      current = { id: `voice-${now()}-${sessionSeq}`, startedAt: now(), entries: [] };
      persist();
    },
    record(event) {
      if (current === undefined) {
        return;
      }
      switch (event.type) {
        case "transcript": {
          // Deltas fold into the matching utterance in memory; storage is
          // touched only when a new utterance opens (persisting the closed
          // previous one), never per delta.
          const key = `${event.channel}:${event.utterance}`;
          const last = current.entries[current.entries.length - 1];
          if (last !== undefined && last.kind === "utterance" && last.id === key) {
            current.entries[current.entries.length - 1] = {
              ...last,
              text: capText(last.text + event.delta),
              updatedAt: now(),
            };
            return;
          }
          appendEntry({
            kind: "utterance",
            id: key,
            channel: event.channel,
            text: capText(event.delta),
            startedAt: now(),
            updatedAt: now(),
          });
          return;
        }
        case "command_result":
          appendEntry({ kind: "command", text: capText(event.text), at: now() });
          return;
        case "error":
          appendEntry({
            kind: "error",
            code: event.error.code,
            message: capText(event.error.message),
            at: now(),
          });
          return;
        case "timing":
          appendEntry({
            kind: "mark",
            mark: event.record.mark,
            ...(event.record.detail !== undefined ? { detail: event.record.detail } : {}),
            atMs: event.record.atMs,
            ...(event.record.source !== undefined ? { source: event.record.source } : {}),
          });
          return;
        case "state":
          if (event.state === "closed") {
            endSession();
          } else {
            // The Live session id becomes available around the live
            // transition; persist it onto the open record.
            persist();
          }
          return;
        default:
          return;
      }
    },
    recordNavigation(result, destination) {
      const error = result.status === "failed" ? result.error : undefined;
      appendEntry({
        kind: "navigation",
        status: result.status,
        environmentId: destination.environmentId,
        threadId: destination.threadId,
        ...(error !== undefined ? { error: capText(error.message) } : {}),
        at: now(),
      });
    },
    async recordToolExecution(name, input, run) {
      const bare = name.startsWith("voice.") ? name.slice("voice.".length) : name;
      const startedAt = now();
      const inputRecord = asRecord(input) ?? {};
      const pick = (key: string): string | undefined => {
        const value = asString(inputRecord[key]);
        return value === undefined ? undefined : capText(value);
      };
      const environmentId = pick("environmentId");
      const projectId = pick("projectId");
      const threadId = pick("threadId");
      const controlId = pick("controlId");
      const query = pick("query");
      const title = pick("title");
      const task = pick("task");
      const requestId = pick("requestId");
      const summary = {
        ...(environmentId !== undefined ? { environmentId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(controlId !== undefined ? { controlId } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(task !== undefined ? { task } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      };
      try {
        const output = await run();
        const result = sanitizeToolResult(output);
        appendEntry({
          kind: "tool",
          name: bare,
          status: "ok",
          input: summary,
          ...(result !== undefined ? { result } : {}),
          startedAt,
          endedAt: now(),
        });
        return output;
      } catch (cause) {
        appendEntry({
          kind: "tool",
          name: bare,
          status: "failed",
          input: summary,
          startedAt,
          endedAt: now(),
          error: capText(cause instanceof Error ? cause.message : String(cause)),
        });
        throw cause;
      }
    },
    endSession,
    flush: persist,
    clear() {
      current = undefined;
      store.clearAll();
      notify();
    },
    listSessions: () => store.listSessions(),
    getSessionsSnapshot: () => (snapshot ??= store.listSessions()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readSession: (id) => store.readSession(id),
    deleteSession: (id) => {
      store.removeSession(id);
      notify();
    },
  };
  return recorder;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The export payload: every saved session with full entries, oldest first.
    Accepts the store or the recorder (both expose list and read). */
export function exportVoiceHistory(
  source: Pick<VoiceHistoryStore, "listSessions" | "readSession">,
  now: () => number = Date.now,
): string {
  const sessions = source
    .listSessions()
    .map((summary) => source.readSession(summary.id))
    .filter((session): session is VoiceHistorySession => session !== undefined);
  return JSON.stringify(
    {
      kind: "t3code-voice-history",
      version: 1,
      exportedAt: now(),
      sessions,
    },
    null,
    2,
  );
}
