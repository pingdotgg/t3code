import { useAtomValue } from "@effect/atom-react";
import {
  ModelSelection as ModelSelectionSchema,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { writeFileAtomically } from "../lib/atomic-file";
import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import {
  composerAttachmentFileReferenceKey,
  isComposerAttachmentFileRetained,
  retainComposerAttachmentFile,
} from "../lib/composerAttachmentFiles";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../lib/composerImages";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import { flushThreadOutbox, threadOutboxManager } from "./thread-outbox";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const PERSIST_DEBOUNCE_MS = 200;

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
  stickyModelSelection: Schema.optional(ModelSelectionSchema),
});

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftsSchema,
);

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

export const stickyComposerModelSelectionAtom = Atom.make<ModelSelection | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:sticky-composer-model-selection"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const persistenceQueue = new SerializedAsyncQueue();

/** Resets module-level state between test runs. */
export function resetComposerDraftsLoadState(): void {
  loadPromise = null;
}

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function decodePersistedComposerState(value: unknown): {
  readonly drafts: Record<string, ComposerDraft>;
  readonly stickyModelSelection: ModelSelection | null;
} {
  const parsed = decodePersistedComposerDraftsDocument(value);
  return {
    drafts: Object.fromEntries(
      Object.entries(parsed.drafts)
        .map(
          ([key, draft]) =>
            [
              key,
              // Stale new-task drafts left on disk by builds before the
              // model-precedence fix carry a bare modelSelection with no
              // other selector settings. Strip it so the next compose pass
              // re-resolves project → sticky → provider defaults. Drafts
              // with runtime/interaction/workspace settings or actual text /
              // attachments were deliberately configured and are left alone.
              key.startsWith("new-task:") &&
              draft.modelSelection &&
              draft.text.length === 0 &&
              draft.attachments.length === 0 &&
              draft.runtimeMode === undefined &&
              draft.interactionMode === undefined &&
              draft.workspaceSelection === undefined
                ? { ...draft, modelSelection: undefined }
                : draft,
            ] as const,
        )
        // importedShareIds are share-import receipts: a contentless draft
        // carrying one is not empty, or the same native share would be
        // re-imported after restart.
        .filter(([, draft]) => !isEmptyDraft(draft) || (draft.importedShareIds?.length ?? 0) > 0),
    ),
    stickyModelSelection: parsed.stickyModelSelection ?? null,
  };
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  return decodePersistedComposerState(value).drafts;
}

async function getComposerDraftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, COMPOSER_DRAFTS_FILE);
}

async function loadPersistedComposerState(): Promise<{
  readonly drafts: Record<string, ComposerDraft>;
  readonly stickyModelSelection: ModelSelection | null;
}> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    if (!file.exists) {
      return { drafts: {}, stickyModelSelection: null };
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return decodePersistedComposerState(JSON.parse(raw) as unknown);
  } catch (cause) {
    console.warn(
      "[composer-drafts] ignored persisted draft failure",
      new ComposerDraftPersistenceError({
        operation,
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: COMPOSER_DRAFTS_FILE,
        cause,
      }),
    );
    return { drafts: {}, stickyModelSelection: null };
  }
}

async function writePersistedComposerState(
  drafts: Record<string, ComposerDraft>,
  stickyModelSelection: ModelSelection | null,
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

/**
 * Lands any debounced or in-flight draft write before the JS runtime is torn
 * down (app update restart), so the freshest draft state survives it. A write
 * failure propagates so the caller can decide whether the restart may proceed.
 */
export async function flushComposerDrafts(): Promise<void> {
  // Never land a pre-hydration snapshot: persisted state must merge into the
  // atoms first, or this write would clobber disk with partial data.
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  // An edit during an awaited write schedules another debounced write, so
  // keep landing snapshots until no debounce is pending after a queue drain.
  do {
    while (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await persistenceQueue.run(() =>
        writePersistedComposerState(
          appAtomRegistry.get(composerDraftsAtom),
          appAtomRegistry.get(stickyComposerModelSelectionAtom),
        ),
      );
    }
    // Draining also waits for an already-fired debounce whose write is still
    // gated behind its own hydration await inside the queue.
    await persistenceQueue.run(() => Promise.resolve());
  } while (persistTimer !== null);
}

function isComposerAttachmentFileReferenced(fileUri: string): boolean {
  if (isComposerAttachmentFileRetained(fileUri)) {
    return true;
  }
  const referenceKey = composerAttachmentFileReferenceKey(fileUri);
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.type === "file" &&
        composerAttachmentFileReferenceKey(attachment.fileUri) === referenceKey,
    ),
  );
}

