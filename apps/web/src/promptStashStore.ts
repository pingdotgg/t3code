import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PersistedComposerImageAttachment } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 1;

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
  /**
   * Images still being encoded when the entry was written. The entry is
   * persisted before its images so a crash mid-encode cannot lose the prompt;
   * this field lets the UI show "N images still saving" until
   * `finalizeEntryImages` lands, and flags entries orphaned by a reload.
   */
  pendingImageCount: Schema.optionalKey(Schema.Number),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  queuesByScopeKey: Schema.Record(Schema.String, Schema.Array(StashEntrySchema)),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

/**
 * `pendingImageCount` only has meaning within the session that wrote it: the
 * encode loop that would clear it does not survive a reload. Any entry that
 * comes back from storage still pending was orphaned by a closed tab or a
 * crash mid-encode, so the count is settled here — otherwise the entry would
 * be stuck showing "saving…" and refuse to restore forever.
 *
 * The images are genuinely gone (they were never written), so they are
 * recorded as unreadable to keep the prompt itself restorable.
 */
function clearOrphanedPendingImages(
  queues: Record<string, ReadonlyArray<PromptStashEntry>>,
): Record<string, ReadonlyArray<PromptStashEntry>> {
  const next: Record<string, ReadonlyArray<PromptStashEntry>> = {};
  for (const [scopeKey, queue] of Object.entries(queues)) {
    next[scopeKey] = queue.map((entry) => {
      if (!entry.pendingImageCount) return entry;
      const lostCount = entry.pendingImageCount;
      return {
        ...entry,
        pendingImageCount: 0,
        unreadableImageNames: [
          ...(entry.unreadableImageNames ?? []),
          ...Array.from(
            { length: lostCount },
            (_, index) => `image ${index + 1} (not saved before reload)`,
          ),
        ],
      };
    });
  }
  return next;
}

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
 * Reading the `localStorage` property itself can throw `SecurityError` when
 * storage is blocked by policy or the page is a sandboxed iframe — so the
 * access has to be guarded, not just the get/set calls on it. Otherwise
 * importing this module would crash the app at load.
 *
 * `durable` is false for the in-memory fallback: writes there "succeed" but
 * vanish on reload, and callers clear the composer on the strength of a
 * successful stash, so they must be told the difference.
 */
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

/**
 * Persists the queues, immediately rather than debounced. Stashing is a
 * deliberate, infrequent keystroke — not a per-character autosave — so there
 * is nothing to coalesce, and the caller clears the composer on the strength
 * of this write landing, which a debounce timer cannot honestly report.
 *
 * Returns whether the write will survive a reload: false on a quota rejection
 * or when only the in-memory fallback is available.
 */
function persistQueues(queues: Record<string, ReadonlyArray<PromptStashEntry>>): {
  /** The write succeeded (possibly only into the in-memory fallback). */
  written: boolean;
  /** The write will survive a reload. */
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { queuesByScopeKey: queues },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

/** Reads the persisted queues, settling stale pending counts. */
function readPersistedQueues(): Record<string, ReadonlyArray<PromptStashEntry>> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return clearOrphanedPendingImages(decodePersistedPromptStashState(state).queuesByScopeKey);
  } catch {
    return null;
  }
}

interface PromptStashStoreState {
  queuesByScopeKey: Record<string, ReadonlyArray<PromptStashEntry>>;
  /**
   * Prepends an entry to its scope's queue, evicting the oldest entry past
   * the per-queue cap. Returns the evicted entry (for messaging) if any.
   */
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    /** False when the write did not reach durable storage; nothing was kept. */
    durable: boolean;
  };
  /**
   * Removes and returns an entry from a scope's queue (restore + delete).
   * `durable` is false when the removal could not be persisted, meaning a
   * reload would resurrect the entry.
   */
  takeEntry: (
    scopeKey: string,
    entryId: string,
  ) => { entry: PromptStashEntry | null; durable: boolean };
  /**
   * Attaches the encoded images to an entry written earlier by `stashEntry`,
   * clearing its pending count. Returns attached=false when the entry is gone
   * (restored or deleted while encoding was still running) so the caller can
   * tell the user their images did not make it.
   */
  finalizeEntryImages: (
    scopeKey: string,
    entryId: string,
    images: {
      attachments: ReadonlyArray<PersistedComposerImageAttachment>;
      droppedImageNames: ReadonlyArray<string>;
      unreadableImageNames: ReadonlyArray<string>;
    },
  ) => { attached: boolean; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  queuesByScopeKey: {},
  stashEntry: (entry) => {
    const scopeKey = promptStashScopeKey(entry.providerInstanceId);
    const queues = get().queuesByScopeKey;
    const nextQueue = [entry, ...readQueue(queues, scopeKey)];
    const evicted =
      nextQueue.length > MAX_STASH_ENTRIES_PER_QUEUE ? (nextQueue.pop() ?? null) : null;
    const next = { ...queues, [scopeKey]: nextQueue };
    const { written, durable } = persistQueues(next);
    // A rejected write must not leave the entry visible either: the caller
    // keeps the composer intact on failure, so a stashed copy would
    // duplicate the prompt. Eviction likewise only sticks on success.
    if (!written) {
      return { evicted: null, durable: false };
    }
    set(() => ({ queuesByScopeKey: next }));
    return { evicted, durable };
  },
  takeEntry: (scopeKey, entryId) => {
    const queues = get().queuesByScopeKey;
    const queue = readQueue(queues, scopeKey);
    const entry = queue.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextQueue = queue.filter((candidate) => candidate.id !== entryId);
    const next = { ...queues };
    if (nextQueue.length === 0) {
      delete next[scopeKey];
    } else {
      next[scopeKey] = nextQueue;
    }
    const { durable } = persistQueues(next);
    set(() => ({ queuesByScopeKey: next }));
    return { entry, durable };
  },
  finalizeEntryImages: (scopeKey, entryId, images) => {
    const queues = get().queuesByScopeKey;
    const queue = readQueue(queues, scopeKey);
    const index = queue.findIndex((candidate) => candidate.id === entryId);
    const existing = index === -1 ? undefined : queue[index];
    // Restored or deleted mid-encode: nothing to attach to.
    if (!existing) return { attached: false, durable: true };
    const nextQueue = [...queue];
    nextQueue[index] = {
      ...existing,
      attachments: images.attachments,
      droppedImageNames: images.droppedImageNames,
      unreadableImageNames: images.unreadableImageNames,
      pendingImageCount: 0,
    };
    const next = { ...queues, [scopeKey]: nextQueue };
    const { durable } = persistQueues(next);
    set(() => ({ queuesByScopeKey: next }));
    return { attached: true, durable };
  },
}));

// Hydrate once at startup. Like the app's other persisted stores, tabs are
// last-write-wins: no cross-tab merging or storage-event syncing.
{
  const persisted = readPersistedQueues();
  if (persisted) {
    usePromptStashStore.setState({ queuesByScopeKey: persisted });
  }
}

export const EMPTY_PROMPT_STASH_QUEUE: ReadonlyArray<PromptStashEntry> = [];

/**
 * Test seam: seeds the persisted payload through the same storage the store
 * reads and rehydrates, without needing a real `localStorage` global.
 * Pass an empty string to clear.
 */
export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  usePromptStashStore.setState({ queuesByScopeKey: readPersistedQueues() ?? {} });
}
