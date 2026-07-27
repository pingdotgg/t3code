import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { PersistedComposerImageAttachment } from "./composerDraftStore";
import { createDebouncedStorage, createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 1;
const PROMPT_STASH_PERSIST_DEBOUNCE_MS = 300;

/**
 * Queue bucket for prompts stashed while no provider instance is selected.
 *
 * Provider-scoped keys are prefixed (see `promptStashScopeKey`), so this
 * sentinel can never collide with a provider literally named `__none__`.
 */
export const PROMPT_STASH_UNSCOPED_KEY = "__none__";
/** Namespace applied to provider-derived keys to keep them collision-proof. */
const PROVIDER_SCOPE_PREFIX = "provider:";

export const MAX_STASH_ENTRIES_PER_QUEUE = 20;
/**
 * Budget for an entry's serialized attachment payload. localStorage is a
 * ~5MB origin-wide quota shared with the composer draft store, so oversized
 * images are dropped (tracked in `droppedImageNames`) rather than persisted.
 *
 * Sized to hold two images at the per-image compression budget
 * (`MAX_STASH_IMAGE_DATA_URL_CHARS`) so a typical before/after screenshot
 * pair survives intact.
 */
export const MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000;

const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  modelSelection: Schema.NullOr(ModelSelection),
  /** Names of images that exceeded the attachment budget and were not saved. */
  droppedImageNames: Schema.Array(Schema.String),
  /**
   * Names of images that could not be decoded or re-encoded at all — a
   * distinct failure from exceeding the size budget, so the menu can explain
   * which actually happened. Optional: entries written before this field
   * existed decode without it.
   */
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  queuesByScopeKey: Schema.Record(Schema.String, Schema.Array(StashEntrySchema)),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

/** Maps the composer's active provider instance to a stash queue bucket. */
export function promptStashScopeKey(instanceId: ProviderInstanceId | null | undefined): string {
  return instanceId ? `${PROVIDER_SCOPE_PREFIX}${instanceId}` : PROMPT_STASH_UNSCOPED_KEY;
}

/**
 * Reads a queue without inheriting from `Object.prototype`. Scope keys derive
 * from user-authored provider slugs, so a key like `__proto__` must not
 * resolve to the prototype chain.
 */
function readQueue(
  queues: Record<string, ReadonlyArray<PromptStashEntry>>,
  scopeKey: string,
): ReadonlyArray<PromptStashEntry> {
  return Object.hasOwn(queues, scopeKey) ? (queues[scopeKey] ?? []) : [];
}

/**
 * Splits candidate attachments into a persistable set within the entry
 * budget plus the names of any that had to be dropped. Attachments are
 * admitted in order so the earliest-added images win.
 */
export function partitionStashAttachments(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): {
  kept: PersistedComposerImageAttachment[];
  droppedNames: string[];
} {
  const kept: PersistedComposerImageAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_STASH_ENTRY_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

/**
 * Base64 image payloads can hit the origin's localStorage quota. A quota
 * failure must not become an uncaught exception inside the debounce timer:
 * the in-memory queue still works for the session, so log and move on.
 */
function createQuotaSafeStorage(base: StateStorage): StateStorage {
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      try {
        base.setItem(name, value);
      } catch (error) {
        console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
      }
    },
    removeItem: (name) => {
      try {
        base.removeItem(name);
      } catch (error) {
        console.error("[PROMPT-STASH] Could not remove stash entry.", error);
      }
    },
  };
}

const promptStashDebouncedStorage = createDebouncedStorage(
  createQuotaSafeStorage(
    typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  ),
  PROMPT_STASH_PERSIST_DEBOUNCE_MS,
);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    promptStashDebouncedStorage.flush();
  });
}

interface PromptStashStoreState {
  queuesByScopeKey: Record<string, ReadonlyArray<PromptStashEntry>>;
  /**
   * Prepends an entry to its scope's queue, evicting the oldest entry past
   * the per-queue cap. Returns the evicted entry (for messaging) if any.
   */
  stashEntry: (entry: PromptStashEntry) => PromptStashEntry | null;
  /** Removes and returns an entry from a scope's queue (restore + delete). */
  takeEntry: (scopeKey: string, entryId: string) => PromptStashEntry | null;
}

export const usePromptStashStore = create<PromptStashStoreState>()(
  persist(
    (set, get) => ({
      queuesByScopeKey: {},
      stashEntry: (entry) => {
        const scopeKey = promptStashScopeKey(entry.providerInstanceId);
        const queue = readQueue(get().queuesByScopeKey, scopeKey);
        const nextQueue = [entry, ...queue];
        const evicted =
          nextQueue.length > MAX_STASH_ENTRIES_PER_QUEUE ? (nextQueue.pop() ?? null) : null;
        set((state) => ({
          queuesByScopeKey: { ...state.queuesByScopeKey, [scopeKey]: nextQueue },
        }));
        return evicted;
      },
      takeEntry: (scopeKey, entryId) => {
        const queue = readQueue(get().queuesByScopeKey, scopeKey);
        const entry = queue.find((candidate) => candidate.id === entryId) ?? null;
        if (!entry) return null;
        set((state) => {
          const nextQueue = readQueue(state.queuesByScopeKey, scopeKey).filter(
            (candidate) => candidate.id !== entryId,
          );
          const nextQueues = { ...state.queuesByScopeKey };
          if (nextQueue.length === 0) {
            delete nextQueues[scopeKey];
          } else {
            nextQueues[scopeKey] = nextQueue;
          }
          return { queuesByScopeKey: nextQueues };
        });
        return entry;
      },
    }),
    {
      name: PROMPT_STASH_STORAGE_KEY,
      version: PROMPT_STASH_STORAGE_VERSION,
      storage: createJSONStorage(() => promptStashDebouncedStorage),
      partialize: (state): PersistedPromptStashState => ({
        queuesByScopeKey: state.queuesByScopeKey,
      }),
      merge: (persistedState, currentState) => {
        try {
          const decoded = decodePersistedPromptStashState(persistedState);
          return { ...currentState, queuesByScopeKey: { ...decoded.queuesByScopeKey } };
        } catch {
          // Corrupt or incompatible payload: start empty rather than crash.
          return currentState;
        }
      },
    },
  ),
);

/** Flushes pending stash writes immediately (e.g. right after a stash). */
export function flushPromptStashStorage(): void {
  promptStashDebouncedStorage.flush();
}

export const EMPTY_PROMPT_STASH_QUEUE: ReadonlyArray<PromptStashEntry> = [];
