import {
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import {
  ActiveTurnMessageBehavior,
  type ActiveTurnMessageBehavior as ActiveTurnMessageBehaviorType,
} from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";

export const WEB_THREAD_OUTBOX_STORAGE_KEY = "t3code:thread-outbox:v1";
export const WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX = "t3code:thread-outbox:v2:";
const WEB_THREAD_OUTBOX_STORAGE_VERSION = 2;

interface EnumerableStorage {
  readonly length: number;
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
  key(index: number): string | null;
}

function createEnumerableMemoryStorage(): EnumerableStorage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    getItem: (name) => entries.get(name) ?? null,
    setItem: (name, value) => entries.set(name, value),
    removeItem: (name) => entries.delete(name),
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

const QueuedWebImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

const QueuedWebThreadMessageSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(QueuedWebImageAttachment),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  activeTurnMessageBehavior: Schema.optional(ActiveTurnMessageBehavior),
  createdAt: Schema.String,
});

export interface QueuedWebThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
  readonly createdAt: string;
}

const PersistedWebThreadOutboxState = Schema.Struct({
  queuesByThreadKey: Schema.Record(Schema.String, Schema.Array(QueuedWebThreadMessageSchema)),
});
const PersistedWebThreadOutboxEntry = Schema.Struct({
  message: QueuedWebThreadMessageSchema,
  paused: Schema.Boolean,
});
const decodePersistedState = Schema.decodeUnknownSync(PersistedWebThreadOutboxState);
const decodePersistedEntry = Schema.decodeUnknownSync(PersistedWebThreadOutboxEntry);

function normalizeMessage(
  message: typeof QueuedWebThreadMessageSchema.Type,
): QueuedWebThreadMessage {
  return {
    ...message,
    activeTurnMessageBehavior: message.activeTurnMessageBehavior ?? "queue",
  };
}

export function webThreadOutboxKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function storageKey(messageId: MessageId): string {
  return `${WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX}${encodeURIComponent(String(messageId))}`;
}

function groupMessages(
  messages: Iterable<QueuedWebThreadMessage>,
): Record<string, ReadonlyArray<QueuedWebThreadMessage>> {
  const byId = new Map<MessageId, QueuedWebThreadMessage>();
  for (const message of messages) {
    byId.set(message.messageId, message);
  }
  const grouped: Record<string, Array<QueuedWebThreadMessage>> = {};
  for (const message of byId.values()) {
    const threadKey = webThreadOutboxKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        String(left.messageId).localeCompare(String(right.messageId)),
    );
  }
  return grouped;
}

function flattenQueues(
  queues: Record<string, ReadonlyArray<QueuedWebThreadMessage>>,
): ReadonlyArray<QueuedWebThreadMessage> {
  return Object.values(queues).flat();
}

function resolveBaseStorage(): { storage: EnumerableStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Sandboxed browsers can reject access to the localStorage property itself.
  }
  return { storage: createEnumerableMemoryStorage(), durable: false };
}

const { storage: baseOutboxStorage, durable: storageIsDurable } = resolveBaseStorage();

interface PersistedSnapshot {
  readonly queuesByThreadKey: Record<string, ReadonlyArray<QueuedWebThreadMessage>>;
  readonly pausedMessageIds: Readonly<Record<MessageId, true>>;
}

