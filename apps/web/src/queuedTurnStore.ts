import {
  type ModelSelection,
  ModelSelection as ModelSelectionSchema,
  type ProviderInteractionMode,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  type RuntimeMode,
  RuntimeMode as RuntimeModeSchema,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  PersistedComposerImageAttachment as PersistedComposerImageAttachmentSchema,
} from "./composerDraftStore";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import type { TerminalContextDraft } from "./lib/terminalContext";

const QUEUED_TURN_STORE_STORAGE_KEY = "t3code:queued-turn-store:v2";
const QUEUED_TURN_STORE_STORAGE_VERSION = 1;
const QUEUED_TURN_PERSIST_DEBOUNCE_MS = 300;

const queuedTurnDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  QUEUED_TURN_PERSIST_DEBOUNCE_MS,
);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    queuedTurnDebouncedStorage.flush();
  });
}

const PersistedQueuedTurnTerminalContext = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.String,
});

type PersistedQueuedTurnTerminalContext = typeof PersistedQueuedTurnTerminalContext.Type;

const PersistedQueuedTurnDraft = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachmentSchema),
  terminalContexts: Schema.Array(PersistedQueuedTurnTerminalContext),
  modelSelection: ModelSelectionSchema,
  promptEffort: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeModeSchema,
  interactionMode: ProviderInteractionModeSchema,
});

type PersistedQueuedTurnDraft = typeof PersistedQueuedTurnDraft.Type;

const PersistedThreadQueue = Schema.Struct({
  items: Schema.Array(PersistedQueuedTurnDraft),
  updatedAt: Schema.NullOr(Schema.String),
});

type PersistedThreadQueue = typeof PersistedThreadQueue.Type;

interface PersistedQueueState {
  threadsByThreadKey: Record<string, PersistedThreadQueue>;
}

