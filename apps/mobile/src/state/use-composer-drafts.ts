import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId as EnvironmentIdSchema,
  ModelSelection as ModelSelectionSchema,
  ComposerContextId,
  ComposerContextRecord,
  COMPOSER_CONTEXT_MAX_RECORDS,
  ForwardCompatibleArray,
  OrchestrationMessageContext,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectId as ProjectIdSchema,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  ProviderOptionSelection as ProviderOptionSelectionSchema,
  RuntimeMode as RuntimeModeSchema,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { draftModelPickMatchesThread } from "@t3tools/shared/model";

import { writeFileAtomically } from "../lib/atomic-file";
import { createComposerContextHistory, referencedComposerContext } from "../lib/composerContext";
import { isQueuedEditDraftKey } from "./queued-edit-draft-key";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import {
  composerAttachmentFileReferenceKey,
  isComposerAttachmentFileRetained,
} from "../lib/composerAttachmentFiles";
import {
  registerComposerAttachmentUnusedHandler,
  retainComposerAttachmentFileForPreview,
} from "../lib/composerAttachmentPreviewRetention";
import type { DraftComposerAttachment, FileBackedComposerAttachment } from "../lib/composerImages";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import {
  isNewTaskDraftKey,
  newTaskDraftKey,
  parseLegacyNewTaskDraftKey,
} from "./new-task-draft-key";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  QueuedThreadMessageSchema,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { flushThreadOutbox, threadOutboxManager } from "./thread-outbox";
import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const PERSIST_DEBOUNCE_MS = 200;

export const composerContextImportsAtom = Atom.make<Record<string, boolean>>({}).pipe(
  Atom.keepAlive,
);

export function setComposerContextImporting(draftKey: string, importing: boolean): void {
  const next = { ...appAtomRegistry.get(composerContextImportsAtom) };
  if (importing) next[draftKey] = true;
  else delete next[draftKey];
  appAtomRegistry.set(composerContextImportsAtom, next);
}

let lastComposerSelection: { draftKey: string; text: string; start: number; end: number } | null =
  null;

export function rememberComposerDraftSelection(
  draftKey: string,
  text: string,
  selection: { start: number; end: number },
): void {
  lastComposerSelection = { draftKey, text, ...selection };
}

/**
 * Inserting a chip moves the caret past it here; without reading this back the editor would
 * restore the pre-insert offset and leave the caret sitting before the chip the user just
 * added.
 */
export function readComposerDraftSelection(
  draftKey: string,
  text: string,
): { start: number; end: number } | null {
  if (lastComposerSelection?.draftKey !== draftKey || lastComposerSelection.text !== text) {
    return null;
  }
  return { start: lastComposerSelection.start, end: lastComposerSelection.end };
}

