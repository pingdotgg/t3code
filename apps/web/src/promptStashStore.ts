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

/** Held by the stashing tab until its encode finalizes; a closed or crashed tab drops it. */
const encodeLockName = (entryId: string) => `t3code:prompt-stash:encode:${entryId}`;
const encodeLockReleases = new Map<string, () => void>();

// Typed as always present, but missing in older browsers and non-secure contexts.
function encodeLocks(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

function holdEncodeLock(entryId: string): void {
  const locks = encodeLocks();
  if (!locks) return;
  const released = new Promise<void>((resolve) => encodeLockReleases.set(entryId, resolve));
  void locks.request(encodeLockName(entryId), () => released).catch(() => {});
}

function releaseEncodeLock(entryId: string): void {
  encodeLockReleases.get(entryId)?.();
  encodeLockReleases.delete(entryId);
}

/**
 * Without Web Locks (older browsers, plain-http origins), ownership is unknowable, so only
 * entries older than any plausible encode settle; a tab suspended past it can still lose them.
 */
const PENDING_IMAGE_ENCODE_WINDOW_MS = 15 * 60 * 1000;

function orphanedPendingEntryIds(entries: ReadonlyArray<PromptStashEntry>): ReadonlySet<string> {
  const now = Date.now();
  return new Set(
    entries
      .filter((entry) => {
        if (!entry.pendingImageCount) return false;
        const startedAt = Date.parse(entry.createdAt);
        return Number.isNaN(startedAt) || now - startedAt > PENDING_IMAGE_ENCODE_WINDOW_MS;
      })
      .map((entry) => entry.id),
  );
}

/** Runs `critical` holding every named lock, or not at all when anyone holds or awaits one. */
function withEveryLockIfAvailable<T>(
  locks: LockManager,
  names: ReadonlyArray<string>,
  critical: () => T,
): Promise<T | undefined> {
  const [name, ...rest] = names;
  if (name === undefined) return Promise.resolve(critical());
  return locks.request(name, { ifAvailable: true }, (lock) =>
    lock ? withEveryLockIfAvailable(locks, rest, critical) : undefined,
  );
}

const pendingEntryIds = (entries: ReadonlyArray<PromptStashEntry>) =>
  new Set(entries.filter((entry) => entry.pendingImageCount).map((entry) => entry.id));

const SETTLE_LOCK_ATTEMPTS = 3;

/**
 * Only the stashing tab's encode clears `pendingImageCount`, so an entry nobody encodes would
 * show "saving…" forever. Settling writes only while holding the encode lock of every entry
 * pending in its final read, and an encoder frees its lock only after finalizing.
 */
async function settleOrphanedPendingImages(loaded: ReadonlyArray<PromptStashEntry>) {
  let pendingIds = pendingEntryIds(loaded);
  if (pendingIds.size === 0) return;
  const locks = encodeLocks();
  if (!locks) {
    const orphanIds = orphanedPendingEntryIds(loaded);
    const latest = orphanIds.size === 0 ? null : readPersistedEntries();
    if (latest) settlePendingImages(latest, orphanIds);
    return;
  }
  try {
    for (let attempt = 0; attempt < SETTLE_LOCK_ATTEMPTS; attempt += 1) {
      const heldIds = pendingIds;
      // Any live encoder, this tab's included, defers settling to a later load.
      const settled = await withEveryLockIfAvailable(
        locks,
        [...heldIds].map(encodeLockName),
        () => {
          const latest = readPersistedEntries();
          if (!latest) return true;
          pendingIds = pendingEntryIds(latest);
          // An entry stashed while this tab acquired its locks needs its own lock first.
          if ([...pendingIds].some((id) => !heldIds.has(id))) return false;
          settlePendingImages(latest, heldIds);
          return true;
        },
      );
      if (settled !== false) return;
    }
  } catch {}
}

function settlePendingImages(
  latest: ReadonlyArray<PromptStashEntry>,
  orphanIds: ReadonlySet<string>,
): void {
  let settledAny = false;
  const settled = latest.map((entry) => {
    if (!entry.pendingImageCount || !orphanIds.has(entry.id)) return entry;
    settledAny = true;
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
  if (!settledAny) return;
  persistEntries(settled);
  usePromptStashStore.setState({ entries: visibleEntries(settled) });
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

interface StashEntryImages {
  attachments: ReadonlyArray<PersistedComposerImageAttachment>;
  droppedImageNames: ReadonlyArray<string>;
  unreadableImageNames: ReadonlyArray<string>;
}

/**
 * Finalized images storage refused (quota), by entry id. Storage gets the
 * entry with those images listed as dropped, so a reload or another tab
 * reports them missing; this tab keeps them until it reloads, as the stash
 * toast promises.
 */
const unsavedImagesByEntryId = new Map<string, StashEntryImages>();

function withUnsavedImages(entry: PromptStashEntry): PromptStashEntry {
  const images = unsavedImagesByEntryId.get(entry.id);
  return images ? { ...entry, ...images, pendingImageCount: 0 } : entry;
}

function withoutUnsavedImages(entry: PromptStashEntry): PromptStashEntry {
  const images = unsavedImagesByEntryId.get(entry.id);
  if (!images) return entry;
  return {
    ...entry,
    attachments: [],
    droppedImageNames: [
      ...images.droppedImageNames,
      ...images.attachments.map((attachment) => attachment.name),
    ],
    unreadableImageNames: images.unreadableImageNames,
    pendingImageCount: 0,
  };
}

/** Storage's entries as this tab shows them, forgetting images of entries now gone. */
function visibleEntries(entries: ReadonlyArray<PromptStashEntry>): ReadonlyArray<PromptStashEntry> {
  for (const entryId of unsavedImagesByEntryId.keys()) {
    if (!entries.some((entry) => entry.id === entryId)) unsavedImagesByEntryId.delete(entryId);
  }
  return unsavedImagesByEntryId.size === 0 ? entries : entries.map(withUnsavedImages);
}

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
        state: {
          entries: unsavedImagesByEntryId.size === 0 ? entries : entries.map(withoutUnsavedImages),
        },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

function readPersistedEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return decodePersistedPromptStashState(state).entries;
  } catch {
    return null;
  }
}

/**
 * Every tab of the origin shares one stash. A change starts from what storage
 * holds now rather than this tab's copy, so writing it back cannot erase an
 * entry another tab stashed since this tab last read.
 */
function latestEntries(current: ReadonlyArray<PromptStashEntry>): ReadonlyArray<PromptStashEntry> {
  return readPersistedEntries() ?? current;
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
  /** durable=false means removal was not persisted and reload would restore the entry. */
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
  /** attached=false means the entry disappeared while encoding, so images could not be saved. */
  finalizeEntryImages: (
    entryId: string,
    images: StashEntryImages,
  ) => { attached: boolean; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...latestEntries(get().entries)];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    // Requested before the write, so the owner is normally registered before another tab reads the entry.
    if (entry.pendingImageCount) holdEncodeLock(entry.id);
    const { written, durable } = persistEntries(nextEntries);
    // Failed writes must not duplicate the intact composer; eviction also commits only on success.
    if (!written) {
      releaseEncodeLock(entry.id);
      return { evicted: null, written: false, durable: false };
    }
    set(() => ({ entries: visibleEntries(nextEntries) }));
    return { evicted, written: true, durable };
  },
  takeEntry: (entryId) => {
    const entries = latestEntries(get().entries);
    const stored = entries.find((candidate) => candidate.id === entryId);
    if (!stored) return { entry: null, durable: true };
    const entry = withUnsavedImages(stored);
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: visibleEntries(nextEntries) }));
    return { entry, durable };
  },
  finalizeEntryImages: (entryId, images) => {
    releaseEncodeLock(entryId);
    const entries = latestEntries(get().entries);
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
    if (!written) {
      // The smaller write without the images settles the stored entry, so it
      // never shows "saving…" again with no encoder left to finish it.
      unsavedImagesByEntryId.set(entryId, {
        attachments: images.attachments,
        droppedImageNames: images.droppedImageNames,
        unreadableImageNames: images.unreadableImageNames,
      });
      persistEntries(nextEntries);
    }
    set(() => ({ entries: visibleEntries(nextEntries) }));
    return { attached: true, durable };
  },
}));

/** Shows storage as it is now; orphaned pending counts settle once ownership is known. */
function loadPersistedEntries(): Promise<void> {
  const persisted = readPersistedEntries();
  usePromptStashStore.setState({ entries: persisted ?? [] });
  return persisted ? settleOrphanedPendingImages(persisted) : Promise.resolve();
}

{
  try {
    baseStashStorage.removeItem(LEGACY_PROMPT_STASH_STORAGE_KEY);
  } catch {}
  void loadPersistedEntries();
  // Fires only for writes from other tabs, keeping this tab's list current.
  if (storageIsDurable && typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== PROMPT_STASH_STORAGE_KEY && event.key !== null) return;
      usePromptStashStore.setState({ entries: visibleEntries(readPersistedEntries() ?? []) });
    });
  }
}

export function writePromptStashStorageForTest(raw: string): Promise<void> {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  return loadPersistedEntries();
}