export interface QueuedTurnDraft {
  id: string;
  text: string;
  createdAt: string;
  images: ComposerImageAttachment[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelection: ModelSelection;
  promptEffort: string | null;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

export interface ThreadQueueState {
  items: QueuedTurnDraft[];
  updatedAt: string | null;
}

interface QueuedTurnStoreState {
  threadsByThreadKey: Record<string, ThreadQueueState>;
}

export interface QueuedTurnStore extends QueuedTurnStoreState {
  getQueue: (threadRef: ScopedThreadRef) => readonly QueuedTurnDraft[];
  enqueue: (threadRef: ScopedThreadRef, draft: QueuedTurnDraft) => void;
  prepend: (threadRef: ScopedThreadRef, draft: QueuedTurnDraft) => void;
  move: (threadRef: ScopedThreadRef, queuedTurnId: string, nextIndex: number) => void;
  consume: (threadRef: ScopedThreadRef, queuedTurnId: string) => void;
  remove: (threadRef: ScopedThreadRef, queuedTurnId: string) => void;
  replaceText: (threadRef: ScopedThreadRef, queuedTurnId: string, text: string) => void;
  clearThread: (threadRef: ScopedThreadRef) => void;
}

const EMPTY_QUEUE: QueuedTurnDraft[] = [];
Object.freeze(EMPTY_QUEUE);

function queueKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

function revokePreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function revokeQueuedTurnImages(turn: QueuedTurnDraft): void {
  for (const image of turn.images) {
    revokePreviewUrl(image.previewUrl);
  }
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

function hydrateImages(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) {
      return [];
    }
    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toPersistedQueuedTurnDraft(turn: QueuedTurnDraft): PersistedQueuedTurnDraft {
  return {
    id: turn.id,
    text: turn.text,
    createdAt: turn.createdAt,
    attachments: [...turn.persistedAttachments],
    terminalContexts: turn.terminalContexts.map((context) => ({ ...context })),
    modelSelection: turn.modelSelection,
    promptEffort: turn.promptEffort,
    runtimeMode: turn.runtimeMode,
    interactionMode: turn.interactionMode,
  };
}

function toHydratedQueuedTurnDraft(turn: PersistedQueuedTurnDraft): QueuedTurnDraft {
  return {
    id: turn.id,
    text: turn.text,
    createdAt: turn.createdAt,
    images: hydrateImages(turn.attachments),
    persistedAttachments: [...turn.attachments],
    terminalContexts: turn.terminalContexts.map((context) => ({ ...context })),
    modelSelection: turn.modelSelection,
    promptEffort: turn.promptEffort,
    runtimeMode: turn.runtimeMode,
    interactionMode: turn.interactionMode,
  };
}

function updateQueue(
  state: QueuedTurnStoreState,
  key: string,
  updater: (queue: ThreadQueueState | null) => ThreadQueueState | null,
): QueuedTurnStoreState {
  const current = state.threadsByThreadKey[key] ?? null;
  const next = updater(current);
  if (next === null || next.items.length === 0) {
    if (!(key in state.threadsByThreadKey)) {
      return state;
    }
    const { [key]: _removed, ...rest } = state.threadsByThreadKey;
    return { threadsByThreadKey: rest };
  }
  return {
    threadsByThreadKey: {
      ...state.threadsByThreadKey,
      [key]: next,
    },
  };
}

function clampMoveIndex(length: number, index: number): number {
  if (!Number.isFinite(index)) {
    return Math.max(0, length - 1);
  }
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

export const useQueuedTurnStore = create<QueuedTurnStore>()(
  persist(
    (set, get) => ({
      threadsByThreadKey: {},

      getQueue: (threadRef) => get().threadsByThreadKey[queueKey(threadRef)]?.items ?? EMPTY_QUEUE,

      enqueue: (threadRef, draft) => {
        const key = queueKey(threadRef);
        set((state) =>
          updateQueue(state, key, (current) => ({
            items: [...(current?.items ?? []), draft],
            updatedAt: new Date().toISOString(),
          })),
        );
      },

      prepend: (threadRef, draft) => {
        const key = queueKey(threadRef);
        set((state) =>
          updateQueue(state, key, (current) => ({
            items: [draft, ...(current?.items ?? [])],
            updatedAt: new Date().toISOString(),
          })),
        );
      },

      move: (threadRef, queuedTurnId, nextIndex) => {
        if (!queuedTurnId.trim()) {
          return;
        }
        const key = queueKey(threadRef);
        set((state) =>
          updateQueue(state, key, (current) => {
            if (!current || current.items.length < 2) {
              return current;
            }
            const currentIndex = current.items.findIndex((turn) => turn.id === queuedTurnId);
            if (currentIndex < 0) {
              return current;
            }
            const targetIndex = clampMoveIndex(current.items.length, nextIndex);
            if (targetIndex === currentIndex) {
              return current;
            }
            const nextItems = [...current.items];
            const [movedTurn] = nextItems.splice(currentIndex, 1);
            if (!movedTurn) {
              return current;
            }
            nextItems.splice(targetIndex, 0, movedTurn);
            return {
              items: nextItems,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      },

      consume: (threadRef, queuedTurnId) => {
        if (!queuedTurnId.trim()) {
          return;
        }
        const key = queueKey(threadRef);
        set((state) =>
          updateQueue(state, key, (current) => {
            if (!current) {
              return null;
            }
            const nextItems = current.items.filter((turn) => turn.id !== queuedTurnId);
            if (nextItems.length === current.items.length) {
              return current;
            }
            return {
              items: nextItems,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      },

      remove: (threadRef, queuedTurnId) => {
        if (!queuedTurnId.trim()) {
          return;
        }
        const key = queueKey(threadRef);
        const removed = get().threadsByThreadKey[key]?.items.find(
          (turn) => turn.id === queuedTurnId,
        );
        if (removed) {
          revokeQueuedTurnImages(removed);
        }
        get().consume(threadRef, queuedTurnId);
      },

      replaceText: (threadRef, queuedTurnId, text) => {
        if (!queuedTurnId.trim()) {
          return;
        }
        const trimmed = text.trim();
        const key = queueKey(threadRef);
        set((state) =>
          updateQueue(state, key, (current) => {
            if (!current) {
              return null;
            }
            let changed = false;
            const nextItems = current.items.map((turn) => {
              if (turn.id !== queuedTurnId) {
                return turn;
              }
              if (
                trimmed.length === 0 &&
                turn.images.length === 0 &&
                turn.terminalContexts.length === 0
              ) {
                changed = true;
                return null;
              }
              if (turn.text === trimmed) {
                return turn;
              }
              changed = true;
              return {
                ...turn,
                text: trimmed,
              };
            });
            const compactedItems = nextItems.flatMap((turn) => (turn ? [turn] : []));
            if (!changed) {
              return current;
            }
            return {
              items: compactedItems,
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      },

      clearThread: (threadRef) => {
        const key = queueKey(threadRef);
        const existing = get().threadsByThreadKey[key]?.items ?? EMPTY_QUEUE;
        for (const turn of existing) {
          revokeQueuedTurnImages(turn);
        }
        set((state) => updateQueue(state, key, () => null));
      },
    }),
    {
      name: QUEUED_TURN_STORE_STORAGE_KEY,
      version: QUEUED_TURN_STORE_STORAGE_VERSION,
      storage: createJSONStorage(() => queuedTurnDebouncedStorage),
      partialize: (state): PersistedQueueState => ({
        threadsByThreadKey: (() => {
          const persistedQueues: Record<string, PersistedThreadQueue> = {};
          for (const [threadKey, queue] of Object.entries(state.threadsByThreadKey)) {
            if (queue.items.length === 0) {
              continue;
            }
            persistedQueues[threadKey] = {
              items: queue.items.map(toPersistedQueuedTurnDraft),
              updatedAt: queue.updatedAt ?? null,
            };
          }
          return persistedQueues;
        })(),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          typeof persistedState === "object" && persistedState !== null
            ? (persistedState as Partial<PersistedQueueState>)
            : null;
        const threadsByThreadKey = Object.fromEntries(
          Object.entries(candidate?.threadsByThreadKey ?? {}).flatMap(([threadKey, queue]) => {
            const decodedQueue = Schema.decodeUnknownSync(PersistedThreadQueue)(queue);
            if (decodedQueue.items.length === 0) {
              return [];
            }
            return [
              [
                threadKey,
                {
                  items: decodedQueue.items.map(toHydratedQueuedTurnDraft),
                  updatedAt: decodedQueue.updatedAt ?? null,
                } satisfies ThreadQueueState,
              ],
            ];
          }),
        ) as Record<string, ThreadQueueState>;
        return {
          ...currentState,
          threadsByThreadKey,
        };
      },
    },
  ),
);

export function flushQueuedTurnStoreStorage(): void {
  queuedTurnDebouncedStorage.flush();
}