function isComposerAttachmentUploadReferenced(
  environmentId: EnvironmentId,
  attachmentId: string,
): boolean {
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.type === "file" &&
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId === attachmentId,
    ),
  );
}

export async function releaseUnusedComposerAttachmentFiles(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<void> {
  const candidates = new Set(
    attachments
      .filter((attachment) => attachment.type === "file")
      .map((attachment) => attachment.fileUri),
  );
  const uploadCandidates = new Map<EnvironmentId, Set<string>>();
  for (const attachment of attachments) {
    if (
      attachment.type !== "file" ||
      attachment.uploadEnvironmentId === undefined ||
      attachment.uploadedAttachmentId === undefined
    ) {
      continue;
    }
    const ids = uploadCandidates.get(attachment.uploadEnvironmentId) ?? new Set<string>();
    ids.add(attachment.uploadedAttachmentId);
    uploadCandidates.set(attachment.uploadEnvironmentId, ids);
  }
  if (candidates.size === 0) {
    return;
  }

  // Persisted drafts must hydrate before the reference scan. On a cold start
  // the atom is still empty, and every file a persisted draft owns would look
  // unused. Hydrate before flushing so a pending pre-hydration write cannot
  // land an incomplete snapshot either.
  await waitForComposerDraftsLoaded();
  await flushComposerDrafts();
  if (!(await threadOutboxManager.load())) {
    // An unreadable outbox store must not look like an empty queue: deleting
    // now would take bytes a persisted queued message still needs. Skip the
    // sweep; the next one retries hydration.
    return;
  }
  await flushThreadOutbox();

  const allFilesReferenced = [...candidates].every(isComposerAttachmentFileReferenced);
  const allUploadsReferenced = [...uploadCandidates].every(([environmentId, attachmentIds]) =>
    [...attachmentIds].every((attachmentId) =>
      isComposerAttachmentUploadReferenced(environmentId, attachmentId),
    ),
  );
  if (allFilesReferenced && allUploadsReferenced) {
    return;
  }

  let incomingShareFileUris: ReadonlySet<string>;
  try {
    const { loadIncomingShareDrafts } = await import("../features/sharing/incoming-share-storage");
    const incomingShares = await loadIncomingShareDrafts({ strict: true });
    incomingShareFileUris = new Set(
      incomingShares.flatMap((share) =>
        share.attachments.flatMap((attachment) =>
          attachment.type === "file"
            ? [composerAttachmentFileReferenceKey(attachment.fileUri)]
            : [],
        ),
      ),
    );
  } catch (error) {
    console.warn("[composer-attachments] could not verify incoming share ownership", error);
    return;
  }

  const { removePersistedComposerAttachmentFile } = await import("../lib/composerImages");
  for (const fileUri of candidates) {
    // Re-check ownership immediately before each deletion: a restore or edit
    // can re-own a file after an earlier scan decided it was unused.
    if (
      isComposerAttachmentFileReferenced(fileUri) ||
      incomingShareFileUris.has(composerAttachmentFileReferenceKey(fileUri))
    ) {
      continue;
    }
    await removePersistedComposerAttachmentFile(fileUri);
  }

  if (uploadCandidates.size > 0) {
    const { releasePendingAttachmentUploads } = await import("../lib/attachmentUpload");
    for (const [environmentId, attachmentIds] of uploadCandidates) {
      for (const attachmentId of attachmentIds) {
        // A different draft or queued message can reuse the same pending
        // upload with another local URI. Re-check the server-side ownership
        // key immediately before deletion.
        if (isComposerAttachmentUploadReferenced(environmentId, attachmentId)) {
          continue;
        }
        try {
          await releasePendingAttachmentUploads(environmentId, [attachmentId]);
        } catch (error) {
          // The server expires stale pending uploads. Local discard must still
          // complete when the environment is disconnected or deletion fails.
          console.warn("[composer-attachments] could not remove pending upload", {
            environmentId,
            attachmentId,
            error,
          });
        }
      }
    }
  }
}

export function scheduleUnusedComposerAttachmentCleanup(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  if (!attachments.some((attachment) => attachment.type === "file")) {
    return;
  }
  void releaseUnusedComposerAttachmentFiles(attachments).catch((error) => {
    console.warn("[composer-attachments] could not remove unused files", error);
  });
}

/** Keeps previews usable after send/removal, then retries the normal ownership cleanup. */
export function retainComposerAttachmentFileForPreview(
  attachment: DraftComposerFileAttachment,
): () => void {
  return retainComposerAttachmentFile(attachment.fileUri, () => {
    scheduleUnusedComposerAttachmentCleanup([attachment]);
  });
}

function schedulePersistComposerState(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    ensureComposerDraftsLoaded();
    // The write enters the serialization queue before waiting on hydration,
    // so flushComposerDrafts' queue drain cannot resolve ahead of it.
    void persistenceQueue.run(async () => {
      if (loadPromise !== null) {
        await loadPromise;
      }
      try {
        await writePersistedComposerState(
          appAtomRegistry.get(composerDraftsAtom),
          appAtomRegistry.get(stickyComposerModelSelectionAtom),
        );
      } catch (error) {
        console.warn("[composer-drafts] failed to persist drafts", error);
        // Draft persistence is best-effort; in-memory drafts still keep working.
      }
    });
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = loadPersistedComposerState()
    .then((persisted) => {
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
    })
    .catch((cause) => {
      console.warn(
        "[composer-drafts] failed to hydrate drafts",
        new ComposerDraftPersistenceError({
          operation: "hydrate",
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: COMPOSER_DRAFTS_FILE,
          cause,
        }),
      );
      // Draft loading is best-effort; in-memory drafts still keep working.
    });
}

/** Wait until persisted drafts have been merged into the in-memory composer state. */
export async function waitForComposerDraftsLoaded(): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
}

