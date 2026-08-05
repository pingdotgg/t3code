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
import type { ActiveTurnMessageBehavior } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const WEB_THREAD_OUTBOX_STORAGE_KEY = "t3code:thread-outbox:v1";
const WEB_THREAD_OUTBOX_STORAGE_VERSION = 1;

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
  readonly createdAt: string;
}

const PersistedWebThreadOutboxState = Schema.Struct({
  queuesByThreadKey: Schema.Record(Schema.String, Schema.Array(QueuedWebThreadMessageSchema)),
});
const decodePersistedState = Schema.decodeUnknownSync(PersistedWebThreadOutboxState);

export function webThreadOutboxKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function readQueue(
  queues: Record<string, ReadonlyArray<QueuedWebThreadMessage>>,
  threadKey: string,
): ReadonlyArray<QueuedWebThreadMessage> {
  return Object.hasOwn(queues, threadKey) ? (queues[threadKey] ?? []) : [];
}

function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Sandboxed browsers can reject access to the localStorage property itself.
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseOutboxStorage, durable: storageIsDurable } = resolveBaseStorage();

function persistQueues(queues: Record<string, ReadonlyArray<QueuedWebThreadMessage>>): {
  written: boolean;
  durable: boolean;
} {
  try {
    baseOutboxStorage.setItem(
      WEB_THREAD_OUTBOX_STORAGE_KEY,
      JSON.stringify({
        version: WEB_THREAD_OUTBOX_STORAGE_VERSION,
        state: { queuesByThreadKey: queues },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[THREAD-OUTBOX] Could not persist queued messages.", error);
    return { written: false, durable: false };
  }
}

function readPersistedQueues(): Record<string, ReadonlyArray<QueuedWebThreadMessage>> | null {
  try {
    const raw = baseOutboxStorage.getItem(WEB_THREAD_OUTBOX_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    return state ? decodePersistedState(state).queuesByThreadKey : null;
  } catch {
    return null;
  }
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
    const threadKey = webThreadOutboxKey(message.environmentId, message.threadId);
    const queues = get().queuesByThreadKey;
    const queue = readQueue(queues, threadKey);
    const nextQueue = [
      ...queue.filter((candidate) => candidate.messageId !== message.messageId),
      message,
    ];
    const next = { ...queues, [threadKey]: nextQueue };
    const persisted = persistQueues(next);
    // Even when browser storage is blocked or full, retain the message for the
    // current session. The caller reports that it is not reload-safe.
    set({ queuesByThreadKey: next });
    return { durable: persisted.written && persisted.durable };
  },
  remove: (message) => {
    const threadKey = webThreadOutboxKey(message.environmentId, message.threadId);
    const queues = get().queuesByThreadKey;
    const nextQueue = readQueue(queues, threadKey).filter(
      (candidate) => candidate.messageId !== message.messageId,
    );
    const next = { ...queues };
    if (nextQueue.length === 0) {
      delete next[threadKey];
    } else {
      next[threadKey] = nextQueue;
    }
    const persisted = persistQueues(next);
    const pausedMessageIds = { ...get().pausedMessageIds };
    delete pausedMessageIds[message.messageId];
    // The command id is stable, so a removal that fails to persist can only
    // cause an idempotent acknowledgement after reload, never a second turn.
    set({ queuesByThreadKey: next, pausedMessageIds });
    return { durable: persisted.written && persisted.durable };
  },
  pause: (messageId) => {
    set((state) => ({
      pausedMessageIds: { ...state.pausedMessageIds, [messageId]: true },
    }));
  },
  retry: (messageId) => {
    set((state) => {
      if (!state.pausedMessageIds[messageId]) {
        return state;
      }
      const pausedMessageIds = { ...state.pausedMessageIds };
      delete pausedMessageIds[messageId];
      return { pausedMessageIds };
    });
  },
}));

export const EMPTY_WEB_THREAD_OUTBOX_QUEUE: ReadonlyArray<QueuedWebThreadMessage> = [];

{
  const persisted = readPersistedQueues();
  if (persisted) {
    useWebThreadOutboxStore.setState({ queuesByThreadKey: persisted });
  }
}

const dispatchingMessageIds = new Set<MessageId>();

export function beginWebThreadOutboxDispatch(messageId: MessageId): boolean {
  if (dispatchingMessageIds.has(messageId)) {
    return false;
  }
  dispatchingMessageIds.add(messageId);
  return true;
}

export function finishWebThreadOutboxDispatch(messageId: MessageId): void {
  dispatchingMessageIds.delete(messageId);
}

export function shouldDrainWebThreadOutbox(input: {
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly paused: boolean;
}): boolean {
  return (
    input.phase === "ready" &&
    !input.isSendBusy &&
    !input.isConnecting &&
    !input.environmentUnavailable &&
    !input.paused
  );
}

export function shouldQueueWebThreadMessage(input: {
  readonly activeTurnMessageBehavior: ActiveTurnMessageBehavior;
  readonly hasQueuedMessages: boolean;
  readonly isSendBusy: boolean;
  readonly isServerThread: boolean;
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
}): boolean {
  return (
    input.isServerThread &&
    (input.hasQueuedMessages ||
      (input.activeTurnMessageBehavior === "queue" &&
        (input.phase === "running" || input.isSendBusy)))
  );
}

export function writeWebThreadOutboxStorageForTest(raw: string): void {
  baseOutboxStorage.setItem(WEB_THREAD_OUTBOX_STORAGE_KEY, raw);
  useWebThreadOutboxStore.setState({
    queuesByThreadKey: readPersistedQueues() ?? {},
    pausedMessageIds: {},
  });
  dispatchingMessageIds.clear();
}
