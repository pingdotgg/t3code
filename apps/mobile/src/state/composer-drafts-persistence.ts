import type { ModelSelection } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { writeFileAtomically } from "../lib/atomic-file";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import {
  COMPOSER_DRAFTS_DIRECTORY,
  COMPOSER_DRAFTS_FILE,
  COMPOSER_DRAFTS_SCHEMA_VERSION,
  ComposerDraftPersistenceError,
  composerCloudDraftsAtom,
  composerDraftsAtom,
  composerDraftsLoadedAtom,
  decodePersistedComposerState,
  isEmptyDraft,
  modelOptionMemoryAtom,
  stickyComposerModelSelectionAtom,
  type ComposerDraft,
} from "./composer-drafts-model";
import { encodeQueuedThreadMessage } from "./thread-outbox-model";

const PERSIST_DEBOUNCE_MS = 200;

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistRetryNeeded = false;
const persistenceQueue = new SerializedAsyncQueue();

export function resetComposerDraftsLoadState(): void {
  loadPromise = null;
  appAtomRegistry.set(composerDraftsLoadedAtom, false);
  persistRetryNeeded = false;
}

async function getComposerDraftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, COMPOSER_DRAFTS_FILE);
}

async function loadPersistedComposerState(): Promise<
  ReturnType<typeof decodePersistedComposerState>
> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    if (!file.exists) {
      return {
        drafts: {},
        stickyModelSelection: null,
        modelOptionMemory: {},
        cloudDrafts: { accountId: null, signedOut: {} },
      };
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return decodePersistedComposerState(JSON.parse(raw) as unknown);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

async function writePersistedComposerState(
  drafts: Record<string, ComposerDraft>,
  stickyModelSelection: ModelSelection | null,
  cloudDrafts = appAtomRegistry.get(composerCloudDraftsAtom),
): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    operation = "encode";
    const nonEmptyDrafts = Object.fromEntries(
      Object.entries(drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    );
    const document = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      drafts: nonEmptyDrafts,
      ...(stickyModelSelection ? { stickyModelSelection } : {}),
      ...(Object.keys(appAtomRegistry.get(modelOptionMemoryAtom)).length > 0
        ? { modelOptionMemory: appAtomRegistry.get(modelOptionMemoryAtom) }
        : {}),
      ...(cloudDrafts.accountId ? { cloudAccountId: cloudDrafts.accountId } : {}),
      ...(Object.keys(cloudDrafts.signedOut).length > 0
        ? {
            signedOutDrafts: Object.fromEntries(
              Object.entries(cloudDrafts.signedOut).map(([id, saved]) => [
                id,
                {
                  drafts: saved.drafts,
                  queuedMessages: saved.queuedMessages.map(encodeQueuedThreadMessage),
                },
              ]),
            ),
          }
        : {}),
    } as const;
    const encoded = JSON.stringify(document);
    operation = "write";
    await writeFileAtomically(file, encoded);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

/** Propagates write failures so callers can decide whether to restart. */
export async function flushComposerDrafts(): Promise<void> {
  // Hydrate before writing or partial atom state would clobber persisted drafts.
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  // Edits during writes schedule more debounces; drain until none remain.
  do {
    while (persistTimer !== null || persistRetryNeeded) {
      if (persistTimer !== null) clearTimeout(persistTimer);
      persistTimer = null;
      persistRetryNeeded = false;
      try {
        await persistenceQueue.run(() =>
          writePersistedComposerState(
            appAtomRegistry.get(composerDraftsAtom),
            appAtomRegistry.get(stickyComposerModelSelectionAtom),
          ),
        );
      } catch (error) {
        persistRetryNeeded = true;
        throw error;
      }
    }
    // Draining includes fired debounce writes still awaiting hydration inside the queue.
    await persistenceQueue.run(() => Promise.resolve());
  } while (persistTimer !== null || persistRetryNeeded);
}

export function schedulePersistComposerState(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Enqueue before awaiting hydration so flushComposerDrafts cannot drain ahead of this write.
    void persistenceQueue.run(async () => {
      try {
        await waitForComposerDraftsLoaded();
        await writePersistedComposerState(
          appAtomRegistry.get(composerDraftsAtom),
          appAtomRegistry.get(stickyComposerModelSelectionAtom),
        );
        persistRetryNeeded = false;
      } catch (error) {
        // Failed debounces leave no timer; final flush must retry after reading persisted ownership.
        persistRetryNeeded = true;
        console.warn("[composer-drafts] failed to persist drafts", error);
      }
    });
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  const loading = loadPersistedComposerState().then((persisted) => {
    appAtomRegistry.set(composerCloudDraftsAtom, persisted.cloudDrafts);
    if (Object.keys(persisted.drafts).length > 0) {
      const current = appAtomRegistry.get(composerDraftsAtom);
      appAtomRegistry.set(composerDraftsAtom, {
        ...persisted.drafts,
        ...current,
      });
    }
    if (
      persisted.stickyModelSelection !== null &&
      appAtomRegistry.get(stickyComposerModelSelectionAtom) === null
    ) {
      appAtomRegistry.set(stickyComposerModelSelectionAtom, persisted.stickyModelSelection);
    }
    if (Object.keys(persisted.modelOptionMemory).length > 0) {
      const current = appAtomRegistry.get(modelOptionMemoryAtom);
      appAtomRegistry.set(modelOptionMemoryAtom, {
        ...persisted.modelOptionMemory,
        ...Object.fromEntries(
          Object.entries(current).map(([instanceId, models]) => [
            instanceId,
            { ...persisted.modelOptionMemory[instanceId], ...models },
          ]),
        ),
      });
    }
    appAtomRegistry.set(composerDraftsLoadedAtom, true);
  });
  loadPromise = loading;
  void loading.catch((cause) => {
    if (loadPromise === loading) loadPromise = null;
    console.warn(
      "[composer-drafts] failed to hydrate drafts",
      cause instanceof ComposerDraftPersistenceError
        ? cause
        : new ComposerDraftPersistenceError({
            operation: "hydrate",
            directory: COMPOSER_DRAFTS_DIRECTORY,
            fileName: COMPOSER_DRAFTS_FILE,
            cause,
          }),
    );
  });
}

export async function waitForComposerDraftsLoaded(): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
}

export function updateComposerDrafts(
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void {
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = update(current);
  if (next === current) {
    return;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerState();
}

export function cancelPendingComposerPersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export async function writeComposerDraftsNow(
  drafts: Record<string, ComposerDraft>,
): Promise<void> {
  await persistenceQueue.run(() =>
    writePersistedComposerState(drafts, appAtomRegistry.get(stickyComposerModelSelectionAtom)),
  );
}