function updateComposerDrafts(
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

export function setStickyComposerModelSelection(modelSelection: ModelSelection): void {
  appAtomRegistry.set(stickyComposerModelSelectionAtom, modelSelection);
  schedulePersistComposerState();
}

export function setComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

/**
 * Appends attachments to a draft, capped at the send limit against the draft's
 * live state (callers may have counted before an await; the picker can race
 * concurrent adds). Overflowed file attachments are released. Returns how many
 * were rejected. Restore paths pass allowOverflow so a failed send never drops
 * the message's own attachments.
 */
export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  options?: { readonly allowOverflow?: boolean },
): number {
  if (attachments.length === 0) {
    return 0;
  }
  let rejected: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const remaining = options?.allowOverflow
      ? attachments.length
      : Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existing.attachments.length);
    const accepted = attachments.slice(0, remaining);
    rejected = attachments.slice(remaining);
    if (accepted.length === 0) {
      return current;
    }
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...accepted],
      },
    };
  });
  scheduleUnusedComposerAttachmentCleanup(rejected);
  return rejected.length;
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
  const retainedIds = new Set(attachments.map((attachment) => attachment.id));
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => !retainedIds.has(attachment.id)),
  );
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => attachment.id === imageId),
  );
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
  },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const {
    importedShareIds: _importedShareIds,
    modelSelection,
    workspaceSelection,
    ...retained
  } = existing;
  const draft = {
    ...retained,
    ...(options?.clearModelSelection || modelSelection === undefined ? {} : { modelSelection }),
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft> {
  const next = { ...current };
  if (isEmptyDraft(snapshot)) {
    delete next[draftKey];
  } else {
    next[draftKey] = snapshot;
  }
  return next;
}

export function copyComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  sourceDraftKey: string,
  targetDraftKey: string,
): Record<string, ComposerDraft> {
  if (sourceDraftKey === targetDraftKey) {
    return current;
  }
  const source = normalizeDraft(current[sourceDraftKey]);
  const target = normalizeDraft(current[targetDraftKey]);
  const sourceHasContent =
    source.text.length > 0 ||
    source.attachments.length > 0 ||
    (source.importedShareIds?.length ?? 0) > 0;
  const targetHasContent =
    target.text.length > 0 ||
    target.attachments.length > 0 ||
    (target.importedShareIds?.length ?? 0) > 0;
  if (!sourceHasContent || targetHasContent) {
    return current;
  }
  return {
    ...current,
    [targetDraftKey]: {
      ...target,
      text: source.text,
      attachments: source.attachments,
      ...(source.importedShareIds ? { importedShareIds: source.importedShareIds } : {}),
    },
  };
}

export async function copyComposerDraftContentIfEmpty(
  sourceDraftKey: string,
  targetDraftKey: string,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  updateComposerDrafts((current) =>
    copyComposerDraftContentState(current, sourceDraftKey, targetDraftKey),
  );
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  // Import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId)) {
    return current;
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
      ...(importedShareIds ? { importedShareIds } : {}),
    },
  };
}