export interface ComposerDraftInsertion {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function captureComposerDraftInsertion(
  draftKey: string,
  selection?: { start: number; end: number },
): ComposerDraftInsertion {
  const { text } = getComposerDraftSnapshot(draftKey);
  return {
    text,
    ...(selection ??
      readComposerDraftSelection(draftKey, text) ?? { start: text.length, end: text.length }),
  };
}

function contextInsertionRange(
  draftKey: string,
  draft: ComposerDraft,
  target?: ComposerDraftInsertion,
) {
  const captured =
    target ?? (lastComposerSelection?.draftKey === draftKey ? lastComposerSelection : null);
  // Edits made during a file write must not be replaced using stale offsets. A changed
  // draft receives the file at its end; moving only the caret preserves the captured range.
  const selection = captured?.text === draft.text ? captured : null;
  const start = Math.max(0, Math.min(selection?.start ?? draft.text.length, draft.text.length));
  return { start, end: Math.max(start, Math.min(selection?.end ?? start, draft.text.length)) };
}

function draftWithoutInsertionSelection(
  draftKey: string,
  draft: ComposerDraft,
  target?: ComposerDraftInsertion,
) {
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const text = `${draft.text.slice(0, start)} ${draft.text.slice(end)}`;
  return withReferencedContextFiles(draft, text, referencedComposerContext(text, draft.context));
}

export function countComposerDraftAttachmentsAfterSelection(
  draftKey: string,
  target: ComposerDraftInsertion,
): number {
  return getComposerDraftAfterSelection(draftKey, target).attachments.length;
}

export function getComposerDraftAfterSelection(
  draftKey: string,
  target: ComposerDraftInsertion,
): ComposerDraft {
  return draftWithoutInsertionSelection(draftKey, getComposerDraftSnapshot(draftKey), target);
}

function withReferencedContextFiles(
  draft: ComposerDraft,
  text: string,
  context: OrchestrationMessageContext | undefined,
): ComposerDraft {
  const previousIds = new Set(
    draft.context?.records.flatMap((record) =>
      "attachmentId" in record ? [record.attachmentId] : [],
    ),
  );
  const retainedIds = new Set(
    context?.records.flatMap((record) => ("attachmentId" in record ? [record.attachmentId] : [])),
  );
  const attachments = draft.attachments.filter(
    (attachment) =>
      attachment.type === "image" ||
      !previousIds.has(attachment.id) ||
      retainedIds.has(attachment.id),
  );
  // Keep the array identity on plain text edits so attachment readers see no change.
  return {
    ...draft,
    text,
    context,
    attachments: attachments.length === draft.attachments.length ? draft.attachments : attachments,
  };
}

/** Retains file bytes while native text undo can restore their references. */
export function createComposerDraftContextHistory() {
  const restoreContext = createComposerContextHistory();
  const files = new Map<
    string,
    { attachment: FileBackedComposerAttachment; release: () => void }
  >();
  return {
    restore(text: string, draft: ComposerDraft) {
      for (const attachment of draft.attachments) {
        if (attachment.type !== "file") continue;
        const previous = files.get(attachment.id);
        files.delete(attachment.id);
        if (previous?.attachment.fileUri === attachment.fileUri) {
          previous.attachment = attachment;
          files.set(attachment.id, previous);
        } else {
          previous?.release();
          files.set(attachment.id, {
            attachment,
            release: retainComposerAttachmentFileForPreview(attachment),
          });
        }
      }
      const limit = Math.max(COMPOSER_CONTEXT_MAX_RECORDS, draft.attachments.length);
      while (files.size > limit) {
        const oldest = files.keys().next().value!;
        files.get(oldest)!.release();
        files.delete(oldest);
      }
      const context = restoreContext(text, draft.context);
      const liveIds = new Set(draft.attachments.map((attachment) => attachment.id));
      const attachments = (context?.records ?? []).flatMap((record) => {
        if (
          record.kind !== "file" ||
          !("attachmentId" in record) ||
          liveIds.has(record.attachmentId)
        )
          return [];
        const saved = files.get(record.attachmentId)?.attachment;
        liveIds.add(record.attachmentId);
        return saved
          ? [{ ...saved, uploadedAttachmentId: undefined, uploadEnvironmentId: undefined }]
          : [];
      });
      return { context, attachments };
    },
    dispose() {
      for (const file of files.values()) file.release();
      files.clear();
    },
  };
}

export function setComposerDraftContext(
  draftKey: string,
  context: OrchestrationMessageContext | undefined,
): void {
  updateComposerDrafts((current) => ({
    ...current,
    [draftKey]: { ...normalizeDraft(current[draftKey]), context },
  }));
}

export function insertComposerDraftContext(
  draftKey: string,
  content: {
    text: string;
    context: OrchestrationMessageContext;
    attachments?: ReadonlyArray<DraftComposerAttachment>;
  },
  target?: ComposerDraftInsertion,
): boolean {
  let inserted = false;
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const draft = normalizeDraft(current[draftKey]);
    const attachments = content.attachments ?? [];
    const retained = draftWithoutInsertionSelection(draftKey, draft, target);
    if (
      attachments.length > 0 &&
      retained.attachments.length + attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    )
      return current;
    const nextDraft = draftWithInsertedContext(
      draftKey,
      { ...draft, attachments: [...draft.attachments, ...attachments] },
      content,
      target,
    );
    if (!nextDraft) return current;
    inserted = true;
    removed = draft.attachments.filter((attachment) => !nextDraft.attachments.includes(attachment));
    return { ...current, [draftKey]: nextDraft };
  });
  scheduleUnusedComposerAttachmentCleanup(inserted ? removed : (content.attachments ?? []));
  return inserted;
}

function draftWithInsertedContext(
  draftKey: string,
  draft: ComposerDraft,
  content: { text: string; context: OrchestrationMessageContext },
  target?: ComposerDraftInsertion,
): ComposerDraft | null {
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const before = draft.text.slice(0, start);
  const after = draft.text.slice(end);
  const insertion = `${before.length > 0 && !/\s$/.test(before) && !/^\s/.test(content.text) ? " " : ""}${content.text}${!/\s$/.test(content.text) && (after.length === 0 || !/^\s/.test(after)) ? " " : ""}`;
  const text = before + insertion + after;
  const records = new Map(draft.context?.records.map((record) => [record.contextId, record]));
  for (const record of content.context.records) records.set(record.contextId, record);
  const context = referencedComposerContext(text, { version: 1, records: [...records.values()] });
  if ((context?.records.length ?? 0) > COMPOSER_CONTEXT_MAX_RECORDS) return null;
  lastComposerSelection = {
    draftKey,
    text,
    start: start + insertion.length,
    end: start + insertion.length,
  };
  return withReferencedContextFiles(draft, text, context);
}

export class ComposerDraftPersistenceError extends Schema.TaggedError<ComposerDraftPersistenceError>()(
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
  readonly context?: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
  readonly project?: ComposerDraftProject;
}

export interface ComposerDraftProject {
  readonly spaceId?: string | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly createdAt: string;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
  readonly pullRequestReference?: string;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection" | "project"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
  pullRequestReference: Schema.optional(Schema.String),
});

const ComposerDraftProjectSchema = Schema.Struct({
  spaceId: Schema.optional(Schema.NullOr(Schema.String)),
  environmentId: EnvironmentIdSchema,
  projectId: ProjectIdSchema,
  createdAt: Schema.String,
});

// Recovery can merge two individually valid drafts beyond the send limit, just like
// attachments. Keep every payload reloadable; send guards ask the user to trim the draft.
const PersistedComposerContextSchema = Schema.Struct({
  version: Schema.Literal(1),
  records: ForwardCompatibleArray(ComposerContextRecord),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  context: Schema.optional(PersistedComposerContextSchema),
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
  project: Schema.optional(ComposerDraftProjectSchema),
});

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
  stickyModelSelection: Schema.optional(ModelSelectionSchema),
  modelOptionMemory: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Array(ProviderOptionSelectionSchema)),
    ),
  ),
  cloudAccountId: Schema.optional(Schema.String),
  signedOutDrafts: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        drafts: Schema.Record(Schema.String, ComposerDraftSchema),
        queuedMessages: Schema.Array(QueuedThreadMessageSchema),
      }),
    ),
  ),
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