function readPersistedSnapshot(): PersistedSnapshot {
  const messages: QueuedWebThreadMessage[] = [];
  const pausedMessageIds: Record<MessageId, true> = {};
  for (let index = 0; index < baseOutboxStorage.length; index += 1) {
    const key = baseOutboxStorage.key(index);
    if (!key?.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX)) {
      continue;
    }
    try {
      const raw = baseOutboxStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      const state = (parsed as { state?: unknown } | null)?.state;
      if (!state) continue;
      const entry = decodePersistedEntry(state);
      const message = normalizeMessage(entry.message);
      messages.push(message);
      if (entry.paused) pausedMessageIds[message.messageId] = true;
    } catch {
      // A corrupt per-message entry must not hide the other queued messages.
    }
  }

  // Read the old full-key snapshot until startup migration removes it.
  try {
    const legacyRaw = baseOutboxStorage.getItem(WEB_THREAD_OUTBOX_STORAGE_KEY);
    if (legacyRaw) {
      const parsed: unknown = JSON.parse(legacyRaw);
      const state = (parsed as { state?: unknown } | null)?.state;
      if (state) {
        for (const queue of Object.values(decodePersistedState(state).queuesByThreadKey)) {
          for (const message of queue) messages.push(normalizeMessage(message));
        }
      }
    }
  } catch {}
  return { queuesByThreadKey: groupMessages(messages), pausedMessageIds };
}

function persistEntry(message: QueuedWebThreadMessage, paused: boolean): boolean {
  try {
    baseOutboxStorage.setItem(
      storageKey(message.messageId),
      JSON.stringify({
        version: WEB_THREAD_OUTBOX_STORAGE_VERSION,
        state: { message, paused },
      }),
    );
    return true;
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not persist queued message.", error);
    return false;
  }
}

function removePersistedEntry(messageId: MessageId): boolean {
  try {
    baseOutboxStorage.removeItem(storageKey(messageId));
    return true;
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not remove queued message.", error);
    return false;
  }
}

function mergedSnapshot(
  state: Pick<WebThreadOutboxState, "queuesByThreadKey" | "pausedMessageIds">,
) {
  const persisted = readPersistedSnapshot();
  const messages = [
    ...flattenQueues(state.queuesByThreadKey),
    ...flattenQueues(persisted.queuesByThreadKey),
  ];
  return {
    queuesByThreadKey: groupMessages(messages),
    pausedMessageIds: { ...state.pausedMessageIds, ...persisted.pausedMessageIds },
  };
}

interface WebThreadOutboxState {
  readonly queuesByThreadKey: Record<string, ReadonlyArray<QueuedWebThreadMessage>>;
  readonly pausedMessageIds: Readonly<Record<MessageId, true>>;
  readonly enqueue: (message: QueuedWebThreadMessage) => { durable: boolean };
  readonly remove: (message: QueuedWebThreadMessage) => { durable: boolean };
  readonly pause: (messageId: MessageId) => void;
  readonly retry: (messageId: MessageId) => void;
}

export const useWebThreadOutboxStore = create<WebThreadOutboxState>()((set, get) => ({
  queuesByThreadKey: {},
  pausedMessageIds: {},
  enqueue: (message) => {
    const snapshot = mergedSnapshot(get());
    const queuesByThreadKey = groupMessages([
      ...flattenQueues(snapshot.queuesByThreadKey).filter(
        (candidate) => candidate.messageId !== message.messageId,
      ),
      message,
    ]);
    const written = persistEntry(message, false);
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[message.messageId];
    set({ queuesByThreadKey, pausedMessageIds });
    return { durable: written && storageIsDurable };
  },
  remove: (message) => {
    const removed = removePersistedEntry(message.messageId);
    const snapshot = mergedSnapshot(get());
    const queuesByThreadKey = groupMessages(
      flattenQueues(snapshot.queuesByThreadKey).filter(
        (candidate) => candidate.messageId !== message.messageId,
      ),
    );
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[message.messageId];
    set({ queuesByThreadKey, pausedMessageIds });
    return { durable: removed && storageIsDurable };
  },
  pause: (messageId) => {
    const snapshot = mergedSnapshot(get());
    const message = flattenQueues(snapshot.queuesByThreadKey).find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message) return;
    persistEntry(message, true);
    set({
      ...snapshot,
      pausedMessageIds: { ...snapshot.pausedMessageIds, [messageId]: true },
    });
  },
  retry: (messageId) => {
    const snapshot = mergedSnapshot(get());
    const message = flattenQueues(snapshot.queuesByThreadKey).find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message || !snapshot.pausedMessageIds[messageId]) return;
    persistEntry(message, false);
    const pausedMessageIds = { ...snapshot.pausedMessageIds };
    delete pausedMessageIds[messageId];
    set({ queuesByThreadKey: snapshot.queuesByThreadKey, pausedMessageIds });
  },
}));