/**
 * Atomically moves an incoming share into a project-scoped composer draft.
 * The durable write happens before the share inbox item can be acknowledged.
 */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  // Publish the content and its import receipt together before the filesystem
  // await. Typing during persistence then builds on the receipt-bearing state,
  // and its debounced write is serialized after this transaction.
  if (next !== current) {
    appAtomRegistry.set(composerDraftsAtom, next);
  }
  await persistenceQueue.run(() =>
    writePersistedComposerState(next, appAtomRegistry.get(stickyComposerModelSelectionAtom)),
  );
  return { skippedAttachmentCount };
}

/** Restores the exact content/settings captured before an interrupted import. */
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() =>
    writePersistedComposerState(next, appAtomRegistry.get(stickyComposerModelSelectionAtom)),
  );
}

export function sameComposerDraftState(a: ComposerDraft, b: ComposerDraft): boolean {
  return (
    a.text === b.text &&
    a.attachments === b.attachments &&
    a.importedShareIds === b.importedShareIds &&
    a.modelSelection === b.modelSelection &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.workspaceSelection === b.workspaceSelection
  );
}

/**
 * Undoes an abandoned mergeComposerDraftContent. When the draft is untouched
 * since `merged` (the state captured right after the merge), the pre-merge
 * snapshot comes back exactly. When the user edited the draft during the
 * merge's awaits, only what the merge inserted (the appended text and the new
 * attachments) is taken back out, so the user's edits survive the rollback.
 */
export function undoComposerDraftMergeState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (sameComposerDraftState(existing, merged)) {
    return restoreComposerDraftSnapshotState(current, draftKey, snapshot);
  }
  const insertedText = merged.text.startsWith(snapshot.text)
    ? merged.text.slice(snapshot.text.length)
    : "";
  const snapshotAttachmentIds = new Set(snapshot.attachments.map((attachment) => attachment.id));
  const insertedAttachmentIds = new Set(
    merged.attachments
      .filter((attachment) => !snapshotAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id),
  );
  // A setting still holding the merge's value is the merge's doing: restore
  // the snapshot's. One the user changed since the merge stays theirs.
  const undoSetting = <
    K extends "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection",
  >(
    key: K,
  ): ComposerDraft[K] => (existing[key] === merged[key] ? snapshot[key] : existing[key]);
  const text =
    insertedText.length > 0 && existing.text.startsWith(merged.text)
      ? snapshot.text + existing.text.slice(merged.text.length)
      : insertedText.length > 0 && existing.text.endsWith(insertedText)
        ? existing.text.slice(0, existing.text.length - insertedText.length)
        : existing.text;
  const draft = {
    ...existing,
    text,
    attachments: existing.attachments.filter(
      (attachment) => !insertedAttachmentIds.has(attachment.id),
    ),
    modelSelection: undoSetting("modelSelection"),
    runtimeMode: undoSetting("runtimeMode"),
    interactionMode: undoSetting("interactionMode"),
    workspaceSelection: undoSetting("workspaceSelection"),
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

/** Applies undoComposerDraftMergeState and lands it durably. */
export async function undoComposerDraftMerge(
  draftKey: string,
  snapshot: ComposerDraft,
  merged: ComposerDraft,
): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = undoComposerDraftMergeState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
    merged,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() =>
    writePersistedComposerState(next, appAtomRegistry.get(stickyComposerModelSelectionAtom)),
  );
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: {
    readonly clearModelSelection?: boolean;
    readonly clearWorkspaceSelection?: boolean;
    // Send clears the draft while the durable outbox write is still in
    // flight. Sweeping then would race the write: a failed enqueue rolls the
    // message out of the queue mid-sweep and its files get deleted right
    // before the failure handler restores them. The sender re-schedules
    // cleanup once the write settles.
    readonly deferAttachmentCleanup?: boolean;
  },
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey, options));
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
}

export function clearComposerDraft(
  draftKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
  if (!options?.deferAttachmentCleanup) {
    scheduleUnusedComposerAttachmentCleanup(previousAttachments);
  }
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }

  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = removeComposerDraftsForEnvironment(current, environmentId);
  const removedAttachments = Object.entries(current)
    .filter(([draftKey]) => next[draftKey] === undefined)
    .flatMap(([, draft]) => draft.attachments);

  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() =>
    writePersistedComposerState(next, appAtomRegistry.get(stickyComposerModelSelectionAtom)),
  );
  await releaseUnusedComposerAttachmentFiles(removedAttachments);
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}

export function useStickyComposerModelSelection(): ModelSelection | null {
  const selection = useAtomValue(stickyComposerModelSelectionAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return selection;
}
