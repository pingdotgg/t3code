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
 * Reads the queues currently on disk, settling any stale pending counts.
 *
 * Disk — not this tab's memory — is the source of truth for every mutation.
 * A union of the two could never distinguish "another tab added this entry"
 * from "this tab deleted it", which would resurrect deletions; reading the
 * live state and mutating *that* sidesteps the question entirely.
 */
function readPersistedQueues(): Record<string, ReadonlyArray<PromptStashEntry>> | null {
  try {
    // Read the backing store directly: the debounced wrapper's getItem is
    // typed as possibly-async, and this has to resolve synchronously inside a
    // store mutation.
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

/** Serializes queues in the exact envelope zustand's persist middleware uses. */
function writePersistedQueues(queues: Record<string, ReadonlyArray<PromptStashEntry>>): boolean {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { queuesByScopeKey: queues },
      }),
    );
    return true;
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return false;
  }
}

/**
 * Applies `mutate` to the queues currently on disk and writes the result back
 * synchronously, so concurrent tabs cannot clobber each other: each mutation
 * starts from whatever the other tab last wrote.
 *
 * Writes are immediate rather than debounced. Stashing is a deliberate,
 * infrequent keystroke — not a per-character autosave — so there is nothing to
 * coalesce, and a debounce window is exactly where cross-tab races live.
 *
 * Returns the mutation's own result plus whether the write reached disk.
 */
function commitQueues<T>(
  localQueues: Record<string, ReadonlyArray<PromptStashEntry>>,
  mutate: (queues: Record<string, ReadonlyArray<PromptStashEntry>>) => {
    next: Record<string, ReadonlyArray<PromptStashEntry>>;
    result: T;
  },
): {
  next: Record<string, ReadonlyArray<PromptStashEntry>>;
  result: T;
  /** The write itself succeeded (possibly only in memory). */
  written: boolean;
  /** The write will survive a reload. */
  durable: boolean;
} {
  // Fall back to this tab's state only when there is nothing readable on disk
  // (first write of the session, blocked storage, corrupt payload).
  const base = readPersistedQueues() ?? localQueues;
  const { next, result } = mutate(base);
  // The write still happens against the in-memory fallback so the stash works
  // within the session; `durable` reports only whether it will survive a
  // reload, which is what callers gate composer-clearing on.
  const written = writePersistedQueues(next);
  return { next, result, written, durable: written && storageIsDurable };
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
    const { next, result, written, durable } = commitQueues(get().queuesByScopeKey, (queues) => {
      const nextQueue = [entry, ...readQueue(queues, scopeKey)];
      const evicted =
        nextQueue.length > MAX_STASH_ENTRIES_PER_QUEUE ? (nextQueue.pop() ?? null) : null;
      return { next: { ...queues, [scopeKey]: nextQueue }, result: evicted };
    });
    // A rejected write must not leave the entry visible in this tab: the
    // caller keeps the composer intact on failure, so showing a stashed
    // copy too would duplicate the prompt.
    set(() => ({ queuesByScopeKey: written ? next : (readPersistedQueues() ?? {}) }));
    return { evicted: written ? result : null, durable };
  },
  takeEntry: (scopeKey, entryId) => {
    const { next, result, durable } = commitQueues(get().queuesByScopeKey, (queues) => {
      const queue = readQueue(queues, scopeKey);
      const entry = queue.find((candidate) => candidate.id === entryId) ?? null;
      if (!entry) return { next: queues, result: null };
      const nextQueue = queue.filter((candidate) => candidate.id !== entryId);
      const nextQueues = { ...queues };
      if (nextQueue.length === 0) {
        delete nextQueues[scopeKey];
      } else {
        nextQueues[scopeKey] = nextQueue;
      }
      return { next: nextQueues, result: entry };
    });
    set(() => ({ queuesByScopeKey: next }));
    return { entry: result, durable };
  },
  finalizeEntryImages: (scopeKey, entryId, images) => {
    const { next, result, durable } = commitQueues(get().queuesByScopeKey, (queues) => {
      const queue = readQueue(queues, scopeKey);
      const index = queue.findIndex((candidate) => candidate.id === entryId);
      const existing = index === -1 ? undefined : queue[index];
      // Restored or deleted mid-encode: nothing to attach to.
      if (!existing) return { next: queues, result: false };
      const nextQueue = [...queue];
      nextQueue[index] = {
        ...existing,
        attachments: images.attachments,
        droppedImageNames: images.droppedImageNames,
        unreadableImageNames: images.unreadableImageNames,
        pendingImageCount: 0,
      };
      return { next: { ...queues, [scopeKey]: nextQueue }, result: true };
    });
    set(() => ({ queuesByScopeKey: next }));
    return { attached: result, durable };
  },
}));

/**
 * Refreshes the in-memory queues from disk. Mutations already read-modify-write
 * synchronously, so this only matters for picking up another tab's changes.
 */
function syncQueuesFromStorage(): void {
  const persisted = readPersistedQueues();
  if (persisted) {
    usePromptStashStore.setState({ queuesByScopeKey: persisted });
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Hydrate once at startup, then follow other tabs. `storage` fires only in
  // *other* tabs, which is exactly the case this tab cannot observe itself.
  syncQueuesFromStorage();
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === PROMPT_STASH_STORAGE_KEY) {
      syncQueuesFromStorage();
    }
  });
}

export const EMPTY_PROMPT_STASH_QUEUE: ReadonlyArray<PromptStashEntry> = [];

/**
 * Test seam: writes the raw persisted payload through the same storage the
 * store reads, so cross-tab behavior can be exercised without a real
 * `localStorage` global. Pass an empty string to clear.
 */
export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  syncQueuesFromStorage();
}
