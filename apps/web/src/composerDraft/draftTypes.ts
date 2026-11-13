import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  ProviderOptionSelections,
  PreviewAnnotationPayloadSchema,
  PastedTextAttachmentSource,
  type PreviewAnnotationPayload,
  RuntimeMode,
  ThreadContextRecord,
  EnvironmentContextRecord,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  SnapShotSource,
} from "@t3tools/contracts";
import { type ChatFileAttachment, type ChatImageAttachment } from "../types";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { type ComposerContextReference } from "../lib/composerContextReferences";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "../reviewCommentContext";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 9;
export const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

export const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  source: Schema.optional(SnapShotSource),
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface ComposerFileAttachment extends Omit<ChatFileAttachment, "previewUrl"> {
  file: File | null;
  uploadedAttachmentId?: string;
  uploadEnvironmentId?: EnvironmentId;
}

export function composerFileNeedsReattach(file: ComposerFileAttachment): boolean {
  return file.file === null && file.uploadedAttachmentId === undefined;
}
export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.String,
  environmentId: EnvironmentId,
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerFileAttachment = typeof PersistedComposerFileAttachment.Type;

/** File handles cannot serialize; metadata-only markers hydrate as needs-reattach rows. */
export const PersistedComposerDraftFileAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  attachmentId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(EnvironmentId),
  source: Schema.optional(PastedTextAttachmentSource),
});
export type PersistedComposerDraftFileAttachment = typeof PersistedComposerDraftFileAttachment.Type;
export const isPersistedComposerDraftFileAttachment = Schema.is(PersistedComposerDraftFileAttachment);

export const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.optionalKey(Schema.String),
});
export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

export const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  files: Schema.optionalKey(Schema.Array(PersistedComposerDraftFileAttachment)),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
  threadContexts: Schema.optionalKey(Schema.Array(ThreadContextRecord)),
  environmentContexts: Schema.optionalKey(Schema.Array(EnvironmentContextRecord)),
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  modelSelectionExplicit: Schema.optionalKey(Schema.Boolean),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

export type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

export type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

export type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

export type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

export type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  environmentSelection: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  loadBalancedEnvironmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});
export type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

export const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyOptionsByModelByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, Schema.Record(Schema.String, ProviderOptionSelections)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export interface ComposerContextAddOptions {
  appendReference?: boolean;
  allowDuplicateReference?: boolean;
  /** `false` to append synchronously instead of asking a mounted editor for its current caret. */
  insertAtCaret?: boolean;
}
export type ComposerContextInsertionHandler = (
  references: ReadonlyArray<ComposerContextReference>,
) => boolean;
export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  threadContexts: ThreadContextRecord[];
  environmentContexts: EnvironmentContextRecord[];
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
  modelSelectionExplicit?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.threadContexts.length > 0 ||
    draft.environmentContexts.length > 0
  );
}

export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  environmentSelection?: "auto" | "manual";
  loadBalancedEnvironmentId?: EnvironmentId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

export interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

export type ComposerThreadTarget = ScopedThreadRef | DraftId;
export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  /**
   * Where each finalized draft went, so `/draft/<id>` keeps leading to its thread (Back, an
   * "Open draft" toast) after the draft is gone. In memory only, one small entry per sent draft.
   */
  promotedDraftRedirects: Record<string, ScopedThreadRef>;
  rewindingThreadKeys: ReadonlySet<string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyOptionsByModelByProvider: Partial<
    Record<ProviderInstanceId, Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
  >;
  stickyActiveProvider: ProviderInstanceId | null;
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftIdByRef: (threadRef: ScopedThreadRef) => DraftId | null;
  getPromotedDraftRedirect: (draftId: DraftId) => ScopedThreadRef | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      environmentSelection?: "auto" | "manual";
      loadBalancedEnvironmentId?: EnvironmentId | null;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      explicit?: boolean;
      /** Replace existing options even when the incoming selection has none. */
      replaceOptions?: boolean;
    },
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => boolean;
  addImages: (
    threadRef: ComposerThreadTarget,
    images: ComposerImageAttachment[],
    options?: { allowDuplicates?: boolean },
  ) => string[];
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  /** Returns the ids of files appended; a re-pick that replaces a marker is not listed. */
  addFiles: (
    threadRef: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { allowDuplicates?: boolean; appendReference?: boolean },
  ) => string[];
  removeFile: (threadRef: ComposerThreadTarget, fileId: string) => void;
  setFileUpload: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => void;
  markFileUploadMissing: (
    threadRef: ComposerThreadTarget,
    fileId: string,
    environmentId: EnvironmentId,
    attachmentId: string,
  ) => boolean;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContexts: (
    threadRef: ComposerThreadTarget,
    contexts: TerminalContextDraft[],
    options?: ComposerContextAddOptions,
  ) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
    options?: ComposerContextAddOptions,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  addReviewComment: (
    threadRef: ComposerThreadTarget,
    comment: ReviewCommentContext,
    options?: ComposerContextAddOptions,
  ) => void;
  setContextInsertionHandler: (
    threadRef: ComposerThreadTarget,
    handler: ComposerContextInsertionHandler | null,
  ) => (() => void) | undefined;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  addThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setThreadContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<ThreadContextRecord>,
  ) => void;
  /** Mentions machines as context; already-mentioned machines are skipped. */
  addEnvironmentContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<EnvironmentContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setEnvironmentContexts: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<EnvironmentContextRecord>,
  ) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<void>;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /** Clears text and attachments, preserving terminal/element contexts, preview annotations, and review comments. */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  /** Keeps attachments over destination limits, other environments' uploads, terminal/element contexts, annotations, and review comments in source. */
  moveComposerPromptAndImages: (from: ComposerThreadTarget, to: ComposerThreadTarget) => void;
}

/** Store mutator/reader shapes shared by the action slices. */
export type ComposerDraftStoreSet = {
  (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false | undefined,
  ): void;
  (
    state: ComposerDraftStoreState | ((state: ComposerDraftStoreState) => ComposerDraftStoreState),
    replace: true,
  ): void;
};
export type ComposerDraftStoreGet = () => ComposerDraftStoreState;