export type ModelOptionMemoryState = Readonly<
  Record<string, Readonly<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
>;

export const modelOptionMemoryAtom = Atom.make<ModelOptionMemoryState>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:model-option-memory"),
);

interface SignedOutDrafts {
  readonly drafts: Record<string, ComposerDraft>;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
}

interface ComposerCloudDraftState {
  readonly accountId: string | null;
  readonly signedOut: Record<string, SignedOutDrafts>;
}

export const composerCloudDraftsAtom = Atom.make<ComposerCloudDraftState>({
  accountId: null,
  signedOut: {},
}).pipe(Atom.keepAlive);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistRetryNeeded = false;
const persistenceQueue = new SerializedAsyncQueue();

export function resetComposerDraftsLoadState(): void {
  loadPromise = null;
  persistRetryNeeded = false;
}

function attachmentContextRecord(
  attachment: DraftComposerAttachment,
  contextId = ComposerContextId.make(attachment.id),
) {
  const common = {
    version: 1 as const,
    contextId,
    label: sanitizeComposerContextLabel(attachment.name, attachment.type),
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  // A picture picked through the document picker is typed as a plain file, but the
  // record has to say what it is or no client will offer to open it as an image.
  return attachment.type === "image" || imageMimeType(attachment) !== null
    ? { ...common, kind: "image" as const }
    : { ...common, kind: "file" as const };
}

function restoreMissingComposerFileReferences(
  draft: ComposerDraft,
  attachments = draft.attachments,
): ComposerDraft {
  const records = [...(draft.context?.records ?? [])];
  const usedIds = new Set<string>(records.map((record) => record.contextId));
  const referenced = new Set(
    collectComposerContextReferences(draft.text).map(
      (reference) => `${reference.kind}:${reference.contextId}`,
    ),
  );
  let text = draft.text;
  let changed = false;
  for (const attachment of attachments) {
    if (
      attachment.type === "image" ||
      imageMimeType(attachment) !== null ||
      videoMimeType(attachment) !== null
    )
      continue;
    let record = records.find(
      (candidate) =>
        candidate.kind === "file" &&
        "attachmentId" in candidate &&
        candidate.attachmentId === attachment.id,
    );
    if (!record) {
      const baseId = attachment.id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 110) || "file";
      let contextId = baseId;
      for (let suffix = 2; usedIds.has(contextId); suffix += 1) contextId = `${baseId}_${suffix}`;
      usedIds.add(contextId);
      record = attachmentContextRecord(attachment, ComposerContextId.make(contextId));
      records.push(record);
      changed = true;
    }
    const key = `${record.kind}:${record.contextId}`;
    if (referenced.has(key)) continue;
    text += `${text.length > 0 && !/\s$/.test(text) ? " " : ""}${formatComposerContextReference(record)} `;
    referenced.add(key);
    changed = true;
  }
  return changed ? { ...draft, text, context: { version: 1, records } } : draft;
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

function withComposerDraft(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  draft: ComposerDraft,
): Record<string, ComposerDraft> {
  if (isEmptyDraft(draft) && draft.project === undefined) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return { ...current, [draftKey]: draft };
}

export { isNewTaskDraftKey, newTaskDraftKey } from "./new-task-draft-key";

function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function migrateLegacyNewTaskDraft(
  key: string,
  draft: ComposerDraft,
  now: string,
): readonly [key: string, draft: ComposerDraft] {
  const restored = restoreMissingComposerFileReferences(draft);
  const legacy = draft.project === undefined ? parseLegacyNewTaskDraftKey(key) : null;
  if (legacy === null) {
    return [key, restored];
  }
  return [
    newTaskDraftKey(newDraftId()),
    {
      ...restored,
      project: {
        environmentId: EnvironmentIdSchema.make(legacy.environmentId),
        projectId: ProjectIdSchema.make(legacy.projectId),
        createdAt: now,
      },
    },
  ];
}

export function decodePersistedComposerState(value: unknown): {
  readonly drafts: Record<string, ComposerDraft>;
  readonly stickyModelSelection: ModelSelection | null;
  readonly modelOptionMemory: ModelOptionMemoryState;
  readonly cloudDrafts: ComposerCloudDraftState;
} {
  const parsed = decodePersistedComposerDraftsDocument(value);
  const now = new Date().toISOString();
  return {
    drafts: Object.fromEntries(
      Object.entries(parsed.drafts)
        .map(([key, draft]) =>
          migrateLegacyNewTaskDraft(
            key,
            isNewTaskDraftKey(key) &&
              draft.modelSelection &&
              draft.text.length === 0 &&
              draft.attachments.length === 0 &&
              draft.runtimeMode === undefined &&
              draft.interactionMode === undefined &&
              draft.workspaceSelection === undefined
              ? { ...draft, modelSelection: undefined }
              : draft,
            now,
          ),
        )
        // importedShareIds are share-import receipts: a contentless draft
        // carrying one is not empty, or the same native share would be
        // re-imported after restart.
        .filter(([, draft]) => !isEmptyDraft(draft) || (draft.importedShareIds?.length ?? 0) > 0)
        // Queued-message edits are in-memory sessions. Their draft outlives a
        // restart on disk, but the edit record that says which run it belongs
        // to does not, so the draft would be unreachable and invisible.
        .filter(([key]) => !isQueuedEditDraftKey(key)),
    ),
    stickyModelSelection: parsed.stickyModelSelection ?? null,
    modelOptionMemory: parsed.modelOptionMemory ?? {},
    cloudDrafts: {
      accountId: parsed.cloudAccountId ?? null,
      signedOut: Object.fromEntries(
        Object.entries(parsed.signedOutDrafts ?? {}).map(([id, saved]) => [
          id,
          {
            drafts: Object.fromEntries(
              Object.entries(saved.drafts).map(([key, draft]) =>
                migrateLegacyNewTaskDraft(key, draft, now),
              ),
            ),
            queuedMessages: saved.queuedMessages.map(decodeQueuedThreadMessage),
          },
        ]),
      ),
    },
  };
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

/**
 * A write failure propagates so the caller can decide whether the restart may
 * proceed.
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
    // Draining also waits for an already-fired debounce whose write is still
    // gated behind its own hydration await inside the queue.
    await persistenceQueue.run(() => Promise.resolve());
  } while (persistTimer !== null || persistRetryNeeded);
}

function signedOutAttachmentOwners() {
  return Object.values(appAtomRegistry.get(composerCloudDraftsAtom).signedOut).flatMap((saved) => [
    ...Object.values(saved.drafts),
    ...saved.queuedMessages,
  ]);
}

export function findLocalComposerClipboardAttachment(
  environmentId: EnvironmentId,
  id: string,
): DraftComposerAttachment | undefined {
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
    if (composerDraftEnvironmentId(key, queuedMessages, draft) !== environmentId) continue;
    const attachment = draft.attachments.find((entry) => entry.id === id);
    if (attachment) return attachment;
  }
  return queuedMessages
    .filter((message) => message.environmentId === environmentId)
    .flatMap((message) => message.attachments)
    .find((attachment) => attachment.id === id);
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
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.fileUri !== undefined &&
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
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId === attachmentId,
    ),
  );
}

export async function releaseUnusedComposerAttachmentFiles(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<void> {
  const candidates = new Set(
    attachments.flatMap((attachment) =>
      attachment.fileUri !== undefined ? [attachment.fileUri] : [],
    ),
  );
  const uploadCandidates = new Map<EnvironmentId, Set<string>>();
  for (const attachment of attachments) {
    if (
      attachment.uploadEnvironmentId === undefined ||
      attachment.uploadedAttachmentId === undefined
    ) {
      continue;
    }
    const ids = uploadCandidates.get(attachment.uploadEnvironmentId) ?? new Set<string>();
    ids.add(attachment.uploadedAttachmentId);
    uploadCandidates.set(attachment.uploadEnvironmentId, ids);
  }
  if (candidates.size === 0 && uploadCandidates.size === 0) {
    return;
  }

  // Persisted drafts must hydrate before the reference scan. On a cold start
  // the atom is still empty, and every file a persisted draft owns would look
  // unused.
  await waitForComposerDraftsLoaded();
  await flushComposerDrafts();
  if (!(await threadOutboxManager.load())) {
    // An unreadable outbox store must not look like an empty queue: deleting
    // now would take bytes a persisted queued message still needs.
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
          attachment.fileUri !== undefined
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
  if (
    !attachments.some(
      (attachment) =>
        attachment.fileUri !== undefined || attachment.uploadedAttachmentId !== undefined,
    )
  ) {
    return;
  }
  void releaseUnusedComposerAttachmentFiles(attachments).catch((error) => {
    console.warn("[composer-attachments] could not remove unused files", error);
  });
}

registerComposerAttachmentUnusedHandler((attachment) => {
  scheduleUnusedComposerAttachmentCleanup([attachment]);
});

export function schedulePersistComposerState(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // The write enters the serialization queue before waiting on hydration,
    // so flushComposerDrafts' queue drain cannot resolve ahead of it.
    void persistenceQueue.run(async () => {
      try {
        await waitForComposerDraftsLoaded();
        await writePersistedComposerState(
          appAtomRegistry.get(composerDraftsAtom),
          appAtomRegistry.get(stickyComposerModelSelectionAtom),
        );
        persistRetryNeeded = false;
      } catch (error) {
        // A failed debounce has no timer left. A later final flush must retry
        // these edits after persisted ownership can be read safely.
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
            { ...(persisted.modelOptionMemory[instanceId] ?? {}), ...models },
          ]),
        ),
      });
    }
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

export async function getComposerCloudAccountId(): Promise<string | null> {
  await waitForComposerDraftsLoaded();
  return appAtomRegistry.get(composerCloudDraftsAtom).accountId;
}

export async function archiveCloudComposerDrafts(
  accountId: string | null,
  environmentIds: ReadonlySet<EnvironmentId>,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  if (!(await threadOutboxManager.load())) throw new Error("Could not preserve queued messages.");
  await flushThreadOutbox();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const owner = accountId ?? cloud.accountId;
  if (owner === null) return;
  const queued = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  const current = appAtomRegistry.get(composerDraftsAtom);
  const remaining = { ...current };
  const savedDrafts = { ...cloud.signedOut[owner]?.drafts };
  for (const [key, draft] of Object.entries(current)) {
    const environmentId = composerDraftEnvironmentId(key, queued, draft);
    if (environmentId !== null && environmentIds.has(environmentId)) {
      savedDrafts[key] = draft;
      delete remaining[key];
    }
  }
  const savedMessages = new Map(
    (cloud.signedOut[owner]?.queuedMessages ?? []).map((message) => [message.messageId, message]),
  );
  for (const message of queued) {
    if (environmentIds.has(message.environmentId)) savedMessages.set(message.messageId, message);
  }
  appAtomRegistry.set(composerDraftsAtom, remaining);
  appAtomRegistry.set(composerCloudDraftsAtom, {
    // Keep the owner through removal. A crash or failed cleanup can retry it
    // on cold start before a different account activates.
    accountId: owner,
    signedOut: {
      ...cloud.signedOut,
      [owner]: { drafts: savedDrafts, queuedMessages: [...savedMessages.values()] },
    },
  });
  schedulePersistComposerState();
  await flushComposerDrafts();
}

function sameDraftAttachmentIds(
  left: ReadonlyArray<DraftComposerAttachment>,
  right: ReadonlyArray<DraftComposerAttachment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

/** An in-flight delivery can finish after sign-out took its snapshot. */
export async function removeDeliveredCloudQueuedMessage(
  message: QueuedThreadMessage,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const signedOut = { ...cloud.signedOut };
  let changed = false;
  for (const [accountId, saved] of Object.entries(signedOut)) {
    const archived = saved.queuedMessages.find(
      (candidate) =>
        candidate.environmentId === message.environmentId &&
        candidate.messageId === message.messageId,
    );
    if (
      !archived ||
      archived.commandId !== message.commandId ||
      archived.threadId !== message.threadId ||
      archived.text !== message.text ||
      !sameDraftAttachmentIds(archived.attachments, message.attachments)
    )
      continue;
    if (
      JSON.stringify([
        archived.modelSelection,
        archived.runtimeMode,
        archived.interactionMode,
        archived.creation,
      ]) !==
      JSON.stringify([
        message.modelSelection,
        message.runtimeMode,
        message.interactionMode,
        message.creation,
      ])
    )
      continue;
    const editorKey = `pending-task:${message.messageId}`;
    const editor = saved.drafts[editorKey];
    if (
      editor &&
      (editor.text !== message.text ||
        !sameDraftAttachmentIds(editor.attachments, message.attachments) ||
        (editor.modelSelection !== undefined &&
          JSON.stringify(editor.modelSelection) !== JSON.stringify(message.modelSelection)) ||
        (editor.runtimeMode !== undefined && editor.runtimeMode !== message.runtimeMode) ||
        (editor.interactionMode !== undefined &&
          editor.interactionMode !== message.interactionMode) ||
        (editor.workspaceSelection !== undefined &&
          (editor.workspaceSelection.mode !== message.creation?.workspaceMode ||
            editor.workspaceSelection.branch !== message.creation?.branch ||
            editor.workspaceSelection.worktreePath !== message.creation?.worktreePath ||
            editor.workspaceSelection.pullRequestReference !==
              message.creation?.pullRequestReference ||
            (editor.workspaceSelection.startFromOrigin ?? false) !==
              (message.creation?.startFromOrigin ?? false))))
    )
      continue;
    const drafts = { ...saved.drafts };
    delete drafts[editorKey];
    signedOut[accountId] = {
      drafts,
      queuedMessages: saved.queuedMessages.filter((candidate) => candidate !== archived),
    };
    changed = true;
  }
  if (!changed) return;
  appAtomRegistry.set(composerCloudDraftsAtom, { ...cloud, signedOut });
  schedulePersistComposerState();
  try {
    await flushComposerDrafts();
  } catch (error) {
    // The live outbox can still remove this acknowledged message. Keep the
    // archive update pending so a later successful flush lands it too.
    schedulePersistComposerState();
    throw error;
  }
}

export async function restoreCloudComposerDrafts(accountId: string): Promise<void> {
  await waitForComposerDraftsLoaded();
  const cloud = appAtomRegistry.get(composerCloudDraftsAtom);
  const saved = cloud.signedOut[accountId];
  if (saved) {
    if (!(await threadOutboxManager.load())) throw new Error("Could not restore queued messages.");
    for (const message of saved.queuedMessages) {
      const alreadyQueued = Object.values(
        appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      )
        .flat()
        .some((current) => current.messageId === message.messageId);
      if (!alreadyQueued) await threadOutboxManager.enqueue(message);
    }
    updateComposerDrafts((current) => {
      const restored = { ...current };
      for (const [key, draft] of Object.entries(saved.drafts)) {
        const existing = current[key];
        const attachmentIds = new Set(existing?.attachments.map((attachment) => attachment.id));
        restored[key] = existing
          ? {
              ...draft,
              ...existing,
              text: mergeComposerDraftText(existing.text, draft.text),
              context: mergeReferencedComposerContext(
                mergeComposerDraftText(existing.text, draft.text),
                draft.context,
                existing.context,
              ),
              // A concurrent import must not lose files, even above the send limit.
              attachments: [
                ...existing.attachments,
                ...draft.attachments.filter((attachment) => !attachmentIds.has(attachment.id)),
              ],
              importedShareIds: [
                ...new Set([
                  ...(existing.importedShareIds ?? []),
                  ...(draft.importedShareIds ?? []),
                ]),
              ],
            }
          : draft;
      }
      return restored;
    });
  }
  const signedOut = { ...cloud.signedOut };
  delete signedOut[accountId];
  appAtomRegistry.set(composerCloudDraftsAtom, { accountId, signedOut });
  schedulePersistComposerState();
  await flushComposerDrafts();
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
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const context = referencedComposerContext(value, existing.context);
    const draft = withReferencedContextFiles(existing, value, context);
    removed = existing.attachments.filter((attachment) => !draft.attachments.includes(attachment));
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(removed);
}

export function insertComposerDraftText(
  draftKey: string,
  value: string,
  target: ComposerDraftInsertion,
): void {
  const draft = getComposerDraftSnapshot(draftKey);
  const { start, end } = contextInsertionRange(draftKey, draft, target);
  const text = draft.text.slice(0, start) + value + draft.text.slice(end);
  setComposerDraftText(draftKey, text);
  rememberComposerDraftSelection(draftKey, text, {
    start: start + value.length,
    end: start + value.length,
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
 * Restore paths pass allowOverflow so a failed send never drops the message's
 * own attachments.
 */
export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
  options?: {
    readonly allowOverflow?: boolean;
    readonly appendReference?: boolean;
    readonly insertion?: ComposerDraftInsertion;
    readonly maxAttachments?: number;
  },
): number {
  if (attachments.length === 0) {
    return 0;
  }
  let rejected: ReadonlyArray<DraftComposerAttachment> = [];
  let removed: ReadonlyArray<DraftComposerAttachment> = [];
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const retained = options?.appendReference
      ? draftWithoutInsertionSelection(draftKey, existing, options.insertion)
      : existing;
    const remaining = options?.allowOverflow
      ? attachments.length
      : Math.max(
          0,
          Math.min(
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
            options?.maxAttachments ?? PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
          ) - retained.attachments.length,
        );
    const contextCapacity = options?.appendReference
      ? Math.max(0, COMPOSER_CONTEXT_MAX_RECORDS - (retained.context?.records.length ?? 0))
      : attachments.length;
    const accepted = attachments.slice(0, Math.min(remaining, contextCapacity));
    rejected = attachments.slice(accepted.length);
    if (accepted.length === 0) {
      return current;
    }
    let draft = { ...existing, attachments: [...existing.attachments, ...accepted] };
    if (options?.appendReference) {
      const records = accepted.map((attachment) => attachmentContextRecord(attachment));
      const inserted = draftWithInsertedContext(
        draftKey,
        draft,
        {
          text: records.map(formatComposerContextReference).join(" "),
          context: { version: 1, records },
        },
        options?.insertion,
      );
      if (!inserted) {
        rejected = attachments;
        return current;
      }
      draft = { ...inserted, attachments: [...inserted.attachments] };
      removed = existing.attachments.filter(
        (attachment) => !draft.attachments.includes(attachment),
      );
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
  scheduleUnusedComposerAttachmentCleanup([...rejected, ...removed]);
  return rejected.length;
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  const retainedIds = new Set(attachments.map((attachment) => attachment.id));
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const droppedContextIds = new Set(
      existing.context?.records
        .filter((record) => "attachmentId" in record && !retainedIds.has(record.attachmentId))
        .map((record) => record.contextId),
    );
    const text = replaceComposerContextReferences(existing.text, (ref) =>
      droppedContextIds.has(ref.contextId) ? "" : ref.source,
    );
    const draft = {
      ...existing,
      text,
      context: referencedComposerContext(text, existing.context),
      attachments,
    };
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => !retainedIds.has(attachment.id)),
  );
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  const previousAttachments = getComposerDraftSnapshot(draftKey).attachments;
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const removedIds = new Set(
      existing.context?.records
        .filter((record) => "attachmentId" in record && record.attachmentId === imageId)
        .map((record) => record.contextId),
    );
    const text = replaceComposerContextReferences(existing.text, (ref) =>
      removedIds.has(ref.contextId) ? "" : ref.source,
    );
    const draft = {
      ...existing,
      text,
      context: referencedComposerContext(text, existing.context),
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    return withComposerDraft(current, draftKey, draft);
  });
  scheduleUnusedComposerAttachmentCleanup(
    previousAttachments.filter((attachment) => attachment.id === imageId),
  );
}

export function setComposerDraftAttachmentUpload(
  draftKey: string,
  attachment: DraftComposerAttachment,
): boolean {
  let previous: DraftComposerAttachment | undefined;
  updateComposerDrafts((current) => {
    const draft = current[draftKey];
    previous = draft?.attachments.find((candidate) => candidate.id === attachment.id);
    if (!draft || !previous) return current;
    if (
      previous.uploadedAttachmentId === attachment.uploadedAttachmentId &&
      previous.uploadEnvironmentId === attachment.uploadEnvironmentId
    )
      return current;
    return {
      ...current,
      [draftKey]: {
        ...draft,
        attachments: draft.attachments.map((candidate) =>
          candidate.id === attachment.id
            ? {
                ...candidate,
                uploadedAttachmentId: attachment.uploadedAttachmentId,
                uploadEnvironmentId: attachment.uploadEnvironmentId,
              }
            : candidate,
        ),
      },
    };
  });
  if (previous) scheduleUnusedComposerAttachmentCleanup([previous]);
  return previous !== undefined;
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
    return withComposerDraft(current, draftKey, draft);
  });
}

