import { ComposerContextRecord, ForwardCompatibleArray } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

export const PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v2";
const LEGACY_PROMPT_STASH_STORAGE_KEY = "t3code:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 2;

export const MAX_STASH_ENTRIES = 20;
// Share localStorage's ~5MB quota with drafts; record oversized attachments in droppedImageNames.
export const MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000;

const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerFileAttachment)),
  droppedImageNames: Schema.Array(Schema.String),
  unreadableImageNames: Schema.optionalKey(Schema.Array(Schema.String)),
  pendingImageCount: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(ForwardCompatibleArray(ComposerContextRecord)),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(StashEntrySchema),
});
type PersistedPromptStashState = typeof PersistedPromptStashState.Type;

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

// Encoders cannot survive reload; clear orphaned counts so entries remain restorable.
function clearOrphanedPendingImages(entry: PromptStashEntry): PromptStashEntry {
  if (!entry.pendingImageCount) return entry;
  return {
    ...entry,
    pendingImageCount: 0,
    unreadableImageNames: [
      ...(entry.unreadableImageNames ?? []),
      ...Array.from(
        { length: entry.pendingImageCount },
        (_, index) => `image ${index + 1} (not saved before reload)`,
      ),
    ],
  };
}

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

// Accessing localStorage itself can throw SecurityError before get/set.
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {}
  return { storage: createMemoryStorage(), durable: false };
}

const { storage: baseStashStorage, durable: storageIsDurable } = resolveBaseStorage();

const unpersistedFinalizedEntryIds = new Set<string>();
const recoveredEntryIds = new Set<string>();
const encodingEntryIds = new Set<string>();
let memoryEntries: ReadonlyArray<PromptStashEntry> = [];

// Clear the composer only after a durable write; debounce cannot confirm durability.
function persistEntries(entries: ReadonlyArray<PromptStashEntry>): {
  written: boolean;
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { entries },
      }),
    );
    unpersistedFinalizedEntryIds.clear();
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

function readStoredEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (raw === null) return [];
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return decodePersistedPromptStashState(state).entries;
  } catch {
    return null;
  }
}

function recoverEntry(entry: PromptStashEntry): PromptStashEntry {
  return recoveredEntryIds.has(entry.id) ? clearOrphanedPendingImages(entry) : entry;
}

function hydrateEntries() {
  const entries = readStoredEntries() ?? [];
  recoveredEntryIds.clear();
  for (const entry of entries) {
    if (entry.pendingImageCount) recoveredEntryIds.add(entry.id);
  }
  publishEntries(entries);
}

function publishEntries(entries: ReadonlyArray<PromptStashEntry>) {
  // Recovery is local to the loading tab because another tab may still be encoding.
  memoryEntries = entries;
  usePromptStashStore.setState({
    entries: recoveredEntryIds.size === 0 ? entries : entries.map(recoverEntry),
  });
}

/**
 * Reconciles the local queue with storage before writes and after changes in other tabs.
 * Failed finalize writes retain their local images while the stored entry exists.
 */
function latestEntries(): ReadonlyArray<PromptStashEntry> {
  const stored = readStoredEntries();
  if (!stored) return memoryEntries;
  if (unpersistedFinalizedEntryIds.size === 0) return stored;
  const storedIds = new Set(stored.map((entry) => entry.id));
  for (const id of unpersistedFinalizedEntryIds) {
    if (!storedIds.has(id)) unpersistedFinalizedEntryIds.delete(id);
  }
  const memoryById = new Map(memoryEntries.map((entry) => [entry.id, entry]));
  return stored.map((entry) =>
    unpersistedFinalizedEntryIds.has(entry.id) ? (memoryById.get(entry.id) ?? entry) : entry,
  );
}

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    /** False when the write failed outright (e.g. quota); nothing was kept. */
    written: boolean;
    /** False for failed writes or in-memory fallback; the entry will not survive reload. */
    durable: boolean;
  };
  /** Restore waits for images. durable=false means the entry could reappear after reload. */
  takeEntry: (
    entryId: string,
    action?: "restore" | "delete",
  ) => { entry: PromptStashEntry | null; durable: boolean };
  /** attached=false means the entry disappeared while encoding, so images could not be saved. */
  finalizeEntryImages: (
    entryId: string,
    images: {
      attachments: ReadonlyArray<PersistedComposerImageAttachment>;
      droppedImageNames: ReadonlyArray<string>;
      unreadableImageNames: ReadonlyArray<string>;
    },
  ) => { attached: boolean; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()(() => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...latestEntries()];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    const { written, durable } = persistEntries(nextEntries);
    // Failed writes must not duplicate the intact composer; eviction also commits only on success.
    if (!written) {
      return { evicted: null, written: false, durable: false };
    }
    if (entry.pendingImageCount) encodingEntryIds.add(entry.id);
    publishEntries(nextEntries);
    return { evicted: evicted && recoverEntry(evicted), written: true, durable };
  },
  takeEntry: (entryId, action = "restore") => {
    const entries = latestEntries();
    const stored = entries.find((candidate) => candidate.id === entryId);
    const entry = stored && recoverEntry(stored);
    if (!entry || (action === "restore" && entry.pendingImageCount)) {
      return { entry: null, durable: true };
    }
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    unpersistedFinalizedEntryIds.delete(entryId);
    encodingEntryIds.delete(entryId);
    publishEntries(nextEntries);
    return { entry, durable };
  },
  finalizeEntryImages: (entryId, images) => {
    encodingEntryIds.delete(entryId);
    const entries = latestEntries();
    const index = entries.findIndex((candidate) => candidate.id === entryId);
    const existing = index === -1 ? undefined : entries[index];
    if (!existing) return { attached: false, durable: true };
    const nextEntries = [...entries];
    nextEntries[index] = {
      ...existing,
      attachments: images.attachments,
      droppedImageNames: images.droppedImageNames,
      unreadableImageNames: images.unreadableImageNames,
      pendingImageCount: 0,
    };
    const { written, durable } = persistEntries(nextEntries);
    if (!written) unpersistedFinalizedEntryIds.add(entryId);
    publishEntries(nextEntries);
    return { attached: true, durable };
  },
}));

{
  try {
    baseStashStorage.removeItem(LEGACY_PROMPT_STASH_STORAGE_KEY);
  } catch {}
  hydrateEntries();
}

if (storageIsDurable && typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== baseStashStorage) return;
    if (event.key !== PROMPT_STASH_STORAGE_KEY && event.key !== null) return;

    // A queued event can describe an older write than the value now in storage.
    const latest = latestEntries();
    if (latest !== memoryEntries) publishEntries(latest);
  });
  // Other open tabs wait on this tab's encoding; tell them it will not finish.
  window.addEventListener("pagehide", () => {
    if (encodingEntryIds.size === 0) return;
    const entries = latestEntries();
    persistEntries(
      entries.map((entry) =>
        encodingEntryIds.has(entry.id) ? clearOrphanedPendingImages(entry) : entry,
      ),
    );
  });
}

export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  hydrateEntries();
}