export const EMPTY_WEB_THREAD_OUTBOX_QUEUE: ReadonlyArray<QueuedWebThreadMessage> = [];

{
  const initial = readPersistedSnapshot();
  useWebThreadOutboxStore.setState(initial);
  try {
    const legacyMessages = flattenQueues(initial.queuesByThreadKey).filter(
      (message) => baseOutboxStorage.getItem(storageKey(message.messageId)) === null,
    );
    if (legacyMessages.every((message) => persistEntry(message, false))) {
      baseOutboxStorage.removeItem(WEB_THREAD_OUTBOX_STORAGE_KEY);
    }
  } catch {
    // Sandboxed browsers can expose localStorage while rejecting method calls.
  }
}

if (storageIsDurable && typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key !== null &&
      event.key !== WEB_THREAD_OUTBOX_STORAGE_KEY &&
      !event.key.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX)
    ) {
      return;
    }
    useWebThreadOutboxStore.setState(readPersistedSnapshot());
  });
}

const dispatchingMessageIds = new Set<MessageId>();

export function beginWebThreadOutboxDispatch(messageId: MessageId): boolean {
  if (dispatchingMessageIds.has(messageId)) return false;
  dispatchingMessageIds.add(messageId);
  return true;
}

export function finishWebThreadOutboxDispatch(messageId: MessageId): void {
  dispatchingMessageIds.delete(messageId);
}

export function shouldDrainWebThreadOutbox(input: {
  readonly sessionStatus:
    | "error"
    | "idle"
    | "interrupted"
    | "ready"
    | "running"
    | "starting"
    | "stopped"
    | null;
  readonly environmentConnected: boolean;
  readonly paused: boolean;
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
}): boolean {
  if (!input.environmentConnected || input.paused || input.sessionStatus === "starting") {
    return false;
  }
  return (
    input.sessionStatus === null ||
    input.sessionStatus === "ready" ||
    (input.sessionStatus === "running" && input.activeTurnMessageBehavior === "steer")
  );
}

export function shouldQueueWebThreadMessage(input: {
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehaviorType;
  readonly hasQueuedMessages: boolean;
  readonly isSendBusy: boolean;
  readonly isServerThread: boolean;
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly threadStarting: boolean;
}): boolean {
  return (
    input.isServerThread &&
    (input.hasQueuedMessages ||
      input.threadStarting ||
      (input.activeTurnMessageBehavior === "queue" &&
        (input.phase === "running" || input.isSendBusy)))
  );
}

function clearStorageForTest(): void {
  const keys: string[] = [];
  for (let index = 0; index < baseOutboxStorage.length; index += 1) {
    const key = baseOutboxStorage.key(index);
    if (
      key === WEB_THREAD_OUTBOX_STORAGE_KEY ||
      key?.startsWith(WEB_THREAD_OUTBOX_ENTRY_STORAGE_PREFIX)
    ) {
      keys.push(key);
    }
  }
  for (const key of keys) baseOutboxStorage.removeItem(key);
}

export function writeWebThreadOutboxStorageForTest(raw: string): void {
  clearStorageForTest();
  if (raw) baseOutboxStorage.setItem(WEB_THREAD_OUTBOX_STORAGE_KEY, raw);
  useWebThreadOutboxStore.setState(readPersistedSnapshot());
  dispatchingMessageIds.clear();
}

export function writeWebThreadOutboxEntryForTest(
  message: QueuedWebThreadMessage,
  options?: { readonly paused?: boolean; readonly syncStore?: boolean },
): void {
  persistEntry(message, options?.paused ?? false);
  if (options?.syncStore !== false) {
    useWebThreadOutboxStore.setState(readPersistedSnapshot());
  }
}