export function subscribeComposerDraftModelReconciliation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>;
}): () => void {
  const draftsAtom = Atom.make(appAtomRegistry.get(composerDraftsAtom));
  const unsubscribeDrafts = appAtomRegistry.subscribe(composerDraftsAtom, (drafts) =>
    input.registry.set(draftsAtom, drafts),
  );
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const matchesAtom = Atom.make((get) => {
    const threadKeys = get(threadKeysAtom);
    const matches: Array<readonly [string, ComposerDraft]> = [];
    for (const [key, draft] of Object.entries(get(draftsAtom))) {
      if (!draft.modelSelection || isNewTaskDraftKey(key) || isQueuedEditDraftKey(key)) continue;
      const ref = parseScopedThreadKey(key);
      if (!ref || !threadKeys.has(key)) continue;
      const thread = get(input.threadShellAtom(ref));
      if (!thread || !draftModelPickMatchesThread(draft.modelSelection, thread.modelSelection))
        continue;
      // Status and selection must come from the same emission; derived atoms can update apart.
      const shell = Option.getOrNull(
        AsyncResult.value(get(input.shellStateAtom(ref.environmentId))),
      );
      if (shell?.status !== "live") continue;
      const authoritativeThread = Option.getOrNull(shell.snapshot)?.threads.find(
        (candidate) => candidate.id === ref.threadId,
      );
      if (
        authoritativeThread &&
        draftModelPickMatchesThread(draft.modelSelection, authoritativeThread.modelSelection)
      ) {
        matches.push([key, draft]);
      }
    }
    return matches;
  });
  const unsubscribeMatches = input.registry.subscribe(
    matchesAtom,
    (matches) => {
      if (matches.length === 0) return;
      updateComposerDrafts((current) => {
        let next = current;
        for (const [key, matchedDraft] of matches) {
          if (next[key] !== matchedDraft) continue;
          const { modelSelection: _modelSelection, ...draft } = matchedDraft;
          next = withComposerDraft(next, key, draft);
        }
        return next;
      });
    },
    { immediate: true },
  );
  return () => {
    unsubscribeMatches();
    unsubscribeDrafts();
  };
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
    context: _context,
    modelSelection,
    workspaceSelection,
    project: _project,
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

function stripAttachmentUploadReference(
  attachment: DraftComposerAttachment,
): DraftComposerAttachment {
  const { uploadedAttachmentId: _id, uploadEnvironmentId: _environmentId, ...rest } = attachment;
  return rest;
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

function mergeReferencedComposerContext(
  text: string,
  first?: OrchestrationMessageContext,
  second?: OrchestrationMessageContext,
) {
  const records = new Map((first?.records ?? []).map((record) => [record.contextId, record]));
  for (const record of second?.records ?? []) records.set(record.contextId, record);
  if (records.size === 0) return undefined;
  return referencedComposerContext(text, { version: 1, records: [...records.values()] });
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
  const context = mergeReferencedComposerContext(text, existing.context, content.context);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    content.context === undefined &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    // The composer shows non-image files only as inline chips, so a shared file
    // merged without one would be attached but invisible until sent. Other
    // merges carry their own text, and appending chips to it would defeat
    // mergeComposerDraftText's duplicate check on a retried merge.
    [draftKey]: restoreMissingComposerFileReferences(
      {
        ...existing,
        text,
        attachments,
        context,
        ...(importedShareIds ? { importedShareIds } : {}),
      },
      content.sourceShareId ? attachments.slice(existing.attachments.length) : [],
    ),
  };
}

/**
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
    a.context === b.context &&
    a.importedShareIds === b.importedShareIds &&
    a.modelSelection === b.modelSelection &&
    a.runtimeMode === b.runtimeMode &&
    a.interactionMode === b.interactionMode &&
    a.workspaceSelection === b.workspaceSelection
  );
}

/**
 * When the draft is untouched since `merged` (the state captured right after
 * the merge), the pre-merge snapshot comes back exactly. When the user edited
 * the draft during the merge's awaits, only what the merge inserted (the
 * appended text and the new attachments) is taken back out, so the user's edits
 * survive the rollback.
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
    context: referencedComposerContext(text, existing.context),
    attachments: existing.attachments.filter(
      (attachment) => !insertedAttachmentIds.has(attachment.id),
    ),
    modelSelection: undoSetting("modelSelection"),
    runtimeMode: undoSetting("runtimeMode"),
    interactionMode: undoSetting("interactionMode"),
    workspaceSelection: undoSetting("workspaceSelection"),
  };
  return withComposerDraft(current, draftKey, draft);
}

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
    // Send clears the draft while the durable outbox write is still in flight.
    // Sweeping then would race the write: a failed enqueue rolls the message
    // out of the queue mid-sweep and its files get deleted right before the
    // failure handler restores them.
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
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey, draft]) =>
        !draftKey.startsWith(environmentPrefix) && draft.project?.environmentId !== environmentId,
    ),
  );
}

export function createNewTaskDraft(project: {
  readonly spaceId?: string | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): string {
  const draftKey = newTaskDraftKey(newDraftId());
  const stamp: ComposerDraftProject = {
    ...(project.spaceId !== undefined ? { spaceId: project.spaceId } : {}),
    environmentId: project.environmentId,
    projectId: project.projectId,
    createdAt: new Date().toISOString(),
  };
  updateComposerDrafts((current) => ({
    ...current,
    [draftKey]: { ...EMPTY_DRAFT, project: stamp },
  }));
  return draftKey;
}

export function retargetNewTaskDraft(
  draftKey: string,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): void {
  updateComposerDrafts((current) => {
    const existing = current[draftKey];
    const stamp = existing?.project;
    if (
      stamp !== undefined &&
      stamp.environmentId === project.environmentId &&
      stamp.projectId === project.projectId
    ) {
      return current;
    }
    const { workspaceSelection: _workspaceSelection, ...retained } = normalizeDraft(existing);
    // Pending uploads live on one server. Crossing environments keeps the
    // local bytes (the upload worker re-sends them to the new environment)
    // but drops the old stamp, so it cannot pin the source environment's
    // pending upload alive from the moved draft.
    const attachments = retained.attachments.map((attachment) =>
      attachment.uploadEnvironmentId !== undefined &&
      attachment.uploadEnvironmentId !== project.environmentId
        ? stripAttachmentUploadReference(attachment)
        : attachment,
    );
    return {
      ...current,
      [draftKey]: {
        ...retained,
        attachments,
        project: {
          environmentId: project.environmentId,
          projectId: project.projectId,
          createdAt: stamp?.createdAt ?? new Date().toISOString(),
          ...(stamp?.spaceId !== undefined ? { spaceId: stamp.spaceId } : {}),
        },
      },
    };
  });
}

export function findNewTaskDraftKeys(
  drafts: Readonly<Record<string, ComposerDraft>>,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): ReadonlyArray<string> {
  return Object.entries(drafts)
    .filter(
      ([key, draft]) =>
        isNewTaskDraftKey(key) &&
        draft.project?.environmentId === project.environmentId &&
        draft.project.projectId === project.projectId,
    )
    .sort(([, left], [, right]) =>
      (right.project?.createdAt ?? "").localeCompare(left.project?.createdAt ?? ""),
    )
    .map(([key]) => key);
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

// One atom per draft key, so typing in one composer only notifies readers of
// that draft instead of every subscriber to the whole drafts map.
const composerDraftAtom = Atom.family((draftKey: string) =>
  Atom.make((get) => get(composerDraftsAtom)[draftKey] ?? EMPTY_DRAFT),
);
const EMPTY_DRAFT_ATOM = Atom.make(EMPTY_DRAFT);

type ComposerDraftsByKey = Readonly<Record<string, ComposerDraft>>;
const EMPTY_DRAFTS: ComposerDraftsByKey = {};
function sameDrafts(a: ComposerDraftsByKey, b: ComposerDraftsByKey): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
// The question drafts under one key prefix. Equal while only other drafts change
// (the open thread's composer text, for example), so typing does not notify readers.
export const questionAttachmentDraftsAtom = Atom.family((prefix: string) =>
  Atom.make((get): ComposerDraftsByKey => {
    if (prefix === "") return EMPTY_DRAFTS;
    const matching = Object.entries(get(composerDraftsAtom)).filter(([key]) =>
      key.startsWith(prefix),
    );
    return matching.length === 0 ? EMPTY_DRAFTS : Object.fromEntries(matching);
  }).pipe(Atom.withEquality(sameDrafts)),
);

// New-task drafts only; equal while a thread composer's text changes.
export const newTaskComposerDraftsAtom = Atom.make((get): ComposerDraftsByKey => {
  const matching = Object.entries(get(composerDraftsAtom)).filter(([key]) =>
    isNewTaskDraftKey(key),
  );
  return matching.length === 0 ? EMPTY_DRAFTS : Object.fromEntries(matching);
}).pipe(Atom.withEquality(sameDrafts));

type ComposerDraftUploadSource = Pick<ComposerDraft, "attachments" | "project">;
// What the upload worker reads: equal while only draft text changes.
type ComposerDraftUploadSources = Readonly<Record<string, ComposerDraftUploadSource>>;
export const composerDraftUploadSourcesAtom = Atom.make((get): ComposerDraftUploadSources =>
  Object.fromEntries(
    Object.entries(get(composerDraftsAtom)).map(([key, draft]) => [
      key,
      { attachments: draft.attachments, project: draft.project },
    ]),
  ),
).pipe(
  Atom.withEquality((a: ComposerDraftUploadSources, b: ComposerDraftUploadSources) => {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) => a[key]?.attachments === b[key]?.attachments && a[key]?.project === b[key]?.project,
      )
    );
  }),
);

type ComposerDraftSettings = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;
const EMPTY_DRAFT_SETTINGS: ComposerDraftSettings = {};
// Text edits copy the other fields by reference, so this stays equal while typing.
const composerDraftSettingsAtom = Atom.family((draftKey: string) =>
  Atom.make((get): ComposerDraftSettings => {
    const draft = get(composerDraftAtom(draftKey));
    return {
      modelSelection: draft.modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
    };
  }).pipe(
    Atom.withEquality(
      (a: ComposerDraftSettings, b: ComposerDraftSettings) =>
        a.modelSelection === b.modelSelection &&
        a.runtimeMode === b.runtimeMode &&
        a.interactionMode === b.interactionMode,
    ),
  ),
);
const EMPTY_DRAFT_SETTINGS_ATOM = Atom.make(EMPTY_DRAFT_SETTINGS);

export function useComposerDraftSettings(draftKey: string | null): ComposerDraftSettings {
  const settings = useAtomValue(
    draftKey ? composerDraftSettingsAtom(draftKey) : EMPTY_DRAFT_SETTINGS_ATOM,
  );
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return settings;
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const draft = useAtomValue(draftKey ? composerDraftAtom(draftKey) : EMPTY_DRAFT_ATOM);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draft;
}

export function useStickyComposerModelSelection(): ModelSelection | null {
  const selection = useAtomValue(stickyComposerModelSelectionAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return selection;
}
