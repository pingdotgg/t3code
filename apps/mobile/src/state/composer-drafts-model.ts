import {
  EnvironmentId as EnvironmentIdSchema,
  ModelSelection as ModelSelectionSchema,
  ProjectId as ProjectIdSchema,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  ProviderOptionSelection as ProviderOptionSelectionSchema,
  RuntimeMode as RuntimeModeSchema,
  ComposerContextId,
  ComposerContextRecord,
  ForwardCompatibleArray,
  type ModelSelection,
  type EnvironmentId,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { isQueuedEditDraftKey } from "./queued-edit-draft-key";
import { decodeQueuedThreadMessage, QueuedThreadMessageSchema, type QueuedThreadMessage } from "./thread-outbox-model";
import { isNewTaskDraftKey, newTaskDraftKey, parseLegacyNewTaskDraftKey } from "./new-task-draft-key";

export const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
export const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
export const COMPOSER_DRAFTS_FILE = "drafts.json";

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
  /**
   * Local mode chosen before refs named the current branch. It is never cleared when refs load:
   * a local task runs on the checkout, so the draft keeps following it (a later checkout change
   * included) until the user picks a branch, rather than pinning the first name refs reported.
   */
  readonly followsCurrentCheckout?: boolean;
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
  followsCurrentCheckout: Schema.optional(Schema.Boolean),
});

const ComposerDraftProjectSchema = Schema.Struct({
  environmentId: EnvironmentIdSchema,
  projectId: ProjectIdSchema,
  createdAt: Schema.String,
});

// Recovery can exceed send limits; keep payloads reloadable and let send guards request trimming.
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

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

/**
 * Whether persisted drafts have merged in. Hydration starts with the app's
 * attachment upload worker; a failed load stays false until the next
 * `ensureComposerDraftsLoaded` caller retries it.
 */
export const composerDraftsLoadedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts-loaded"),
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

export function attachmentContextRecord(
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
  // Document pickers label images as files; promote the record so every client can open them as images.
  return attachment.type === "image" || imageMimeType(attachment) !== null
    ? { ...common, kind: "image" as const }
    : { ...common, kind: "file" as const };
}

export function restoreMissingComposerFileReferences(
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

export function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
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

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function withComposerDraft(
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

export function newDraftId(): string {
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
        // Retain contentless drafts with import receipts to prevent re-importing native shares after restart.
        .filter(([, draft]) => !isEmptyDraft(draft) || (draft.importedShareIds?.length ?? 0) > 0)
        // Queued-edit sessions are memory-only; persisted drafts would outlive their run association and become unreachable.
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
